// Nearby on the phone: one connection manager for clan-link/1 over every path this phone has — the current Wi-Fi or a
// hotspot (NSD/Bonjour), Apple peer-to-peer Wi-Fi (iPhone ↔ iPhone), Wi-Fi Direct and Wi-Fi Aware (Android) — plus the
// person's choice of availability:
//   off      nothing listens or advertises; the person can still connect on purpose (scan a code)
//   app      listen, advertise and look around only while CLAN is open (default)
//   session  as `app`, and while a chat/call/transfer is active keep it alive in the background where the OS allows
//            (Android: a foreground service with a notification; iOS: only the short time iOS grants)
// Adverts carry a random id and the presence tag. Matching a friend → connect as ourselves; anything else is looked at
// under a throwaway identity (only people visible to Everyone Nearby answer, and they learn nothing about us).
import { AppState, PermissionsAndroid, Platform } from 'react-native';
import { getRandomBytes } from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { b64u, type ProfileView } from '@classroom/protocol';
import { ConnectionManager, probeAnonymously, type LinkFiles, type LinkState } from '@clan/core';
import { PeerLink, capabilities, listen, nativeLinkTransport, stopListening, type PeerCapabilities, type RadioEvent } from '../../modules/peer-link';
import { phoneClan } from '../core/clan';
import { bump } from '../ui/kit';

export type NearbyMode = 'off' | 'app' | 'session';
export type NearbyEntry = { id: string; key: string | null; name: string; profile: ProfileView | null; friend: boolean; via: 'wifi' | 'apple' | 'direct' | 'aware'; address: string | null; device?: string; seenAt: number };

const people = () => phoneClan().people;
const settingsFile = () => { const d = new Directory(Paths.document, 'people'); if (!d.exists) d.create({ intermediates: true, idempotent: true }); return new File(d, 'nearby.json'); };
function loadSettings(): { mode: NearbyMode; port: number } {
  try { const f = settingsFile(); if (f.exists) { const v = JSON.parse(f.textSync()) as { mode?: string; port?: number }; return { mode: v.mode === 'off' || v.mode === 'session' ? v.mode : 'app', port: Number(v.port) || 0 }; } } catch { /* defaults */ }
  return { mode: 'app', port: 0 };
}
const saveSettings = (s: { mode: NearbyMode; port: number }) => { try { settingsFile().write(JSON.stringify(s)); } catch { /* not fatal */ } };

const incoming = () => { const d = new Directory(Paths.document, 'people', 'incoming'); if (!d.exists) d.create({ intermediates: true, idempotent: true }); return d; };
export const linkFiles: LinkFiles = {
  async read(path, offset, length) { const h = new File(path).open(FileMode.ReadOnly); try { h.offset = offset; return h.readBytes(length); } finally { h.close(); } },
  async append(path, bytes) { const f = new File(path); if (!f.exists) f.create(); const h = f.open(FileMode.ReadWrite); try { h.offset = h.size ?? f.size ?? 0; h.writeBytes(bytes); } finally { h.close(); } },
  size: async (path) => { const f = new File(path); return f.exists ? f.size ?? 0 : 0; },
  remove: async (path) => { const f = new File(path); if (f.exists) f.delete(); },
  partPath: (id) => new File(incoming(), `${id}.link.part`).uri,
};

class Nearby {
  settings = loadSettings();
  caps: PeerCapabilities | null = capabilities();
  cm: ConnectionManager | null = null;
  port = 0;
  entries = new Map<string, NearbyEntry>();
  status = '';
  hotspot: { ssid: string; passphrase: string } | null = null;
  private r = '';
  private rAt = 0;
  private running = false;
  private probed = new Map<string, number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private dialedDevice = '';
  private live: ((e: import('@classroom/protocol').PeerEnvelope) => void) | null = null;

  get mode() { return this.settings.mode; }
  myAddrs() {
    if (!this.port || !PeerLink) return [];
    try { return PeerLink.addresses().filter((a) => /^[0-9.]{7,15}$/.test(a)).map((a) => `tcp:${a}:${this.port}`).slice(0, 3); } catch { return []; }
  }
  onLive(cb: (e: import('@classroom/protocol').PeerEnvelope) => void) { this.live = cb; }

  /** The connection manager exists whenever CLAN is open (even with Nearby off, for codes the person scans). */
  manager(signer: { publicKey: string; sign(b: Uint8Array): string }) {
    if (!this.cm) {
      this.cm = new ConnectionManager({ people: people(), signer, files: linkFiles, onLive: (e) => this.live?.(e), onChange: () => bump(), myAddrs: () => this.myAddrs() }).use(nativeLinkTransport);
      this.cm.onState(() => { this.keepAlive(); bump(); });
      PeerLink?.addListener('radio', (e) => this.radio(e));
      PeerLink?.addListener('availability', (e) => { if (!e.running && e.byUser) { this.setMode('app'); } });
      AppState.addEventListener('change', (st) => { if (st === 'active') void this.start(); else this.background(); });
    }
    return this.cm;
  }
  setMode(m: NearbyMode) { this.settings = { ...this.settings, mode: m }; saveSettings(this.settings); if (m === 'off') this.stop(); else void this.start(); bump(); }
  state(key: string): LinkState | null { return this.cm?.status(key)?.state ?? null; }
  /** Talk to someone found nearby as ourselves (needed to send a request or chat). */
  async connectAs(entry: NearbyEntry) {
    if (!this.cm || !entry.key || !entry.address || !nativeLinkTransport.handles(entry.address)) throw new Error('Connect to this person first.');
    await this.cm.connect(entry.address, { expectKey: entry.key });
  }

  /** Ask for what discovery needs; the OS shows its own prompt. */
  async permissions() {
    if (Platform.OS !== 'android') return true;
    const sdk = typeof Platform.Version === 'number' ? Platform.Version : 0;
    const want = sdk >= 33 ? [PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES, PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS] : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const r = await PermissionsAndroid.requestMultiple(want.filter(Boolean) as never);
    return Object.values(r).every((v) => v === 'granted' || v === 'never_ask_again') && Object.values(r).some((v) => v === 'granted');
  }

  async start() {
    if (!PeerLink || !this.cm || this.settings.mode === 'off' || AppState.currentState !== 'active' && !this.sessionActive()) return;
    if (!this.running) {
      try {
        this.port = await listen(this.settings.port, (l) => void this.cm!.accept(l));
        if (this.port !== this.settings.port) { this.settings = { ...this.settings, port: this.port }; saveSettings(this.settings); }
      } catch {
        this.port = await listen(0, (l) => void this.cm!.accept(l)).catch(() => 0);
      }
      if (!this.port) { this.status = 'Nearby could not start on this phone.'; bump(); return; }
      this.running = true;
      try { PeerLink.browse(); } catch { /* reported by radio events */ }
      this.timers.push(setInterval(() => this.advertise(), 60_000));
      this.timers.push(setInterval(() => { for (const [id, e] of this.entries) if (Date.now() - e.seenAt > 10 * 60_000) this.entries.delete(id); bump(); }, 60_000));
    }
    this.advertise(true);
  }
  /** Rotated hourly and whenever visibility changes; nothing while Invisible. */
  advertise(force = false) {
    if (!PeerLink || !this.running) return;
    const vis = people().visibility();
    if (vis === 'invisible') { PeerLink.stopAdvertise(); this.r = ''; return; }
    if (!force && this.r && Date.now() - this.rAt < 3_600_000) return;
    this.r = b64u.encode(getRandomBytes(12)); this.rAt = Date.now();
    try { PeerLink.advertise(this.r, people().presenceTagFor(this.r), this.port); } catch { /* reported */ }
  }
  private sessionActive() { return !!this.cm && people().contacts('all').some((c) => this.cm!.connected(c.key)); }
  /** Android: keep a visible foreground service only while a nearby session is open (mode `session`). */
  private keepAlive() {
    if (!PeerLink) return;
    const want = this.settings.mode === 'session' && this.sessionActive();
    try { if (want && !PeerLink.availabilityRunning()) PeerLink.availabilityStart('A nearby chat, call or transfer is open.'); else if (!want && PeerLink.availabilityRunning()) PeerLink.availabilityStop(); } catch { /* not fatal */ }
  }
  private background() {
    if (this.settings.mode === 'session' && this.sessionActive()) { this.keepAlive(); return; } // stays (Android FGS / iOS short task)
    this.stop(false);
  }
  stop(closeSessions = true) {
    if (!PeerLink) return;
    this.running = false;
    for (const t of this.timers) clearInterval(t); this.timers = [];
    try { PeerLink.stopAdvertise(); PeerLink.stopBrowse(); PeerLink.p2pStop(); PeerLink.awareStop(); stopListening(); PeerLink.availabilityStop(); } catch { /* not fatal */ }
    if (closeSessions) for (const c of people().contacts('all')) this.cm?.session(c.key)?.link.close('Nearby turned off');
    this.entries.clear(); bump();
  }

  private upsert(e: NearbyEntry) { this.entries.set(e.id, e); bump(); }
  private radio(e: RadioEvent) {
    if (e.type === 'error') { this.status = e.message; bump(); return; }
    if (e.type === 'lost') { for (const [id, x] of this.entries) if (x.address === `svc:${e.name}` || id.endsWith(`:${e.name}`)) this.entries.delete(id); bump(); return; }
    if (e.type === 'connected' && e.via === 'p2p') {
      // Wi-Fi Direct group formed: the client dials the group owner; the owner waits for it
      if (!e.owner && e.host) for (const x of this.entries.values()) if (x.via === 'direct' && x.address?.startsWith('p2p:') && x.device === this.dialedDevice) void this.look(`tcp:${e.host}:${x.address.split(':')[1]}`, x);
      this.status = 'Connected directly (Wi-Fi Direct).'; bump(); return;
    }
    if (e.type !== 'found') return;
    if (this.r && e.r === this.r) return;
    const last = this.probed.get(e.r) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.probed.set(e.r, Date.now());
    const friend = e.t ? people().matchPresence(e.r, e.t) : null;
    const base = { id: `${e.via}:${e.r}`, key: friend, name: friend ? people().contact(friend)?.name ?? 'Friend' : 'Someone nearby', profile: friend ? people().contact(friend)?.profile ?? null : null, friend: !!friend, seenAt: Date.now() };
    if (e.via === 'nsd') void this.look(`tcp:${e.host}:${e.port}`, { ...base, via: 'wifi', address: `tcp:${e.host}:${e.port}` });
    else if (e.via === 'bonjour') void this.look(`svc:${e.service}`, { ...base, via: 'apple', address: `svc:${e.service}` });
    else if (e.via === 'p2p') this.upsert({ ...base, via: 'direct', address: `p2p:${e.port}:${e.device}`, device: e.device }); // forming a group needs the person's tap
    else if (e.via === 'aware') { if (friend) void this.connectAware(e.peer, base); else this.upsert({ ...base, via: 'aware', address: `aware-peer:${e.peer}` }); }
  }
  /** Friend → connect as ourselves (expecting their key); anyone else → a throwaway-identity look at their public profile. */
  private async look(address: string, entry: Omit<NearbyEntry, 'address'> & { address: string | null }) {
    const cm = this.cm; if (!cm) return;
    try {
      if (entry.key) { await cm.connect(address, { expectKey: entry.key }); this.upsert({ ...entry, address, profile: people().contact(entry.key)?.profile ?? entry.profile }); return; }
      const { key, profile } = await probeAnonymously(await nativeLinkTransport.dial(address));
      const c = people().meet({ profile });
      if (people().isBlocked(c.key)) return;
      if (address.startsWith('tcp:')) { try { people().setLinkAddrs(c.key, [address]); } catch { /* unusual address */ } }
      this.upsert({ ...entry, key, name: c.name, profile: c.profile, address });
    } catch { /* not visible to us: never shown */ }
  }

  // ---- explicit router-free actions (each one is the person's choice) ----
  async startDirect() {
    if (!PeerLink || !this.caps?.wifiDirect) throw new Error('Wi-Fi Direct is not available on this phone.');
    if (!await this.permissions()) throw new Error('Allow “Nearby devices” for CLAN to use Wi-Fi Direct.');
    await this.start();
    await PeerLink.p2pStart(this.r || b64u.encode(getRandomBytes(12)), this.r ? people().presenceTagFor(this.r) : '', this.port);
    this.status = 'Looking for people using Wi-Fi Direct…'; bump();
  }
  async connectDirect(entry: NearbyEntry) {
    if (!PeerLink || !entry.device) return;
    this.status = 'Asking to connect directly — the other phone must accept…'; bump();
    this.dialedDevice = entry.device;
    await PeerLink.p2pConnect(entry.device);
  }
  async startAware() {
    if (!PeerLink || !this.caps?.wifiAware) throw new Error('Wi-Fi Aware is not available on this phone.');
    if (!await this.permissions()) throw new Error('Allow “Nearby devices” for CLAN to use Wi-Fi Aware.');
    await this.start();
    await PeerLink.awareStart(this.r || b64u.encode(getRandomBytes(12)), this.r ? people().presenceTagFor(this.r) : '', this.port);
    this.status = 'Looking for people using Wi-Fi Aware…'; bump();
  }
  async connectAware(peer: string, entry: Omit<NearbyEntry, 'address' | 'via'>) {
    if (!PeerLink) return;
    const done = new Promise<{ host: string; port: number; net: string }>((res, rej) => {
      const sub = PeerLink!.addListener('radio', (e) => { if (e.type === 'connected' && e.via === 'aware' && e.peer === peer) { sub.remove(); res(e); } });
      setTimeout(() => { sub.remove(); rej(new Error('Wi-Fi Aware connection timed out.')); }, 35_000);
    });
    await PeerLink.awareConnect(peer);
    const c = await done;
    await this.look(`aware:${c.net}:[${c.host}]:${c.port}`, { ...entry, via: 'aware', address: null });
  }
  async startHotspot() {
    if (!PeerLink || !this.caps?.localHotspot) throw new Error(Platform.OS === 'ios' ? 'iPhone cannot create a hotspot from an app. Use Settings › Personal Hotspot, or join another phone’s hotspot.' : 'This phone cannot create a local hotspot.');
    if (!await this.permissions()) throw new Error('Allow “Nearby devices” (or location) for CLAN to start a hotspot.');
    this.hotspot = await PeerLink.hotspotStart();
    await this.start();
    bump();
    return this.hotspot;
  }
  stopHotspot() { PeerLink?.hotspotStop(); this.hotspot = null; bump(); }
  /** Join a hotspot from its Wi-Fi QR code (`WIFI:T:WPA;S:…;P:…;;`). */
  async joinHotspot(ssid: string, passphrase: string) {
    if (!PeerLink?.joinWifi) throw new Error('Join the network in Settings, then come back.');
    await PeerLink.joinWifi(ssid, passphrase);
    await this.start();
    this.advertise(true);
  }
}

export const nearby = new Nearby();

export { wifiQr, parseWifiQr } from '@classroom/protocol';

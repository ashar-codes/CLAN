// Personal device sync on the phone: the SAME PersonalSync engine as the desktop (@clan/core, running on the phone),
// carried over the native pinned transport. The phone is a sync client: it links to one of your computers (first-contact
// TLS + the code proofs), then pulls and pushes against your linked computers, pinned to each one's registered
// certificate, every request signed with this phone's own sync key (kept in the Keychain / Android Keystore).
import { AppState, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import Zeroconf from 'react-native-zeroconf';
import { b64u, normalizeLinkCode, type SyncBatch, type SyncRecord, type SyncTransport } from '@classroom/protocol';
import { seedSigner } from '@classroom/client';
import { joinWithCode } from '@classroom/client/link';
import { createHash, createHmac } from '../node/crypto';
import { firstContactPost, pinnedNativeTransport } from '../../modules/pinned-transport';
import { phoneClan } from '../core/clan';
import { bump } from '../ui/kit';

const SYNC_SEED = 'clan.sync.ed25519.v1';
const SECURE = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
/** The phone never accepts sync connections, so its registry entry carries no certificate. */
const NO_TLS = { tlsCa: 'none', tlsSpki: 'none' };

let signer: { publicKey: string; sign(b: Uint8Array): string } | null = null;
async function syncSigner() {
  if (signer) return signer;
  let seed = await SecureStore.getItemAsync(SYNC_SEED, SECURE);
  if (!seed) { seed = b64u.encode(getRandomBytes(32)); await SecureStore.setItemAsync(SYNC_SEED, seed, SECURE); }
  return (signer = seedSigner(b64u.decode(seed)));
}

/** After this phone was unlinked: forget the old account and key, so it can be linked again as a new device. */
export async function startOverPhoneSync(deviceName: string) {
  phoneClan().sync.reset();
  await SecureStore.deleteItemAsync(SYNC_SEED, SECURE);
  signer = null;
  return setupPhoneSync(deviceName);
}

/** Registers this phone's sync identity with the engine (idempotent; call at start). */
export async function setupPhoneSync(deviceName: string) {
  const s = await syncSigner();
  return phoneClan().sync.setup({ publicKey: s.publicKey, name: deviceName.slice(0, 80) || 'Phone', platform: Platform.OS, ...NO_TLS }, s);
}

// ---- discovery: the computers' `_clansync._tcp` adverts (account tag rotates hourly; link tag while a code is open) ----
const linkTag = (code: string) => createHash('sha256').update(`clan-sync-link-tag/v1|${code}`).digest('hex').slice(0, 8);
const hourTag = (secret: string, h: number) => createHmac('sha256', secret).update(`clan-sync-discovery/v1|${h}`).digest('hex').slice(0, 16);
type Seen = { ep: string; tag: string; linkTag: string | null; at: number };
const seen = new Map<string, Seen>();
let zc: Zeroconf | null = null;
export function browseComputers() {
  if (zc) return;
  zc = new Zeroconf();
  zc.on('resolved', (s: { addresses?: string[]; port: number; txt?: Record<string, string> }) => {
    const addr = s.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (!addr || s.txt?.v !== '1' || !s.txt.a) return;
    const ep = `${addr}:${s.port}`;
    seen.set(ep, { ep, tag: s.txt.a, linkTag: s.txt.l ?? null, at: Date.now() });
  });
  zc.on('error', () => {});
  zc.scan('clansync', 'tcp', 'local.');
}
export function stopBrowsing() { zc?.stop(); zc?.removeDeviceListeners(); zc = null; }
const accountEndpoints = () => {
  const acc = phoneClan().sync.account(); if (!acc) return [];
  const h = Math.floor(Date.now() / 3_600_000), tags = new Set([hourTag(acc.discoverySecret, h), hourTag(acc.discoverySecret, h - 1)]);
  return [...seen.values()].filter((x) => tags.has(x.tag) && Date.now() - x.at < 10 * 60_000).map((x) => x.ep);
};

// ---- linking (this phone joins your account from a computer that shows a code) ----
export async function linkWithCode(rawCode: string, address: string, signal?: AbortSignal) {
  const code = normalizeLinkCode(rawCode);
  if (!code) throw new Error('That code doesn’t look right — it looks like CLAN-XXXX-XXXX-XXXX.');
  let ep = address.trim() || null;
  if (ep && !/^\d+\.\d+\.\d+\.\d+:\d{2,5}$/.test(ep)) throw new Error('Type the address exactly as your computer shows it (like 192.168.1.20:52341).');
  browseComputers();
  for (let i = 0; !ep && i < 40; i++) { ep = [...seen.values()].find((x) => x.linkTag === linkTag(code))?.ep ?? null; if (!ep) await new Promise((r) => setTimeout(r, 250)); }
  if (!ep) throw new Error('Couldn’t find your computer on this Wi-Fi. Type the address it shows.');
  const sync = phoneClan().sync, self = sync.self(), s = await syncSigner();
  const fc = firstContactPost(`https://${ep}`);
  try {
    const { grant } = await joinWithCode({ post: fc.post, code, signal, random: getRandomBytes, sign: (b) => s.sign(b),
      device: { fp: self.fp, publicKey: self.publicKey, name: self.name, platform: self.platform, tlsCa: self.tlsCa, tlsSpki: self.tlsSpki, endpoints: [] } });
    sync.adopt(grant);
  } finally { fc.release(); }
  void syncNow();
}

// ---- transport to one linked computer ----
function transport(d: { fp: string; tlsCa: string; tlsSpki: string }, ep: string): SyncTransport {
  const t = pinnedNativeTransport({ certificate: d.tlsCa, spkiSha256: d.tlsSpki });
  const base = `https://${ep}`, sync = phoneClan().sync;
  const call = async (method: string, path: string, body = '') => {
    const r = await t.fetch(`${base}${path}`, { method, headers: { ...sync.authHeaders(method, path, body), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body || undefined });
    if (!r.ok) { const e = await r.json().catch(() => ({})) as { error?: string; message?: string }; throw Object.assign(new Error(e.message ?? `HTTP ${r.status}`), { code: e.error }); }
    return r.json();
  };
  return {
    peer: d.fp,
    pull: async (since, limit) => (await call('GET', `/sync/changes?since=${since}&limit=${limit}`)) as SyncBatch,
    push: async (records: SyncRecord[]) => (await call('POST', '/sync/changes', JSON.stringify({ records }))) as { accepted: number },
    // The tail of the object (from `offset`) is streamed to a temp file natively, then handed to the engine, which
    // appends it to its .part file and verifies the SHA-256. Bytes received before a drop are still handed over.
    object: async (sha, offset) => {
      const path = `/sync/objects/${sha}`;
      const dir = new Directory(Paths.cache, 'sync-tail'); if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const tmp = new File(dir, `${sha}.${Date.now()}`);
      return (async function* () {
        let failure: unknown = null;
        try { await t.downloadToFile(`${base}${path}`, { ...sync.authHeaders('GET', path, ''), ...(offset ? { range: `bytes=${offset}-` } : {}) }, tmp.uri, 0, () => {}); }
        catch (e) { failure = e; }
        if (tmp.exists) { const h = tmp.open(FileMode.ReadOnly); try { for (;;) { const b = h.readBytes(256 * 1024); if (!b.length) break; yield b; } } finally { h.close(); tmp.delete(); } }
        if (failure) throw failure;
      })();
    },
  };
}

// ---- one round with every linked computer (on demand, when the app comes forward, and every 5 min while open) ----
type Round = Promise<{ ok: number; error: string | null }>;
let running: Round | null = null, again: Round | null = null;
/** A request during a round gets one more round right after it (the running one may predate the change). */
export function syncNow(): Promise<{ ok: number; error: string | null }> {
  if (running) return (again ??= running.then(() => { again = null; return syncNow(); }));
  setTimeout(bump, 0); // show "Syncing…"
  return running = (async () => {
    const sync = phoneClan().sync;
    if (!sync.account() || sync.selfRevoked() || sync.settings().paused) return { ok: 0, error: null };
    let ok = 0, error: string | null = null;
    for (const d of sync.devices().filter((x) => !x.current && !x.revoked && x.tlsSpki !== 'none')) {
      for (const ep of [...new Set([...d.endpoints, ...accountEndpoints()])]) {
        try { await sync.syncWith(transport(d, ep)); sync.setEndpoints(d.fp, [ep, ...d.endpoints.filter((e) => e !== ep)]); ok++; error = null; break; }
        catch (e) { error = (e as Error).message; if ((e as { code?: string }).code === 'revoked') return { ok, error: 'This phone was unlinked.' }; }
      }
    }
    return { ok, error };
  })().finally(() => { running = null; bump(); }); // screens re-read status and synced data
}
export const isSyncing = () => !!running;

/** One signed JSON POST to a linked computer over the native pinned transport, trying its known addresses (hosting). */
export async function callComputer(fp: string, path: string, body: unknown) {
  const sync = phoneClan().sync, d = sync.devices().find((x) => x.fp === fp && !x.current && !x.revoked);
  if (!d || d.tlsSpki === 'none') throw new Error('That device is not one of your linked computers.');
  await syncSigner(); // the engine signs with this phone's keystore-held sync key
  const t = pinnedNativeTransport({ certificate: d.tlsCa, spkiSha256: d.tlsSpki }), raw = JSON.stringify(body);
  let last: Error = new Error('Your computer could not be reached. Open CLAN on it and keep both on the same Wi-Fi.');
  for (const ep of [...new Set([...d.endpoints, ...accountEndpoints()])]) {
    let r: Response;
    try { r = await t.fetch(`https://${ep}${path}`, { method: 'POST', headers: { ...sync.authHeaders('POST', path, raw), 'content-type': 'application/json' }, body: raw }); }
    catch (e) { last = e as Error; continue; }
    const json = await r.json().catch(() => ({})) as { error?: string; message?: string };
    if (!r.ok) throw Object.assign(new Error(json.message ?? `Your computer refused (${r.status}).`), { code: json.error });
    sync.setEndpoints(d.fp, [ep, ...d.endpoints.filter((e) => e !== ep)]);
    return json;
  }
  throw last;
}
export const hostingSigner = syncSigner;

/** Foreground-only schedule: no background polling (battery); discovery stops when the app is in the background. */
export function startSyncSchedule() {
  let t: ReturnType<typeof setInterval> | null = null;
  const fg = () => { browseComputers(); void syncNow(); t ??= setInterval(() => void syncNow(), 5 * 60_000); };
  const bg = () => { if (t) clearInterval(t); t = null; stopBrowsing(); };
  const sub = AppState.addEventListener('change', (s) => (s === 'active' ? fg() : bg()));
  if (AppState.currentState === 'active') fg();
  return () => { bg(); sub.remove(); };
}

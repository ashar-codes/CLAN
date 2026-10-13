// CLAN Direct Network (host side). The host's own Wi-Fi is just another connectivity: this module creates/stops it and
// reports where to bind; pairing, TLS, identity, files and peers are untouched. See docs/WINDOWS_DIRECT_MODE.md.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { BleReassembler, bleFrames, newDirectCredentials, type BleResponse } from '@classroom/protocol';
import { vpnInterfaces } from './netinfo.ts';

export const STRATEGIES = ['wifi-direct-legacy', 'mobile-hotspot'] as const;
export type Strategy = (typeof STRATEGIES)[number];

// ---- helper protocol (validated both ways; the helper never runs anything else) ----
const Avail = z.object({ available: z.boolean(), reason: z.string().max(300).optional() });
export const ProbeResult = z.object({
  osBuild: z.number().int(),
  bluetooth: z.enum(['on', 'off', 'unsupported', 'denied']),
  legacy: Avail,
  hotspot: Avail.extend({ upstream: z.boolean(), bands: z.array(z.enum(['2.4', '5', '6'])).max(3) }),
  wifiAdapter: z.boolean(),
});
export type ProbeResult = z.infer<typeof ProbeResult>;
export const NetStatus = z.object({
  up: z.boolean(), ssid: z.string().max(32).nullable(), clients: z.number().int().min(0), band: z.enum(['2.4', '5', '6']).nullable(),
  hostAddress: z.ipv4().nullable(), interfaceName: z.string().max(256).nullable(),
});
export type NetStatus = z.infer<typeof NetStatus>;
const Ssid = z.string().regex(/^CLAN-[0-9A-Z]{4}$/);
const Pass = z.string().regex(/^[A-Za-z0-9]{16,63}$/);
export const FirewallRule = z.object({
  name: z.string().regex(/^CLAN Direct [0-9a-f-]{36} (bootstrap|https|peer)$/), program: z.string().min(3).max(1024),
  protocol: z.literal('TCP'), localPort: z.number().int().min(1).max(65535), remote: z.literal('LocalSubnet'), interfaceType: z.literal('Wireless'),
});
export type FirewallRule = z.infer<typeof FirewallRule>;
export const HelperRequest = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('probe') }),
  z.object({ cmd: z.literal('start'), strategy: z.enum(STRATEGIES), ssid: Ssid, passphrase: Pass, band: z.enum(['auto', '2.4', '5']) }),
  z.object({ cmd: z.literal('status') }),
  z.object({ cmd: z.literal('stop') }),
  z.object({ cmd: z.literal('firewall.add'), rules: z.array(FirewallRule).max(8) }),
  z.object({ cmd: z.literal('firewall.remove'), prefix: z.literal('CLAN Direct ') }),
  z.object({ cmd: z.literal('wifi.connect'), ssid: Ssid, passphrase: Pass }),
  z.object({ cmd: z.literal('ble.advertise'), tag: z.string().regex(/^[0-9a-f]{8}$/) }),
  z.object({ cmd: z.literal('ble.stop') }),
  z.object({ cmd: z.literal('ble.notify'), conn: z.string().max(64), frame: z.string().max(400) }),
  z.object({ cmd: z.literal('ble.scan'), ms: z.number().int().min(500).max(15_000) }),
  z.object({ cmd: z.literal('ble.connect'), peer: z.string().regex(/^[0-9a-f]{12}$/) }),
  z.object({ cmd: z.literal('ble.write'), conn: z.string().max(64), frame: z.string().max(400) }),
  z.object({ cmd: z.literal('ble.close'), conn: z.string().max(64) }),
]);
export type HelperRequest = z.infer<typeof HelperRequest>;

/** The Windows native helper (CLAN.DirectHelper.exe): JSON lines over stdio, one request → one reply, plus events. */
export class HelperProcess {
  private p: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { res(v: unknown): void; rej(e: Error): void }>();
  private buf = '';
  onEvent: (e: { ev: string; [k: string]: unknown }) => void = () => {};
  constructor(exe: string) {
    this.p = spawn(exe, [], { stdio: 'pipe', windowsHide: true });
    this.p.stdout.setEncoding('utf8').on('data', (d: string) => {
      this.buf += d;
      for (let i; (i = this.buf.indexOf('\n')) >= 0;) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); this.line(line); }
      if (this.buf.length > 1_000_000) this.buf = '';
    });
    this.p.on('exit', () => { for (const w of this.pending.values()) w.rej(new Error('Direct helper stopped.')); this.pending.clear(); });
  }
  private line(line: string) {
    let m: { id?: string; ok?: boolean; result?: unknown; error?: string; ev?: string };
    try { m = JSON.parse(line); } catch { return; }
    if (m.ev) return this.onEvent(m as { ev: string });
    const w = m.id ? this.pending.get(m.id) : undefined;
    if (!w) return;
    this.pending.delete(m.id!);
    if (m.ok) w.res(m.result); else w.rej(new Error(String(m.error ?? 'Direct helper error').slice(0, 300)));
  }
  call<T>(req: HelperRequest, schema: z.ZodType<T>, timeoutMs = 30_000): Promise<T> {
    const id = randomUUID();
    const body = JSON.stringify({ id, ...HelperRequest.parse(req) });
    return new Promise<T>((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`Direct helper timed out (${req.cmd}).`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(t); try { res(schema.parse(v)); } catch (e) { rej(e as Error); } }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.p.stdin.write(body + '\n');
    });
  }
  kill() { this.p.kill(); }
}

// ---- BLE radio abstraction (host) ----
export interface BleHostRadio {
  advertise(tag: string, onFrame: (conn: string, frame: Uint8Array) => void): Promise<void>;
  notify(conn: string, frame: Uint8Array): Promise<void>;
  stop(): Promise<void>;
}

/** Bridges GATT frames to the session's transport-neutral pairing; one reassembler per BLE connection. */
export function bridgeBle(radio: BleHostRadio, tag: string, bootstrap: (source: string, req: unknown) => BleResponse) {
  const conns = new Map<string, BleReassembler>();
  return radio.advertise(tag, (conn, frame) => {
    const re = conns.get(conn) ?? new BleReassembler();
    conns.set(conn, re);
    if (conns.size > 64) conns.delete(conns.keys().next().value!);
    const msg = re.push(frame) as { id?: number } | undefined;
    if (!msg || typeof msg.id !== 'number') return;
    const reply = { id: msg.id, ...bootstrap(conn, msg) };
    for (const fr of bleFrames(msg.id, reply)) void radio.notify(conn, fr).catch(() => {});
  });
}

// ---- backends ----
export interface DirectBackend {
  readonly kind: 'windows' | 'mock';
  probe(): Promise<ProbeResult>;
  start(o: { strategy: Strategy; ssid: string; passphrase: string; band: 'auto' | '2.4' | '5' }): Promise<NetStatus>;
  status(): Promise<NetStatus>;
  stop(): Promise<void>;
  firewall(rules: FirewallRule[]): Promise<void>;
  removeFirewall(): Promise<void>;
  ble(): BleHostRadio | null;
}

export class WindowsBackend implements DirectBackend {
  readonly kind = 'windows';
  private h: HelperProcess;
  private bleHandlers = new Map<string, (conn: string, frame: Uint8Array) => void>();
  constructor(exe: string) {
    this.h = new HelperProcess(exe);
    this.h.onEvent = (e) => {
      if (e.ev === 'ble.request' && typeof e.conn === 'string' && typeof e.frame === 'string') for (const f of this.bleHandlers.values()) f(e.conn, Buffer.from(e.frame, 'base64'));
    };
  }
  probe() { return this.h.call({ cmd: 'probe' }, ProbeResult); }
  start(o: { strategy: Strategy; ssid: string; passphrase: string; band: 'auto' | '2.4' | '5' }) { return this.h.call({ cmd: 'start', ...o }, NetStatus, 60_000); }
  status() { return this.h.call({ cmd: 'status' }, NetStatus); }
  async stop() { await this.h.call({ cmd: 'stop' }, z.unknown()); }
  async firewall(rules: FirewallRule[]) { await this.h.call({ cmd: 'firewall.add', rules }, z.unknown()); }
  async removeFirewall() { await this.h.call({ cmd: 'firewall.remove', prefix: 'CLAN Direct ' }, z.unknown()); }
  ble(): BleHostRadio {
    return {
      advertise: async (tag, onFrame) => { this.bleHandlers.set(tag, onFrame); await this.h.call({ cmd: 'ble.advertise', tag }, z.unknown()); },
      notify: async (conn, frame) => { await this.h.call({ cmd: 'ble.notify', conn, frame: Buffer.from(frame).toString('base64') }, z.unknown()); },
      stop: async () => { this.bleHandlers.clear(); await this.h.call({ cmd: 'ble.stop' }, z.unknown()); },
    };
  }
  dispose() { this.h.kill(); }
}

/**
 * Deterministic stand-in for development and CI on any OS. The "network" is loopback, BLE is a local socket per host
 * tag in `radioDir`. Never selectable in a packaged app.
 */
export class MockBackend implements DirectBackend {
  readonly kind = 'mock';
  state: NetStatus = { up: false, ssid: null, clients: 0, band: null, hostAddress: null, interfaceName: null };
  rules: FirewallRule[] = [];
  probeResult: ProbeResult = { osBuild: 26100, bluetooth: 'on', wifiAdapter: true, legacy: { available: true }, hotspot: { available: true, upstream: false, bands: ['2.4', '5'] } };
  failStart = false;
  private radioDir: string;
  constructor(radioDir: string) { this.radioDir = radioDir; }
  async probe() { return this.probeResult; }
  async start(o: { strategy: Strategy; ssid: string; band: 'auto' | '2.4' | '5' }) {
    if (this.failStart) throw new Error('Adapter refused to start the network.');
    this.state = { up: true, ssid: o.ssid, clients: 0, band: o.band === '2.4' ? '2.4' : '5', hostAddress: '127.0.0.1', interfaceName: `mock-${o.strategy}` };
    return this.state;
  }
  async status() { return this.state; }
  async stop() { this.state = { up: false, ssid: null, clients: 0, band: null, hostAddress: null, interfaceName: null }; }
  async firewall(rules: FirewallRule[]) { this.rules.push(...rules.map((r) => FirewallRule.parse(r))); }
  async removeFirewall() { this.rules = []; }
  ble(): BleHostRadio { return new MockBleHost(this.radioDir); }
}

const frameOut = (s: Socket, f: Uint8Array) => { const len = Buffer.alloc(2); len.writeUInt16BE(f.length); s.write(Buffer.concat([len, Buffer.from(f)])); };
const frameIn = (s: Socket, cb: (f: Uint8Array) => void) => {
  let buf = Buffer.alloc(0);
  s.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) { const n = buf.readUInt16BE(0); cb(new Uint8Array(buf.subarray(2, 2 + n))); buf = buf.subarray(2 + n); } });
};

/** Mock radio uses Unix sockets or Windows named pipes; files advertise only disposable tags. */
const mockRadioPath = (dir: string, tag: string) => process.platform === 'win32'
  ? '\\\\?\\pipe\\clan-qa-' + createHash('sha256').update(join(dir, tag)).digest('hex')
  : join(dir, `${tag}.sock`);
export class MockBleHost implements BleHostRadio {
  private srv: Server | null = null; private socks = new Map<string, Socket>(); private dir: string; private path = ''; private marker = '';
  constructor(dir: string) { this.dir = dir; }
  async advertise(tag: string, onFrame: (conn: string, frame: Uint8Array) => void) {
    mkdirSync(this.dir, { recursive: true });
    this.path = mockRadioPath(this.dir, tag);
    this.marker = join(this.dir, `${tag}.sock`);
    if (process.platform !== 'win32') rmSync(this.path, { force: true });
    this.srv = createServer((s) => { const conn = randomUUID(); this.socks.set(conn, s); frameIn(s, (f) => onFrame(conn, f)); s.on('close', () => this.socks.delete(conn)).on('error', () => {}); });
    await new Promise<void>((r, reject) => { this.srv!.once('error', reject); this.srv!.listen(this.path, r); });
    if (process.platform === 'win32') writeFileSync(this.marker, '');
  }
  async notify(conn: string, frame: Uint8Array) { const s = this.socks.get(conn); if (s) frameOut(s, frame); }
  async stop() { for (const s of this.socks.values()) s.destroy(); await new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r())); if (this.marker) rmSync(this.marker, { force: true }); }
}
/** Member side of the mock radio (same shapes as a real BLE central). */
export const mockBleScan = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^[0-9a-f]{8}\.sock$/.test(f)).map((f) => f.slice(0, 8)) : []);
export function mockBleConnect(dir: string, tag: string) {
  const s = connect(mockRadioPath(dir, tag));
  const subs = new Set<(f: Uint8Array) => void>();
  frameIn(s, (f) => subs.forEach((cb) => cb(f)));
  s.on('error', () => {});
  return { write: async (f: Uint8Array) => { frameOut(s, f); }, onFrame: (cb: (f: Uint8Array) => void) => { subs.add(cb); return () => subs.delete(cb); }, close: () => s.destroy() };
}

// ---- selection ----
export type DirectAvailability = { available: boolean; reason: string | null; strategy: Strategy | null; bluetooth: ProbeResult['bluetooth'] | 'unknown'; backend: DirectBackend['kind'] | null };

/** Which backend this machine may use. Production never falls back to the mock, whatever the environment says. */
export function createDirectBackend(o: { platform: NodeJS.Platform; packaged: boolean; env: Record<string, string | undefined>; helperPath: string; radioDir: string; exists?: (p: string) => boolean }):
  { backend: DirectBackend | null; reason: string | null } {
  if (o.env.CLAN_DIRECT_BACKEND === 'mock') {
    if (o.packaged) return { backend: null, reason: 'The development Direct backend is disabled in released builds.' };
    return { backend: new MockBackend(o.radioDir), reason: null };
  }
  if (o.platform !== 'win32') return { backend: null, reason: o.platform === 'darwin' ? 'macOS has no supported API for an app to create a Wi-Fi network. Host on Windows, or use an existing network.' : 'Hosting a Direct network needs Windows.' };
  if (!(o.exists ?? existsSync)(o.helperPath)) return { backend: null, reason: 'The Windows network helper is missing from this installation.' };
  return { backend: new WindowsBackend(o.helperPath), reason: null };
}

/**
 * Strategy: Wi-Fi Direct legacy AP works with zero upstream, so it is preferred; Mobile Hotspot is used only when legacy
 * is unavailable AND the PC has an upstream connection (the hotspot API needs one; it would also share that internet).
 */
export function chooseStrategy(p: ProbeResult): { strategy: Strategy | null; reason: string | null } {
  if (!p.wifiAdapter) return { strategy: null, reason: 'This computer has no Wi-Fi adapter.' };
  if (p.legacy.available) return { strategy: 'wifi-direct-legacy', reason: null };
  if (p.hotspot.available && p.hotspot.upstream) return { strategy: 'mobile-hotspot', reason: null };
  return { strategy: null, reason: p.legacy.reason ?? p.hotspot.reason ?? 'The Wi-Fi adapter or driver cannot host a network.' };
}

export async function directAvailability(backend: DirectBackend | null, reason: string | null): Promise<DirectAvailability> {
  if (!backend) return { available: false, reason, strategy: null, bluetooth: 'unknown', backend: null };
  try {
    const p = await backend.probe();
    const c = chooseStrategy(p);
    return { available: !!c.strategy, reason: c.reason, strategy: c.strategy, bluetooth: p.bluetooth, backend: backend.kind };
  } catch (e) { return { available: false, reason: `Could not check Wi-Fi hardware: ${(e as Error).message}`, strategy: null, bluetooth: 'unknown', backend: backend.kind }; }
}

/** Minimal inbound rules: this program, these ports, local subnet only, wireless interfaces only. Never allow-all. */
export const firewallRules = (sessionId: string, program: string, ports: { bootstrap: number; https: number; peer?: number }): FirewallRule[] =>
  (Object.entries(ports) as [keyof typeof ports, number | undefined][]).filter(([, p]) => !!p)
    .map(([k, localPort]) => FirewallRule.parse({ name: `CLAN Direct ${sessionId} ${k}`, program, protocol: 'TCP', localPort, remote: 'LocalSubnet', interfaceType: 'Wireless' }));

// ---- lifecycle ----
type StateFile = { v: 1; pid: number; sessionId: string; strategy: Strategy; ssid: string; startedAt: number };
export type DirectSession = { ssid: string; passphrase: string; strategy: Strategy; hostAddress: string; band: NetStatus['band']; bleTag: string; vpn: string[] };

/** Owns one Direct network at a time. Writes a small state file so a crash is cleaned up on the next launch. */
export class DirectNetwork {
  private backend: DirectBackend; private stateFile: string; private now: () => number;
  private session: DirectSession | null = null;
  private radio: BleHostRadio | null = null;
  constructor(backend: DirectBackend, stateFile: string, now = () => Date.now()) { this.backend = backend; this.stateFile = stateFile; this.now = now; }
  get active() { return this.session; }

  /** Call at app start: a state file left behind means the last run crashed with the network up. */
  async recoverStale(): Promise<boolean> {
    if (!existsSync(this.stateFile)) return false;
    try { JSON.parse(readFileSync(this.stateFile, 'utf8')) as StateFile; } catch { /* corrupt: clean anyway */ }
    await this.backend.stop().catch(() => {});
    await this.backend.removeFirewall().catch(() => {});
    rmSync(this.stateFile, { force: true });
    return true;
  }

  async start(o: { sessionId: string; band?: 'auto' | '2.4' | '5' }): Promise<DirectSession> {
    if (this.session) throw new Error('A Direct network is already running.');
    await this.recoverStale();
    const avail = await directAvailability(this.backend, null);
    if (!avail.strategy) throw new Error(avail.reason ?? 'Direct Network is unavailable on this device.');
    const creds = newDirectCredentials();
    const st = await this.backend.start({ strategy: avail.strategy, ...creds, band: o.band ?? 'auto' });
    if (!st.up || !st.hostAddress) { await this.backend.stop().catch(() => {}); throw new Error('The Wi-Fi adapter did not bring the network up.'); }
    const state: StateFile = { v: 1, pid: process.pid, sessionId: o.sessionId, strategy: avail.strategy, ssid: creds.ssid, startedAt: this.now() };
    writeFileSync(this.stateFile, JSON.stringify(state), { mode: 0o600 }); // no passphrase on disk
    this.session = { ...creds, strategy: avail.strategy, hostAddress: st.hostAddress, band: st.band, bleTag: randomUUID().replace(/-/g, '').slice(0, 8), vpn: vpnInterfaces() };
    return this.session;
  }

  /** After the CLAN server is listening on the Direct address: open exactly its ports and start the BLE bootstrap. */
  async publish(o: { sessionId: string; program: string; ports: { bootstrap: number; https: number; peer?: number }; bootstrap: (source: string, req: unknown) => BleResponse }) {
    if (!this.session) throw new Error('No Direct network.');
    // Per-session rules need administrator rights; without them the installer's program-scoped LocalSubnet rule applies.
    const firewall = await this.backend.firewall(firewallRules(o.sessionId, o.program, o.ports)).then(() => 'session-rules' as const, () => 'installer-rule' as const);
    this.radio = this.backend.ble();
    if (this.radio) await bridgeBle(this.radio, this.session.bleTag, o.bootstrap).catch(() => { this.radio = null; }); // QR fallback still works
    return { ble: !!this.radio, firewall };
  }

  async status() { return this.backend.status(); }

  /** After sleep/resume or an adapter reset: bring the same network (same SSID/passphrase) back so members rejoin by themselves. */
  async restart(): Promise<boolean> {
    if (!this.session) return false;
    const st = await this.backend.status().catch(() => null);
    if (st?.up) return true;
    const s = await this.backend.start({ strategy: this.session.strategy, ssid: this.session.ssid, passphrase: this.session.passphrase, band: 'auto' });
    if (s.hostAddress && s.hostAddress !== this.session.hostAddress) throw new Error('The Direct network came back with a different address; start the session again.');
    return s.up;
  }

  /** Stop BLE, the AP (its credentials die with it), and our firewall rules; forget the passphrase. */
  async stop() {
    await this.radio?.stop().catch(() => {});
    this.radio = null;
    await this.backend.stop().catch(() => {});
    await this.backend.removeFirewall().catch(() => {});
    rmSync(this.stateFile, { force: true });
    this.session = null;
  }
}

// CLAN Direct Network on the deterministic mock backend: the real server, real OPAQUE, real BLE framing (over a local
// socket "radio"), the real sealed package and the real client state machine. Real Windows radios: docs/WINDOWS_DIRECT_MODE.md.
import { afterEach, describe, expect, it } from 'vitest';
import * as opaque from '@serenity-kit/opaque';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bleCarrier, pairAndJoin, pair, type BleLink } from '@classroom/client';
import { pinnedTransport } from '@classroom/client/node';
import {
  b64u, BleReassembler, bleFrames, decodeDirectQr, derivePairingKeys, encodeDirectQr, newDirectCredentials, openDirect, sealDirect, type DirectPackage,
} from '@classroom/protocol';
import {
  bridgeBle, chooseStrategy, vpnInterfaces, createDirectBackend, DirectNetwork, firewallRules, HelperRequest, MockBackend, mockBleConnect, mockBleScan,
  startClassroomServer, type RunningServer,
} from '../src/index.ts';
import { device, names, tmp, trustServer } from './helpers.ts';

const servers: RunningServer[] = [];
const nets: DirectNetwork[] = [];
afterEach(async () => { await Promise.all(nets.splice(0).map((n) => n.stop())); await Promise.all(servers.splice(0).map((s) => s.close())); });

/** A host running a Direct CLAN on the mock backend: network up → server bound to it → firewall + BLE published. */
async function directHost(o: { code?: string; radio?: string } = {}) {
  const radio = o.radio ?? tmp('radio-');
  const backend = new MockBackend(radio);
  const net = new DirectNetwork(backend, join(tmp('state-'), 'direct.json')); nets.push(net);
  const sessionId = randomUUID();
  const d = await net.start({ sessionId });
  const s = await startClassroomServer({ title: 'Library session', host: d.hostAddress, code: o.code, clan: { type: 'STUDY_GROUP', id: randomUUID() }, hostName: 'Ayesha',
    direct: { ssid: d.ssid, passphrase: d.passphrase, auth: 'WPA2', host: d.hostAddress, expiresAt: Date.now() + 3600_000 } });
  servers.push(s); trustServer(s);
  await net.publish({ sessionId: s.classroom.id, program: 'C:\\Program Files\\CLAN\\CLAN.exe', ports: { bootstrap: s.port, https: Number(new URL(s.url).port) }, bootstrap: s.bootstrap });
  return { s, net, d, backend, radio };
}
const join6 = async (carriers: ReturnType<typeof bleCarrier>[], code: string, associate?: (p: DirectPackage) => Promise<void>) => {
  await opaque.ready;
  return pairAndJoin({ candidates: [], carriers, code, profile: names(1), device: device(), opaque: opaque.client, transportFor: pinnedTransport, associate });
};
/** A BLE link that records every frame both ways (an eavesdropper / relay in the middle). */
const recording = (link: BleLink, seen: Uint8Array[]): BleLink => ({
  write: async (f) => { seen.push(f); await link.write(f); },
  onFrame: (cb) => link.onFrame((f) => { seen.push(f); cb(f); }),
  close: () => link.close(),
});

describe('Direct bootstrap over BLE', () => {
  it('six-digit code → BLE OPAQUE → sealed Wi-Fi package → associate → pinned HTTPS join; host name only after pairing', async () => {
    const { s, d, radio } = await directHost();
    s.classroom.setPolicy('open');
    expect(mockBleScan(radio)).toEqual([d.bleTag]);
    const order: string[] = [];
    const seen: Uint8Array[] = [];
    const j = await join6([bleCarrier(recording(mockBleConnect(radio, d.bleTag), seen))], s.classroom.code, async (pkg) => {
      order.push('associate');
      expect(pkg).toMatchObject({ ssid: d.ssid, passphrase: d.passphrase, host: d.hostAddress, sessionId: s.classroom.id });
    });
    expect(order).toEqual(['associate']);
    expect(j.status).toBe('approved');
    expect(j.classroom.hostName).toBe('Ayesha');
    expect(j.classroom.connectivity).toBe('direct');
    // the radio never carried the code, the Wi-Fi passphrase or the host's name in clear
    const wire = Buffer.concat(seen.map((f) => Buffer.from(f))).toString('latin1');
    for (const secret of [s.classroom.code, d.passphrase, 'Ayesha']) expect(wire).not.toContain(secret);
  });

  it('wrong code over BLE: no package, counted as a guess like any other pairing attempt', async () => {
    const { s, d, radio } = await directHost({ code: '111111' });
    let associated = false;
    await expect(join6([bleCarrier(mockBleConnect(radio, d.bleTag))], '222222', async () => { associated = true; })).rejects.toThrow(/No CLAN matches/);
    expect(associated).toBe(false);
    for (let i = 0; i < 4; i++) await join6([bleCarrier(mockBleConnect(radio, d.bleTag))], '222222').catch(() => {});
    // per-BLE-connection sources rotate, so the CLAN-wide limit is what bounds guessing over the air
    expect(s.classroom.globalThrottle.lockedFor('*')).toBe(0); // 5 < 50 failures/min
  });

  it('rotating BLE connections cannot escape the CLAN-wide guess limit; throttling is counted and shown once', async () => {
    const { s } = await directHost({ code: '111111' });
    await opaque.ready;
    for (let i = 0; i < 50; i++) { // each attempt from a brand-new BLE connection id
      const st = opaque.client.startLogin({ password: '222222' });
      const r = s.bootstrap(`conn-${i}`, { t: 'start', sessionId: s.classroom.id, startLoginRequest: st.startLoginRequest }) as { ok: boolean; body: { pairingId: string } };
      expect(r.ok).toBe(true);
      s.bootstrap(`conn-${i}`, { t: 'abort', pairingId: r.body.pairingId });
    }
    const fresh = opaque.client.startLogin({ password: '111111' }); // even the right code, from a new connection
    expect(s.bootstrap('conn-new', { t: 'start', sessionId: s.classroom.id, startLoginRequest: fresh.startLoginRequest })).toMatchObject({ ok: false, code: 'throttled' });
    await expect(pair({ bootstrapUrl: s.bootstrapUrl, sessionId: s.classroom.id, code: '111111', opaque: opaque.client, transportFor: pinnedTransport })).rejects.toThrow(/Too many attempts/);
    expect(s.pairingStats()).toMatchObject({ failed: 50, throttled: { bluetooth: 1, network: 1 } });
    expect(s.classroom.timeline().filter((e) => e.type === 'pairing.throttled')).toHaveLength(1);
  });

  it('a fake BLE host (other code) cannot complete OPAQUE; with both nearby the real one is chosen', async () => {
    const radio = tmp('radio-');
    const real = await directHost({ code: '123456', radio });
    const fake = await directHost({ code: '654321', radio });
    real.s.classroom.setPolicy('open');
    await expect(join6([bleCarrier(mockBleConnect(radio, fake.d.bleTag))], '123456', async () => {})).rejects.toThrow(/No CLAN matches/);
    let got: DirectPackage | null = null;
    const j = await join6(mockBleScan(radio).map((t) => bleCarrier(mockBleConnect(radio, t))), '123456', async (p) => { got = p; });
    expect(j.classroom.sessionId).toBe(real.s.classroom.id);
    expect(got!.ssid).toBe(real.d.ssid);
  });

  it('replayed finish, tampered or re-targeted packages are rejected', async () => {
    const { s, d } = await directHost();
    await opaque.ready;
    const start = opaque.client.startLogin({ password: s.classroom.code });
    const r1 = s.bootstrap('relay', { t: 'start', sessionId: s.classroom.id, startLoginRequest: start.startLoginRequest });
    const pairingId = (r1 as { body: { pairingId: string; loginResponse: string } }).body.pairingId;
    const fin = opaque.client.finishLogin({ clientLoginState: start.clientLoginState, loginResponse: (r1 as { body: { loginResponse: string } }).body.loginResponse, password: s.classroom.code, identifiers: { client: `classroom-lan/v1/student/${s.classroom.id}`, server: `classroom-lan/v1/classroom/${s.classroom.id}` } })!;
    const ok = s.bootstrap('relay', { t: 'finish', pairingId, finishLoginRequest: fin.finishLoginRequest }) as { ok: true; body: { direct: { nonce: string; ciphertext: string } } };
    expect(ok.ok).toBe(true);
    expect(s.bootstrap('relay', { t: 'finish', pairingId, finishLoginRequest: fin.finishLoginRequest })).toMatchObject({ ok: false, code: 'bad_code' }); // single use
    const key = derivePairingKeys(fin.sessionKey).direct;
    expect(openDirect(key, ok.body.direct, { sessionId: s.classroom.id, pairingId }).passphrase).toBe(d.passphrase);
    const ct = b64u.decode(ok.body.direct.ciphertext); ct[5]! ^= 1;
    expect(() => openDirect(key, { ...ok.body.direct, ciphertext: b64u.encode(ct) }, { sessionId: s.classroom.id, pairingId })).toThrow();
    expect(() => openDirect(key, ok.body.direct, { sessionId: s.classroom.id, pairingId: randomUUID() })).toThrow(); // bound to this pairing
    expect(() => openDirect(new Uint8Array(32), ok.body.direct, { sessionId: s.classroom.id, pairingId })).toThrow(); // wrong key
  });

  it('expired packages are refused even if authentic', () => {
    const key = new Uint8Array(32).fill(7), sid = randomUUID(), pid = randomUUID();
    const pkg: DirectPackage = { v: 1, sessionId: sid, ...newDirectCredentials(), auth: 'WPA2', host: '192.168.137.1', bootstrapPort: 5000, expiresAt: 1000 };
    expect(() => openDirect(key, sealDirect(key, pkg, pid), { sessionId: sid, pairingId: pid, now: 1001 })).toThrow(/expired/);
  });

  it('knowing the Wi-Fi password is not membership: wrong code still fails and the API needs a token', async () => {
    const { s } = await directHost({ code: '123456' });
    await opaque.ready;
    await expect(pair({ bootstrapUrl: s.bootstrapUrl, sessionId: s.classroom.id, code: '000000', opaque: opaque.client, transportFor: pinnedTransport })).rejects.toThrow(/No CLAN matches/);
    const r = await pinnedTransport(s.tls).fetch(`${s.url}/api/resources`);
    expect(r.status).toBe(401);
  });

  it('without an associator (platform cannot join Wi-Fi) the member gets the manual fallback, only after OPAQUE', async () => {
    const { s, d, radio } = await directHost();
    const err = await join6([bleCarrier(mockBleConnect(radio, d.bleTag))], s.classroom.code).catch((e) => e);
    expect(err.code).toBe('direct_manual');
    expect(err.direct).toMatchObject({ ssid: d.ssid, passphrase: d.passphrase });
  });

  it('BLE reassembly is bounded and ignores garbage', () => {
    const re = new BleReassembler();
    expect(re.push(new Uint8Array([1]))).toBeUndefined();
    expect(re.push(Uint8Array.of(1, 5, 3, 0x7b))).toBeUndefined(); // index ≥ count
    expect(() => bleFrames(1, { x: 'a'.repeat(20_000) })).toThrow(/too large/);
    const frames = bleFrames(9, { hello: 'world'.repeat(100) });
    let out: unknown;
    for (const f of frames.reverse()) out = re.push(f) ?? out; // order-independent
    expect(out).toEqual({ hello: 'world'.repeat(100) });
  });
});

describe('QR fallback', () => {
  it('carries the network only (no join code), validates, and expires', () => {
    const pkg: DirectPackage = { v: 1, sessionId: randomUUID(), ...newDirectCredentials(), auth: 'WPA2', host: '192.168.137.1', bootstrapPort: 50123, expiresAt: Date.now() + 60_000 };
    const qr = encodeDirectQr(pkg);
    expect(qr.startsWith('clan://direct#')).toBe(true);
    expect(qr.length).toBeLessThan(400);
    expect(decodeDirectQr(qr)).toEqual(pkg);
    expect(() => decodeDirectQr(qr, pkg.expiresAt + 1)).toThrow(/expired/);
    expect(() => decodeDirectQr('clan://direct#' + b64u.encode(new TextEncoder().encode(JSON.stringify({ ...pkg, host: '8.8.8.8:1' }))))).toThrow();
    expect(() => decodeDirectQr('https://evil.example/' + qr)).toThrow();
  });
});

describe('credentials', () => {
  it('fresh per session, unbiased alphabet, ~139-bit passphrase, SSID reveals nothing', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newDirectCredentials();
      expect(c.ssid).toMatch(/^CLAN-[0-9A-HJ-NP-Z]{4}$/);
      expect(c.passphrase).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{24}$/);
      expect(seen.has(c.passphrase)).toBe(false);
      seen.add(c.passphrase);
    }
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) for (const ch of newDirectCredentials().passphrase) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const mean = (4000 * 24) / 56;
    for (const n of counts.values()) expect(Math.abs(n - mean) / mean).toBeLessThan(0.15);
  });
});

describe('backend selection and lifecycle', () => {
  const base = { packaged: false, env: {}, helperPath: 'C:/CLAN/CLAN.DirectHelper.exe', radioDir: tmpdir() };
  it('unsupported OS / missing helper / production never uses the mock', () => {
    expect(createDirectBackend({ ...base, platform: 'darwin' }).reason).toMatch(/macOS/);
    expect(createDirectBackend({ ...base, platform: 'linux' }).backend).toBeNull();
    expect(createDirectBackend({ ...base, platform: 'win32', exists: () => false }).reason).toMatch(/helper is missing/);
    expect(createDirectBackend({ ...base, platform: 'darwin', env: { CLAN_DIRECT_BACKEND: 'mock' } }).backend?.kind).toBe('mock');
    const prod = createDirectBackend({ ...base, platform: 'win32', packaged: true, env: { CLAN_DIRECT_BACKEND: 'mock' } });
    expect(prod.backend).toBeNull();
    expect(prod.reason).toMatch(/disabled in released builds/);
  });

  it('strategy: Wi-Fi Direct legacy first (works with zero upstream); hotspot only with an upstream', () => {
    const p = new MockBackend('').probeResult;
    expect(chooseStrategy(p).strategy).toBe('wifi-direct-legacy');
    expect(chooseStrategy({ ...p, legacy: { available: false } }).strategy).toBeNull(); // hotspot without upstream: no
    expect(chooseStrategy({ ...p, legacy: { available: false }, hotspot: { ...p.hotspot, upstream: true } }).strategy).toBe('mobile-hotspot');
    expect(chooseStrategy({ ...p, wifiAdapter: false }).reason).toMatch(/no Wi-Fi adapter/);
  });

  it('start → firewall rules scoped to program/ports/local subnet/wireless → stop removes everything', async () => {
    const { s, net, backend } = await directHost();
    expect(backend.rules.map((r) => r.name)).toEqual([`CLAN Direct ${s.classroom.id} bootstrap`, `CLAN Direct ${s.classroom.id} https`]);
    for (const r of backend.rules) expect(r).toMatchObject({ remote: 'LocalSubnet', interfaceType: 'Wireless', protocol: 'TCP' });
    expect(() => firewallRules('x', 'p', { bootstrap: 1, https: 2 })).toThrow(); // only well-formed, CLAN-named rules
    await net.stop();
    expect(backend.rules).toEqual([]);
    expect(backend.state.up).toBe(false);
  });

  it('a crash leaves a state file (without the passphrase); next launch cleans the network and rules', async () => {
    const backend = new MockBackend(tmp('radio-'));
    const file = join(tmp('state-'), 'direct.json');
    const a = new DirectNetwork(backend, file);
    const d = await a.start({ sessionId: randomUUID() });
    await backend.firewall(firewallRules(randomUUID(), 'clan.exe', { bootstrap: 1, https: 2 }));
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(file, 'utf8')).not.toContain(d.passphrase);
    // "crash": a new process instance finds the file
    const b = new DirectNetwork(backend, file);
    expect(await b.recoverStale()).toBe(true);
    expect(backend.state.up).toBe(false);
    expect(backend.rules).toEqual([]);
    expect(await b.recoverStale()).toBe(false);
    writeFileSync(file, '{not json');
    expect(await b.recoverStale()).toBe(true); // corrupt state is cleaned too
  });

  it('adapter failure is reported; nothing is left running', async () => {
    const backend = new MockBackend(tmp('radio-'));
    backend.failStart = true;
    const n = new DirectNetwork(backend, join(tmp('state-'), 'direct.json'));
    await expect(n.start({ sessionId: randomUUID() })).rejects.toThrow(/refused/);
    expect(n.active).toBeNull();
  });

  it('VPN warning: VPN-style interfaces and overlay (CGNAT) addresses are reported; normal Wi-Fi is not', () => {
    const a = (address: string) => [{ address, family: 'IPv4' as const, internal: false, netmask: '255.255.255.0', mac: '', cidr: null }];
    expect(vpnInterfaces({ en0: a('192.168.1.5'), utun4: a('10.8.0.2'), 'Ethernet 3': a('100.101.4.7'), 'ProtonVPN': a('10.2.0.2') } as never).sort())
      .toEqual(['Ethernet 3', 'ProtonVPN', 'utun4']);
    expect(vpnInterfaces({ en0: a('192.168.1.5'), 'Wi-Fi': a('10.0.0.4') } as never)).toEqual([]);
  });

  it('helper IPC accepts only the narrow, validated command set', () => {
    expect(HelperRequest.safeParse({ cmd: 'start', strategy: 'wifi-direct-legacy', ssid: 'CLAN-AB12', passphrase: 'abcdefghijkmnpqr', band: 'auto' }).success).toBe(true);
    for (const bad of [
      { cmd: 'exec', command: 'netsh wlan set hostednetwork' },
      { cmd: 'start', strategy: 'hosted-network', ssid: 'CLAN-AB12', passphrase: 'abcdefghijkmnpqr', band: 'auto' },
      { cmd: 'start', strategy: 'wifi-direct-legacy', ssid: 'Ali Khan CS402', passphrase: 'abcdefghijkmnpqr', band: 'auto' },
      { cmd: 'wifi.connect', ssid: 'CLAN-AB12', passphrase: 'short"; rm -rf' },
      { cmd: 'firewall.add', rules: [{ name: 'Allow all', program: '*', protocol: 'TCP', localPort: 1, remote: 'Any', interfaceType: 'All' }] },
      { cmd: 'firewall.remove', prefix: '' },
    ]) expect(HelperRequest.safeParse(bad).success).toBe(false);
  });
});

describe('peer topology on a Direct network', () => {
  it('isolation turns peer assistance off and keeps it off; one reachable peer proves availability', async () => {
    const { s } = await directHost();
    s.classroom.setPeerAssist(true);
    s.classroom.setP2p(false);
    expect(s.classroom.info()).toMatchObject({ p2p: 'isolated', peerAssist: false });
    expect(() => s.classroom.setPeerAssist(true)).toThrow(/keeps members apart/);
    const t = await directHost();
    t.s.classroom.setP2p(true);
    t.s.classroom.setPeerAssist(true);
    expect(t.s.classroom.info()).toMatchObject({ p2p: 'available', peerAssist: true });
  });
});

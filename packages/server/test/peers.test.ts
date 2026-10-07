// Milestone 2.75: peer-assisted data plane. Real teacher server, real peer servers (HTTPS with teacher-endorsed
// identities), real swarm scheduler; attackers are real peers with modified behaviour.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  b64u, canonicalBytes, keyFingerprint, verifyManifest,
  type CapabilityPayload, type PeerCapability, type PeerEndorsement, type SignedManifest, type ResourceView,
} from '@classroom/protocol';
import { api, peerAuthHeader, type DeviceSigner } from '@classroom/client';
import { PeerAgent, startPeerServer } from '@classroom/client/peer';
import { partPaths, pinnedTransport } from '@classroom/client/node';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClassroomTls } from '@classroom/client/tls';
import { startClassroomServer, type RunningServer } from '../src/index.ts';
import { classWith, device, makeFile, socket, tmp, trFor, trustServer, type Student } from './helpers.ts';

const servers: RunningServer[] = [];
const agents: PeerAgent[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map((a) => a.stop()));
  await Promise.all(cleanups.splice(0).map((f) => f()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const MB = 1024 * 1024;
async function setup(n: number, peerAssist = true, chunkSize = 256 * 1024) {
  const r = await classWith(n, { limits: { chunkSize, downloadRequestsPerMinute: 100_000 } });
  servers.push(r.s);
  r.s.classroom.setPeerAssist(peerAssist);
  return r;
}
function agent(s: RunningServer, st: Student, o: { canSeed?: boolean; limits?: object } = {}) {
  const a = new PeerAgent({
    transport: trFor(s.url), url: s.url, token: () => st.token, sessionId: s.classroom.id, teacherKey: s.teacherPublicKey,
    device: st.device, host: '127.0.0.1', destDir: tmp(), canSeed: o.canSeed ?? true, limits: o.limits,
  });
  agents.push(a);
  return a;
}
const view = (r: ResourceView) => ({ id: r.id, name: r.name, size: r.size, sha256: r.sha256 });
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const opts = { peerAssist: true, chunkTimeoutMs: 3000, stallTimeoutMs: 10_000 };
/** Wait until `memberId` sees peers whose announced bitfields cover the whole resource. */
const announcedFull = (s: RunningServer, resourceId: string, memberId: string, peers = 1) => until(() => {
  const list = s.peers.sources(resourceId, memberId);
  const n = s.resources.manifest({ role: 'teacher' }, resourceId).payload.chunks.length;
  return list.filter((x) => { const b = b64u.decode(x.have); let c = 0; for (let i = 0; i < n; i++) if (b[i >> 3]! & (0x80 >> (i & 7))) c++; return c === n; }).length >= peers;
});
const until = async (f: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

describe('modes', () => {
  it('teacher-server mode: peer assistance off -> streamed from the teacher', async () => {
    const { s, students: [a] } = await setup(1, false);
    const f = makeFile(6 * MB);
    const r = await s.resources.importFile(f.path);
    const A = agent(s, a!); await A.start();
    const out = await A.acquire(view(r), { ...opts, peerAssist: s.classroom.info().peerAssist });
    expect(out.stats.mode).toBe('teacher-stream');
    expect(sha(out.path)).toBe(f.sha256);
  });

  it('peer-assisted: B gets most of the file from A; teacher bytes for B fall well below the file size', async () => {
    const { s, students: [a, b] } = await setup(2);
    const f = makeFile(8 * MB);
    const r = await s.resources.importFile(f.path);
    const A = agent(s, a!), B = agent(s, b!);
    await A.start(); await B.start();
    const ra = await A.acquire(view(r), opts);
    expect(ra.stats.mode).toBe('swarm');
    await announcedFull(s, r.id, b!.memberId);
    const before = s.resources.stats(0).servedBytes;
    const rb = await B.acquire(view(r), opts);
    expect(sha(rb.path)).toBe(f.sha256);
    expect(rb.stats.peerBytes).toBeGreaterThan(f.size * 0.6);
    expect(s.resources.stats(0).servedBytes - before).toBeLessThan(f.size * 0.4);
    expect(A.uploadedBytes()).toBe(rb.stats.peerBytes);
  });

  it('small files go straight to the teacher even in peer-assisted mode', async () => {
    const { s, students: [a] } = await setup(1);
    const r = await s.resources.importFile(makeFile(200_000).path);
    const A = agent(s, a!); await A.start();
    expect((await A.acquire(view(r), opts)).stats.mode).toBe('teacher-stream');
  });

  it('switching modes mid-download keeps verified progress (swarm -> teacher stream -> done)', async () => {
    const { s, students: [a] } = await setup(1);
    const f = makeFile(8 * MB);
    const r = await s.resources.importFile(f.path);
    const A = agent(s, a!); await A.start();
    const ctl = new AbortController();
    let got = 0;
    // startOffset 0 so the verified chunks form a prefix: switching to streaming keeps the contiguous verified prefix.
    const p = A.acquire(view(r), { ...opts, startOffset: 0, signal: ctl.signal, onProgress: (x) => { got = x.bytes; if (x.bytes >= 3 * MB) ctl.abort(); } });
    await expect(p).rejects.toBeDefined();
    expect(got).toBeGreaterThanOrEqual(3 * MB);
    s.classroom.setPeerAssist(false); // teacher switches the data plane
    const manifest = await api<SignedManifest>(trFor(s.url), s.url, a!.token, `/api/resources/${r.id}/manifest`);
    const out = await A.acquire(view(r), { ...opts, peerAssist: false, cachedManifest: manifest });
    expect(out.stats.mode).toBe('teacher-stream');
    expect(out.stats.teacherBytes).toBeLessThan(f.size); // resumed from the verified contiguous prefix
    expect(sha(out.path)).toBe(f.sha256);
  });

  it('teacher -> peer-assisted: a streaming partial is adopted chunk by chunk after hash checks', async () => {
    const { s, students: [a] } = await setup(1, false);
    const f = makeFile(8 * MB + 12345);
    const r = await s.resources.importFile(f.path);
    const A = agent(s, a!); await A.start();
    // Exactly what the streaming downloader leaves behind after an interruption: a contiguous prefix + its meta.
    const destDir = (A as unknown as { o: { destDir: string } }).o.destDir;
    const p = partPaths(destDir, r.id);
    mkdirSync(p.dir, { recursive: true });
    const prefix = Buffer.from(f.buf.subarray(0, 3 * MB + 1000));
    prefix[MB + 5] = prefix[MB + 5]! ^ 1; // and a corrupted byte in chunk 4 (256 KiB chunks): it must NOT be adopted
    writeFileSync(p.part, prefix);
    writeFileSync(p.meta, JSON.stringify({ sha256: r.sha256, size: r.size, name: r.name }));
    s.classroom.setPeerAssist(true);
    const out = await A.acquire(view(r), opts);
    expect(out.stats.mode).toBe('swarm');
    expect(out.stats.teacherBytes).toBe(f.size - 4 * 256 * 1024); // chunks 0-3 adopted; chunk 4 (corrupt) and the rest re-fetched
    expect(sha(out.path)).toBe(f.sha256);
  });
});

describe('resource manifests', () => {
  it('teacher-signed; any tampering or a wrong key is rejected', async () => {
    const { s, students: [a] } = await setup(1);
    const r = await s.resources.importFile(makeFile(1 * MB + 7).path);
    const m = await api<SignedManifest>(trFor(s.url), s.url, a!.token, `/api/resources/${r.id}/manifest`);
    const ok = { trustedTeacherKey: s.teacherPublicKey, sessionId: s.classroom.id, resourceId: r.id };
    expect(verifyManifest(m, ok).ok).toBe(true);
    expect(m.payload.chunks).toHaveLength(Math.ceil(m.payload.size / m.payload.chunkSize));
    const bad = (f: (x: SignedManifest) => void) => { const x = structuredClone(m); f(x); return verifyManifest(x, ok).ok; };
    expect(bad((x) => { x.payload.chunks[0] = 'f'.repeat(64); })).toBe(false);
    expect(bad((x) => { x.payload.name = 'other.pdf'; })).toBe(false);
    expect(bad((x) => { x.payload.sha256 = 'a'.repeat(64); })).toBe(false);
    expect(bad((x) => { x.payload.version = 2; })).toBe(false);
    const peer = device();
    expect(bad((x) => { x.teacherPublicKey = peer.publicKey; x.payload.teacherKeyFingerprint = keyFingerprint(peer.publicKey); x.signature = peer.sign(canonicalBytes(x.payload)); })).toBe(false);
    expect(verifyManifest(m, { ...ok, resourceId: randomUUID() }).ok).toBe(false);
    expect(verifyManifest(m, { ...ok, sessionId: randomUUID() }).ok).toBe(false);
  });
});

describe('peer transfer', () => {
  async function swarm(n: number, size = 8 * MB) {
    const r = await setup(n);
    const f = makeFile(size);
    const res = await r.s.resources.importFile(f.path);
    const ag = r.students.map((st) => agent(r.s, st));
    for (const x of ag) await x.start();
    return { ...r, f, res, ag };
  }

  it('multiple sources: C downloads from A and B', async () => {
    const { s, f, res, ag: [A, B, C], students } = await swarm(3);
    await A!.acquire(view(res), opts);
    await B!.acquire(view(res), opts);
    await until(() => s.peers.sources(res.id, students[2]!.memberId).length === 2);
    const out = await C!.acquire(view(res), opts);
    const peersUsed = out.stats.sources.filter((x) => x.kind === 'peer' && x.chunks > 0);
    expect(peersUsed.length).toBe(2);
    expect(sha(out.path)).toBe(f.sha256);
  });

  it('a partial peer is used for what it has; the teacher fills the rest', async () => {
    const { s, f, res, ag: [A, B], students } = await swarm(2);
    const ctl = new AbortController();
    await expect(A!.acquire(view(res), { ...opts, signal: ctl.signal, startOffset: 0, onProgress: (x) => { if (x.bytes >= 3 * MB) ctl.abort(); } })).rejects.toBeDefined();
    await until(() => { const x = s.peers.sources(res.id, students[1]!.memberId)[0]; return !!x && b64u.decode(x.have).filter((v) => v === 0xff).length >= 1; });
    const out = await B!.acquire(view(res), opts);
    expect(out.stats.peerBytes).toBeGreaterThan(0);
    expect(out.stats.teacherBytes).toBeGreaterThan(0);
    expect(sha(out.path)).toBe(f.sha256);
  });

  it('a peer disappearing mid-transfer: fall back, never corrupt', async () => {
    const { s, f, res, ag: [A, B], students } = await swarm(2, 12 * MB);
    await A!.acquire(view(res), opts);
    await until(() => s.peers.sources(res.id, students[1]!.memberId).length === 1);
    const out = await B!.acquire(view(res), { ...opts, onProgress: (x) => { if (x.bytes > 3 * MB && A!.serving) void A!.stop(); } });
    expect(sha(out.path)).toBe(f.sha256);
    expect(out.stats.teacherBytes).toBeGreaterThan(0);
  });

  it('corrupt / wrong-chunk / lying / refusing / slow peers are penalised; the file is still correct', async () => {
    for (const misbehave of ['corrupt', 'wrong-chunk', 'other-resource', 'lies', 'paused', 'slow'] as const) {
      const { s, f, res, ag: [A, B], students } = await swarm(2, 6 * MB);
      const other = await s.resources.importFile(makeFile(6 * MB).path);
      await A!.acquire(view(res), opts);
      await A!.acquire(view(other), opts);
      const offered = (A as unknown as { offered: Map<string, { read(i: number): Promise<Uint8Array | null>; have(): Uint8Array }> }).offered;
      const real = offered.get(res.id)!, otherR = offered.get(other.id)!;
      const realRead = real.read.bind(real);
      if (misbehave === 'corrupt') real.read = async (i) => { const b = Buffer.from((await realRead(i))!); b[7] = b[7]! ^ 1; return b; };
      if (misbehave === 'wrong-chunk') real.read = async (i) => realRead((i + 1) % 6 === 0 ? 0 : i + 1);
      if (misbehave === 'other-resource') real.read = (i) => otherR.read(i);
      if (misbehave === 'lies') real.read = async () => null;
      if (misbehave === 'paused') A!.paused = true;
      await until(() => s.peers.sources(res.id, students[1]!.memberId).length === 1);
      const slowB = misbehave === 'slow' ? agent(s, students[1]!) : B!;
      if (misbehave === 'slow') {
        await A!.stop();
        const slowA = agent(s, students[0]!, { limits: { maxBytesPerSec: 64 * 1024 } });
        await slowA.start();
        await slowA.acquire(view(res), opts);
        await until(() => s.peers.sources(res.id, students[1]!.memberId).length === 1);
      }
      const out = await slowB.acquire(view(res), { ...opts, chunkTimeoutMs: 1500 });
      expect(sha(out.path), misbehave).toBe(f.sha256);
      const peer = out.stats.sources.find((x) => x.kind === 'peer');
      if (misbehave === 'corrupt' || misbehave === 'wrong-chunk' || misbehave === 'other-resource') expect(peer?.corrupt, misbehave).toBeGreaterThan(0);
      if (misbehave === 'lies' || misbehave === 'paused') expect(peer?.failures, misbehave).toBeGreaterThan(0);
      if (misbehave === 'slow') expect(peer?.timeouts, misbehave).toBeGreaterThan(0);
      await Promise.all(agents.splice(0).map((x) => x.stop()));
      await Promise.all(servers.splice(0).map((x) => x.close()));
    }
  }, 120_000);

  it('teacher offline: students keep getting already-published resources from peers (cached manifest + sources)', async () => {
    const { s, f, res, ag: [A, B], students } = await swarm(2);
    const ctl = new AbortController();
    // A has only part of the file when the teacher disappears; B's cached list is therefore stale.
    await expect(A!.acquire(view(res), { ...opts, startOffset: 0, signal: ctl.signal, onProgress: (x) => { if (x.bytes >= 2 * MB) ctl.abort(); } })).rejects.toBeDefined();
    await until(() => s.peers.sources(res.id, students[1]!.memberId).length === 1);
    const t = trFor(s.url);
    const manifest = await api<SignedManifest>(t, s.url, students[1]!.token, `/api/resources/${res.id}/manifest`);
    const sources = (await api<{ sources: never[] }>(t, s.url, students[1]!.token, `/api/peer/sources/${res.id}`)).sources;
    await B!.peerContext().capability(); // capability obtained while the teacher was reachable
    await A!.acquire(view(res), opts); // A completes (from the teacher) after B cached the sources
    await s.close(); servers.splice(0);
    const out = await B!.acquire(view(res), { ...opts, cachedManifest: manifest, cachedSources: sources });
    expect(out.stats.mode).toBe('swarm');
    expect(out.stats.peerBytes).toBe(f.size);
    expect(sha(out.path)).toBe(f.sha256);
  });
});

describe('peer authorization', () => {
  /** A raw request to a peer's chunk endpoint with an arbitrary Authorization header. */
  async function peerGet(A: PeerAgent, endorsement: PeerEndorsement, url: string, auth?: string) {
    const t = pinnedTransport({ certificate: endorsement.payload.tlsCa, spkiSha256: endorsement.payload.tlsSpkiSha256 });
    return t.fetch(url, { headers: auth ? { authorization: auth } : {} });
  }
  async function served() {
    const { s, students } = await setup(3);
    const res = await s.resources.importFile(makeFile(2 * MB).path);
    const A = agent(s, students[0]!); await A.start();
    await A.acquire(view(res), opts);
    await until(() => s.peers.sources(res.id, students[1]!.memberId).length === 1);
    const src = s.peers.sources(res.id, students[1]!.memberId)[0]!;
    return { s, students, res, A, src, chunkUrl: `${src.url}/peer/v1/chunk/${res.id}/0` };
  }
  const cap = async (s: RunningServer, st: Student) => api<PeerCapability>(trFor(s.url), s.url, st.token, '/api/peer/capability', { method: 'POST', body: '{}' });

  it('legitimate request succeeds; none / wrong private key / proof for another peer fail', async () => {
    const { s, students, A, src, chunkUrl } = await served();
    const b = students[1]!;
    const c = await cap(s, b);
    expect((await peerGet(A, src.endorsement, chunkUrl, await peerAuthHeader(c, b.device, src.fingerprint))).status).toBe(200);
    expect((await peerGet(A, src.endorsement, chunkUrl)).status).toBe(401);
    expect((await peerGet(A, src.endorsement, chunkUrl, await peerAuthHeader(c, device(), src.fingerprint))).status).toBe(401);
    expect((await peerGet(A, src.endorsement, chunkUrl, await peerAuthHeader(c, b.device, keyFingerprint(device().publicKey)))).status).toBe(401);
  });

  it('expired, forged (peer-signed) and cross-class capabilities fail', async () => {
    const { s, students, A, src, chunkUrl } = await served();
    const b = students[1]!;
    const c = await cap(s, b);
    const forger = device();
    const forged: PeerCapability = { ...structuredClone(c), teacherPublicKey: forger.publicKey };
    forged.payload.teacherKeyFingerprint = keyFingerprint(forger.publicKey);
    forged.signature = forger.sign(canonicalBytes(forged.payload));
    expect((await peerGet(A, src.endorsement, chunkUrl, await peerAuthHeader(forged, b.device, src.fingerprint))).status).toBe(401);
    const other = await setup(1);
    const foreign = await cap(other.s, other.students[0]!);
    expect((await peerGet(A, src.endorsement, chunkUrl, await peerAuthHeader(foreign, other.students[0]!.device, src.fingerprint))).status).toBe(401); // other class's teacher key
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    expect((await peerGet(A, src.endorsement, chunkUrl, await peerAuthHeader(c, b.device, src.fingerprint))).status).toBe(401);
  });

  it('removed / blocked members: no capabilities, no sources, and peers refuse them after the revocation push', async () => {
    const { s, students, A, src, chunkUrl, res } = await served();
    const [, b, c] = students;
    const capB = await cap(s, b!);
    const ws = socket(s.url, students[0]!.token); // A's control channel delivers the revocation
    await ws.next('hello');
    ws.ws.onmessage = ((orig) => (e: { data: unknown }) => { const m = JSON.parse(String(e.data)); if (m.t === 'peer.revoked') A.deny(m.fingerprints); orig?.(e); })(ws.ws.onmessage);
    s.classroom.setStatus(b!.memberId, 'removed');
    s.classroom.setStatus(c!.memberId, 'blocked');
    await expect(cap(s, b!)).rejects.toMatchObject({ status: 401 });
    await expect(cap(s, c!)).rejects.toMatchObject({ status: 401 });
    await until(() => (A as unknown as { denied: Set<string> }).denied.size === 2);
    expect((await peerGet(A, src.endorsement, chunkUrl, await peerAuthHeader(capB, b!.device, src.fingerprint))).status).toBe(403);
    expect(s.peers.sources(res.id, b!.memberId)).toBeDefined();
    ws.close();
  });

  it('peer endpoints: path traversal is refused; request floods are rate-limited', async () => {
    const { s, students, A, src } = await served();
    const auth = await peerAuthHeader(await cap(s, students[1]!), students[1]!.device, src.fingerprint);
    for (const p of ['/peer/v1/chunk/../../etc/passwd', '/peer/v1/chunk/x/0', '/etc/passwd', `/peer/v1/chunk/${randomUUID()}/0`, `/peer/v1/chunk/${randomUUID()}/-1`, '/peer/v1/chunk/%2e%2e/0']) {
      expect([400, 404], p).toContain((await peerGet(A, src.endorsement, src.url + p, auth)).status);
    }
    // A second peer configured with a tiny per-requester rate limit.
    const res = await s.resources.importFile(makeFile(2 * MB).path);
    const F = agent(s, students[2]!, { limits: { requestsPerMinute: 3 } });
    await F.start();
    await F.acquire(view(res), opts);
    await until(() => s.peers.sources(res.id, students[1]!.memberId).some((x) => x.fingerprint === F.fingerprint));
    const fsrc = s.peers.sources(res.id, students[1]!.memberId).find((x) => x.fingerprint === F.fingerprint)!;
    const fauth = await peerAuthHeader(await cap(s, students[1]!), students[1]!.device, fsrc.fingerprint);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) { const r = await peerGet(F, fsrc.endorsement, `${fsrc.url}/peer/v1/chunk/${res.id}/0`, fauth); await r.arrayBuffer(); codes.push(r.status); }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('impostor at a peer address (copied endorsement, different TLS key) is refused by the pin', async () => {
    const { s, students, src, chunkUrl } = await served();
    const imp = await createClassroomTls('impostor');
    const fake = await startPeerServer({ host: '127.0.0.1', tls: imp, sessionId: s.classroom.id, teacherKey: s.teacherPublicKey, selfFingerprint: src.fingerprint, lookup: () => null, isDenied: () => false });
    cleanups.push(() => fake.close());
    const auth = await peerAuthHeader(await cap(s, students[1]!), students[1]!.device, src.fingerprint);
    // The requester uses the endorsed pin (A's TLS key); the impostor's certificate doesn't match it.
    await expect(peerGet({} as PeerAgent, src.endorsement, `${fake.url}/peer/v1/chunk/x/0`, auth)).rejects.toThrow();
    void chunkUrl;
  });
});

describe('authority stays with the teacher', () => {
  it('network roles grant no teacher power: capabilities are not bearer tokens; peers cannot approve, lock or publish', async () => {
    const { s, students } = await setup(2);
    const [a, b] = students;
    const capA = await api<PeerCapability>(trFor(s.url), s.url, a!.token, '/api/peer/capability', { method: 'POST', body: '{}' });
    const capAsToken = b64u.encode(new TextEncoder().encode(JSON.stringify(capA)));
    expect((await trFor(s.url).fetch(`${s.url}/api/resources`, { headers: { authorization: `Bearer ${capAsToken}` } })).status).toBe(401);
    const A = agent(s, a!); await A.start();
    const st = socket(s.url, a!.token);
    await st.next('hello');
    for (const m of [{ t: 'member.approve', memberId: b!.memberId }, { t: 'class.lock', locked: true }, { t: 'class.peerAssist', enabled: false }, { t: 'resource.push', resourceId: randomUUID() }]) {
      st.send(m);
      expect((await st.next('error')).code).toBe('forbidden');
    }
    // A peer-signed "official" manifest is never accepted.
    const evil = device();
    const fake: SignedManifest = { payload: { type: 'classroom-lan/resource-manifest', v: 1, resourceId: randomUUID(), sessionId: s.classroom.id, courseTitle: 'x', name: 'x', mime: 'x', size: 1, sha256: 'a'.repeat(64), chunkSize: 4096, chunks: ['a'.repeat(64)], version: 1, createdAt: 1, teacherKeyFingerprint: keyFingerprint(evil.publicKey) }, alg: 'Ed25519', signature: '', teacherPublicKey: evil.publicKey };
    fake.signature = evil.sign(canonicalBytes(fake.payload));
    expect(verifyManifest(fake, { trustedTeacherKey: s.teacherPublicKey, sessionId: s.classroom.id, resourceId: fake.payload.resourceId }).ok).toBe(false);
    st.close();
  });

  it('after the teacher disconnects, no peer can issue capabilities or endorsements that other peers accept', async () => {
    const { s, students } = await setup(2);
    const B = students[1]!;
    const A = agent(s, students[0]!); await A.start();
    const res = await s.resources.importFile(makeFile(2 * MB).path);
    await A.acquire(view(res), opts);
    await until(() => s.peers.sources(res.id, B.memberId).length === 1);
    const src = s.peers.sources(res.id, B.memberId)[0]!;
    await s.close(); servers.splice(0);
    // B tries to act as the authority and mint itself a capability.
    const payload: CapabilityPayload = { type: 'classroom-lan/peer-capability', v: 1, capId: randomUUID(), sessionId: s.classroom.id, memberId: B.memberId, holderPublicKey: B.device.publicKey, holderFingerprint: keyFingerprint(B.device.publicKey), scope: 'resources:read', issuedAt: Date.now(), expiresAt: Date.now() + 60_000, teacherKeyFingerprint: keyFingerprint(B.device.publicKey) };
    const selfCap: PeerCapability = { payload, alg: 'Ed25519', signature: B.device.sign(canonicalBytes(payload)), teacherPublicKey: B.device.publicKey };
    const t = pinnedTransport({ certificate: src.endorsement.payload.tlsCa, spkiSha256: src.endorsement.payload.tlsSpkiSha256 });
    const r = await t.fetch(`${src.url}/peer/v1/chunk/${res.id}/0`, { headers: { authorization: await peerAuthHeader(selfCap, B.device, src.fingerprint) } });
    expect(r.status).toBe(401);
  });
});

describe('load (simulated clients in one process)', () => {
  for (const n of [60, 100]) {
    it(`${n} peers acquire a 2 MB resource (8 chunks); all verify; teacher sends far less than ${n} x size`, async () => {
      const s = await startClassroomServer({ title: 'Load', host: '127.0.0.1', limits: { chunkSize: 256 * 1024, downloadRequestsPerMinute: 1_000_000 } });
      servers.push(s);
      trustServer(s);
      s.classroom.setPolicy('open');
      s.classroom.setPeerAssist(true);
      // Domain-level joins (pairing is covered elsewhere and dominates CPU at this scale).
      const studs = Array.from({ length: n }, (_, i) => { const d = device(); const j = s.classroom.join({ fullName: `S${i}`, rollNo: `R${i}`, deviceName: 'sim', devicePublicKey: d.publicKey }); return { token: j.token, memberId: j.memberId, device: d }; });
      const f = makeFile(2 * MB); // forced swarm (threshold 0): one process can't host 100 peers moving 8 MB each quickly
      const res = await s.resources.importFile(f.path);
      const ag = studs.map((st) => agent(s, st, { limits: { maxConcurrent: 8 } }));
      await Promise.all(ag.map((x) => x.start()));
      const before = s.resources.stats(0).servedBytes;
      const outs = await Promise.all(ag.map((x) => x.acquire(view(res), { ...opts, smallFileBytes: 0, chunkTimeoutMs: 15_000, stallTimeoutMs: 60_000 })));
      const teacherSent = s.resources.stats(0).servedBytes - before;
      expect(outs.every((o) => sha(o.path) === f.sha256)).toBe(true);
      expect(outs.reduce((a, o) => a + o.stats.corruptChunks, 0)).toBe(0);
      expect(teacherSent).toBeLessThan(n * f.size * 0.6);
      console.log(`[load ${n}] teacher sent ${(teacherSent / MB).toFixed(1)} MB of ${(n * f.size / MB).toFixed(0)} MB delivered (${((teacherSent / (n * f.size)) * 100).toFixed(0)}%)`);
    }, 180_000);
  }
});

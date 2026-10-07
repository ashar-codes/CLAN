// Milestone 2.5 attack scenarios. Each test drives the real client code against a real server, with an attacker
// relay / interceptor in between where relevant.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as opaque from '@serenity-kit/opaque';
import { randomUUID } from 'node:crypto';
import {
  canonicalBytes, b64u, derivePairingKeys, keyFingerprint, verifyBinding, verifyReceipt,
  type JoinProofPayload, type Receipt, type ReceiptPayload,
} from '@classroom/protocol';
import { api, ClassroomConnection, joinPaired, opaqueIdentifiers, pair, reconnect } from '@classroom/client';
import { downloadResource, pinnedTransport, uploadSubmission } from '@classroom/client/node';
import { redact, startClassroomServer, type RunningServer } from '../src/index.ts';
import { BINDING_TTL_MS } from '../src/pairing.ts';
import { bootstrapRelay, classWith, device, makeFile, names, profile, secureJoin, socket, tlsInterceptor, tmp, trFor, trustServer } from './helpers.ts';

const servers: RunningServer[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((f) => f()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function start(code = '482915', title = 'Operating Systems', opts = {}) {
  const s = await startClassroomServer({ title, host: '127.0.0.1', code, ...opts });
  servers.push(s);
  trustServer(s);
  return s;
}
const pairVia = async (bootstrapUrl: string, s: RunningServer, code = s.classroom.code) => {
  await opaque.ready;
  return pair({ bootstrapUrl, sessionId: s.classroom.id, code, opaque: opaque.client, transportFor: pinnedTransport });
};
const members = (s: RunningServer) => s.classroom.roster().length;

describe('active MITM on pairing and transport', () => {
  it('wrong code: OPAQUE fails on the client, nothing is issued, attempt is counted', async () => {
    const s = await start();
    await expect(pairVia(s.bootstrapUrl, s, '111111')).rejects.toMatchObject({ code: 'bad_code' });
    expect(members(s)).toBe(0);
    expect(s.classroom.ipThrottle.lockedFor('127.0.0.1')).toBe(0);
    for (let i = 0; i < 4; i++) await pairVia(s.bootstrapUrl, s, '111111').catch(() => {});
    await expect(pairVia(s.bootstrapUrl, s)).rejects.toMatchObject({ code: 'throttled' });
  });

  it('guessing without finishing: concurrent attempts are capped and unfinished ones count when they expire', async () => {
    const s = await start();
    await opaque.ready;
    const startOnly = async () => {
      const l = opaque.client.startLogin({ password: '000000' });
      return fetch(`${s.bootstrapUrl}/api/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, sessionId: s.classroom.id, startLoginRequest: l.startLoginRequest }) });
    };
    for (let i = 0; i < 4; i++) expect((await startOnly()).status).toBe(200); // attacker tests guesses offline from KE2, never finishes
    expect((await startOnly()).status).toBe(429); // 5th concurrent unfinished attempt refused
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 61_000);
    expect((await startOnly()).status).toBe(200); // the 4 expired attempts were counted as failures (4 < 5)
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 122_000);
    await expect(secureJoin(s)).rejects.toMatchObject({ code: 'throttled' }); // 5th failure counted on expiry -> locked out
  });

  it('discovery points at a fake classroom: it cannot complete pairing without the code', async () => {
    const real = await start('482915');
    const fake = await start('999999', 'Operating Systems'); // attacker's own server, same name
    // Student uses the REAL code but the fake endpoint (spoofed mDNS). The fake doesn't know the code -> fails.
    await opaque.ready;
    await expect(pair({ bootstrapUrl: fake.bootstrapUrl, sessionId: fake.classroom.id, code: real.classroom.code, opaque: opaque.client, transportFor: pinnedTransport })).rejects.toMatchObject({ code: 'bad_code' });
    // Nor by claiming the real session id.
    await expect(pair({ bootstrapUrl: fake.bootstrapUrl, sessionId: real.classroom.id, code: real.classroom.code, opaque: opaque.client, transportFor: pinnedTransport })).rejects.toMatchObject({ code: 'bad_code' });
    expect(members(fake)).toBe(0);
  });

  it('an honest relay changes nothing; the student still ends up pinned to the real server', async () => {
    const s = await start();
    const relay = await bootstrapRelay(s.bootstrapUrl);
    cleanups.push(relay.close);
    const p = await pairVia(relay.url, s);
    expect(p.binding.spkiSha256).toBe(s.tls.spkiSha256);
  });

  for (const [label, tamper] of [
    ['replaced TLS pin + certificate', (b: any, s: RunningServer, fake: { spkiSha256: string; certificate: string }) => { b.binding.spkiSha256 = fake.spkiSha256; b.binding.certificate = fake.certificate; }],
    ['changed class/session id', (b: any) => { b.binding.sessionId = randomUUID(); }],
    ['changed expiry', (b: any) => { b.binding.expiresAt += 60 * 60_000; }],
    ['changed HTTPS port (redirect)', (b: any) => { b.binding.httpsPort = 1; }],
    ['changed teacher key', (b: any) => { b.binding.teacherPublicKey = device().publicKey; }],
    ['flipped MAC byte', (b: any) => { const m = b64u.decode(b.mac); m[0] = m[0]! ^ 1; b.mac = b64u.encode(m); }],
  ] as const) {
    it(`binding tampered in transit (${label}) -> pairing refused`, async () => {
      const s = await start();
      const fake = await tlsInterceptor(s.url);
      cleanups.push(fake.close);
      const relay = await bootstrapRelay(s.bootstrapUrl, (path, body) => { if (path === '/api/pair/finish' && body.binding) tamper(body, s, fake.fake); return body; });
      cleanups.push(relay.close);
      await expect(pairVia(relay.url, s)).rejects.toMatchObject({ code: 'mitm' });
    });
  }

  it('stale binding replay: a binding+MAC from an earlier pairing is rejected', async () => {
    const s = await start();
    let first: any = null;
    const relay = await bootstrapRelay(s.bootstrapUrl, (path, body) => {
      if (path !== '/api/pair/finish') return body;
      if (!first) { first = structuredClone(body); return body; }
      return first; // replay the old, validly-MACed binding
    });
    cleanups.push(relay.close);
    await pairVia(relay.url, s);
    await expect(pairVia(relay.url, s)).rejects.toMatchObject({ code: 'mitm' });
  });

  it('certificate substitution: an interceptor with its own certificate is refused (fetch and WSS)', async () => {
    const s = await start();
    s.classroom.setPolicy('open');
    const p = await pairVia(s.bootstrapUrl, s);
    const mitm = await tlsInterceptor(s.url);
    cleanups.push(mitm.close);
    // Same pinned transport, but traffic is redirected to the interceptor.
    await expect(joinPaired({ ...p, url: mitm.url }, names(), device())).rejects.toThrow();
    expect(mitm.intercepted()).toBeGreaterThan(0);
    expect(members(s)).toBe(0);
    const j = await joinPaired(p, names(), device()); // the genuine channel still works
    const ws = p.transport.openWebSocket(mitm.url.replace('https', 'wss') + '/ws');
    const closed = await new Promise<number>((r) => { ws.onclose = (e) => r(e.code); ws.onerror = () => {}; });
    expect(closed).not.toBe(1000);
    await expect(p.transport.fetch(`${mitm.url}/api/resources`, { headers: { authorization: `Bearer ${j.token}` } })).rejects.toThrow();
  });

  it('pinned transport also rejects a server whose cert is otherwise valid for the host', async () => {
    const a = await start('111111');
    const b = await start('222222');
    const tA = pinnedTransport(a.tls);
    await expect(tA.fetch(`${b.url}/api/resources`)).rejects.toThrow();
  });

  it('OPAQUE message replay: finish requests are single use and bound to their attempt', async () => {
    const s = await start();
    await opaque.ready;
    const l = opaque.client.startLogin({ password: s.classroom.code });
    const post = (path: string, body: unknown) => fetch(`${s.bootstrapUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const st = await (await post('/api/pair/start', { v: 1, sessionId: s.classroom.id, startLoginRequest: l.startLoginRequest })).json();
    const fin = opaque.client.finishLogin({ clientLoginState: l.clientLoginState, loginResponse: st.loginResponse, password: s.classroom.code, identifiers: opaqueIdentifiers(s.classroom.id) })!;
    expect((await post('/api/pair/finish', { v: 1, pairingId: st.pairingId, finishLoginRequest: fin.finishLoginRequest })).status).toBe(200);
    expect((await post('/api/pair/finish', { v: 1, pairingId: st.pairingId, finishLoginRequest: fin.finishLoginRequest })).status).toBe(403);
    // Replaying the old finish against a fresh attempt (attacker re-sent the captured KE1) fails too.
    const st2 = await (await post('/api/pair/start', { v: 1, sessionId: s.classroom.id, startLoginRequest: l.startLoginRequest })).json();
    expect((await post('/api/pair/finish', { v: 1, pairingId: st2.pairingId, finishLoginRequest: fin.finishLoginRequest })).status).toBe(403);
  });

  it('downgrade: no classroom API on plaintext; clients refuse http/ws URLs', async () => {
    const s = await start();
    s.classroom.setPolicy('open');
    const j = await secureJoin(s);
    for (const path of ['/api/resources', '/api/assignments', '/api/uploads', '/api/join', '/api/reconnect', '/ws']) {
      const res = await fetch(`${s.bootstrapUrl}${path}`, { headers: { authorization: `Bearer ${j.token}` } });
      expect(res.status, path).toBe(404);
    }
    const plainWs = new WebSocket(s.bootstrapUrl.replace('http', 'ws') + '/ws');
    expect(await new Promise((r) => { plainWs.onopen = () => r('open'); plainWs.onerror = () => r('error'); })).toBe('error');
    // Plain HTTP to the TLS port gets nowhere either.
    await expect(fetch(s.url.replace('https', 'http') + '/api/resources')).rejects.toThrow();
    const t = trFor(s.url);
    await expect(api(t, s.bootstrapUrl, j.token, '/api/resources')).rejects.toMatchObject({ code: 'insecure_transport' });
    expect(() => new ClassroomConnection(s.bootstrapUrl, j.token)).toThrow(/unencrypted/);
    await expect(downloadResource({ transport: t, url: s.bootstrapUrl, token: j.token, resource: { id: randomUUID(), name: 'x', size: 1, sha256: 'a'.repeat(64) }, destDir: tmp() })).rejects.toMatchObject({ code: 'insecure_transport' });
    await expect(t.fetch(`${s.bootstrapUrl}/api/info`)).rejects.toMatchObject({ code: 'insecure_transport' });
  });

  it('no CORS, web-page origins cannot open sockets, text/plain is not parsed', async () => {
    const s = await start();
    const t = trFor(s.url);
    const res = await t.fetch(`${s.url}/api/resources`, { headers: { origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const WS = (await import('ws')).default;
    const ws = new WS(s.url.replace('https', 'wss') + '/ws', { ca: Buffer.from(s.tls.certificate, 'base64').toString(), checkServerIdentity: () => undefined, origin: 'https://evil.example' } as never);
    expect(await new Promise((r) => { ws.on('open', () => r('open')); ws.on('error', () => r('rejected')); })).toBe('rejected');
    const tp = await t.fetch(`${s.url}/api/join`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(tp.status).toBe(415);
  });
});

describe('device identity', () => {
  /** Pair legitimately (attacker knows the code) and return a join body builder. */
  async function paired(s: RunningServer) {
    const p = await pairVia(s.bootstrapUrl, s);
    return p;
  }
  const proofFor = (p: Awaited<ReturnType<typeof paired>>, pub: string, n = names()) => ({
    type: 'classroom-lan/join-proof', v: 1, sessionId: p.binding.sessionId, pairingId: p.binding.pairingId, challenge: p.binding.challenge,
    deviceKeyFingerprint: keyFingerprint(pub), ...n,
  }) satisfies JoinProofPayload;
  const postJoinBody = (p: Awaited<ReturnType<typeof paired>>, body: unknown) =>
    p.transport.fetch(`${p.url}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('copied public key without the private key fails the proof (even knowing the code)', async () => {
    const s = await start();
    s.classroom.setPolicy('known');
    const victim = device();
    const v = await secureJoin(s, 1, victim);
    s.classroom.setStatus(v.memberId, 'approved');
    const attacker = device();
    const p = await paired(s);
    const payload = proofFor(p, victim.publicKey, names(1));
    const { macOf } = await import('@classroom/protocol');
    const res = await postJoinBody(p, { v: 1, pairingId: p.binding.pairingId, profile: { ...names(1), devicePublicKey: victim.publicKey }, proof: { mac: macOf(p.joinKey, payload), signature: attacker.sign(canonicalBytes(payload)) } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('bad_proof');
    expect(members(s)).toBe(1);
  });

  it('a valid signature without the OPAQUE-derived MAC (eavesdropper replaying the binding) fails', async () => {
    const s = await start();
    const p = await paired(s);
    const d = device();
    const payload = proofFor(p, d.publicKey);
    const res = await postJoinBody(p, { v: 1, pairingId: p.binding.pairingId, profile: { ...names(), devicePublicKey: d.publicKey }, proof: { mac: b64u.encode(new Uint8Array(32)), signature: d.sign(canonicalBytes(payload)) } });
    expect(res.status).toBe(403);
  });

  it('replayed signed join is rejected (challenge is single use)', async () => {
    const s = await start();
    const p = await paired(s);
    const d = device();
    let captured: string | null = null;
    const spy = { ...p, transport: { ...p.transport, fetch: (u: string, i?: RequestInit) => { captured = String(i?.body); return p.transport.fetch(u, i); } } };
    await joinPaired(spy, names(), d);
    const res = await p.transport.fetch(`${p.url}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: captured! });
    expect(res.status).toBe(403);
  });

  it('challenge/proof from class A cannot be used in class B', async () => {
    const A = await start('111111', 'A');
    const B = await start('222222', 'B');
    const pa = await pairVia(A.bootstrapUrl, A);
    const pb = await pairVia(B.bootstrapUrl, B);
    const d = device();
    const { macOf } = await import('@classroom/protocol');
    const payloadA = proofFor(pa, d.publicKey);
    // Attacker holds B's join key (paired with B) but tries to reuse A's signed challenge.
    const res = await postJoinBody(pb, { v: 1, pairingId: pb.binding.pairingId, profile: { ...names(), devicePublicKey: d.publicKey }, proof: { mac: macOf(pb.joinKey, payloadA), signature: d.sign(canonicalBytes(payloadA)) } });
    expect(res.status).toBe(403);
    // And A's pairing id is unknown at B.
    const res2 = await postJoinBody(pb, { v: 1, pairingId: pa.binding.pairingId, profile: { ...names(), devicePublicKey: d.publicKey }, proof: { mac: macOf(pa.joinKey, payloadA), signature: d.sign(canonicalBytes(payloadA)) } });
    expect(res2.status).toBe(403);
  });

  it('expired challenge is rejected', async () => {
    const s = await start();
    const p = await paired(s);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + BINDING_TTL_MS + 1000);
    await expect(joinPaired(p, names(), device())).rejects.toMatchObject({ code: 'bad_proof' });
  });

  it('client-side: an expired binding is refused even with a valid MAC', async () => {
    const s = await start();
    await opaque.ready;
    const l = opaque.client.startLogin({ password: s.classroom.code });
    const post = (path: string, body: unknown) => fetch(`${s.bootstrapUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const st = await post('/api/pair/start', { v: 1, sessionId: s.classroom.id, startLoginRequest: l.startLoginRequest });
    const fin = opaque.client.finishLogin({ clientLoginState: l.clientLoginState, loginResponse: st.loginResponse, password: s.classroom.code, identifiers: opaqueIdentifiers(s.classroom.id) })!;
    const b = await post('/api/pair/finish', { v: 1, pairingId: st.pairingId, finishLoginRequest: fin.finishLoginRequest });
    const key = derivePairingKeys(fin.sessionKey).binding;
    expect(verifyBinding(key, b, { sessionId: s.classroom.id, pairingId: st.pairingId }).ok).toBe(true);
    expect(verifyBinding(key, b, { sessionId: s.classroom.id, pairingId: st.pairingId, now: b.binding.expiresAt + 1 })).toMatchObject({ ok: false, reason: 'binding expired' });
    expect(verifyBinding(key, b, { sessionId: randomUUID(), pairingId: st.pairingId }).ok).toBe(false);
  });

  it('known device auto-approves only with the same key; same roll number on a new key needs approval', async () => {
    const dbFile = tmp();
    const d = device();
    const s1 = await start('111111', 'OS', { dbPath: `${dbFile}/t.db` });
    s1.classroom.setPolicy('known');
    const j1 = await secureJoin(s1, 1, d);
    expect(j1.status).toBe('pending');
    s1.classroom.setStatus(j1.memberId, 'approved');
    await s1.close(); servers.splice(servers.indexOf(s1), 1);

    const s2 = await start('222222', 'OS', { dbPath: `${dbFile}/t.db` });
    s2.classroom.setPolicy('known');
    const again = await secureJoin(s2, 1, d);
    expect(again.status).toBe('approved');
    expect(s2.classroom.roster()[0]!.trust).toBe('known');
    // Key rotation / new laptop / impostor with the same name + roll number: not trusted.
    const other = await secureJoin(s2, 1, device());
    expect(other.status).toBe('pending');
    expect(s2.classroom.roster().find((m) => m.id === other.memberId)!.trust).toBe('new_device');
  });

  it('pre-2.5 UUID trust is not carried over: copied UUID gives nothing', async () => {
    const dbFile = `${tmp()}/t.db`;
    const s1 = await start('111111', 'OS', { dbPath: dbFile });
    const db = (s1.classroom as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    db.prepare("INSERT INTO known_devices (course, device_id, full_name, roll_no, first_approved_at) VALUES ('OS', ?, 'Student 1', 'FA23-CS-101', 0)").run(randomUUID());
    s1.classroom.setPolicy('known');
    const j = await secureJoin(s1, 1);
    expect(j.status).toBe('pending');
    expect(s1.classroom.roster()[0]!.trust).toBe('first');
  });

  it('blocked and removed devices: join and reconnect are refused', async () => {
    const s = await start();
    s.classroom.setPolicy('open');
    const d1 = device(), d2 = device();
    const a = await secureJoin(s, 1, d1);
    const b = await secureJoin(s, 2, d2);
    s.classroom.setStatus(a.memberId, 'blocked');
    s.classroom.setStatus(b.memberId, 'removed');
    await expect(secureJoin(s, 1, d1)).rejects.toMatchObject({ code: 'blocked' });
    const t = trFor(s.url);
    await expect(reconnect({ url: s.url, transport: t, sessionId: s.classroom.id, device: d1 })).rejects.toMatchObject({ status: 403 });
    await expect(reconnect({ url: s.url, transport: t, sessionId: s.classroom.id, device: d2 })).rejects.toMatchObject({ status: 403 });
    expect((await secureJoin(s, 2, d2)).status).toBe('pending'); // removed: must be re-approved
  });
});

describe('device-key reconnect', () => {
  it('a joined device gets a fresh token without the code; old token dies', async () => {
    const { s, students: [a] } = await classWith(1);
    servers.push(s);
    const r = await reconnect({ url: s.url, transport: trFor(s.url), sessionId: s.classroom.id, device: a!.device });
    expect(r.memberId).toBe(a!.memberId);
    expect(r.status).toBe('approved');
    expect(s.classroom.authenticate(a!.token)).toBeNull();
    const st = socket(s.url, r.token);
    expect((await st.next('hello')).status).toBe('approved');
    st.close();
  });

  it('copied public key, wrong key, replayed or cross-key challenges all fail', async () => {
    const { s, students: [a] } = await classWith(1);
    servers.push(s);
    const t = trFor(s.url);
    const thief = { publicKey: a!.device.publicKey, sign: device().sign };
    await expect(reconnect({ url: s.url, transport: t, sessionId: s.classroom.id, device: thief })).rejects.toMatchObject({ code: 'bad_proof' });
    await expect(reconnect({ url: s.url, transport: t, sessionId: s.classroom.id, device: device() })).rejects.toMatchObject({ status: 404 });
    // Replay a valid reconnect body.
    let body: string | null = null;
    const spy = { ...t, fetch: (u: string, i?: RequestInit) => { if (u.endsWith('/api/reconnect')) body = String(i?.body); return t.fetch(u, i); } };
    await reconnect({ url: s.url, transport: spy, sessionId: s.classroom.id, device: a!.device });
    const replay = await t.fetch(`${s.url}/api/reconnect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body! });
    expect(replay.status).toBe(403);
    // Challenge issued for key A, answered by key B.
    const b = device();
    const ch = await (await t.fetch(`${s.url}/api/reconnect/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, devicePublicKey: a!.device.publicKey }) })).json();
    const proof = { type: 'classroom-lan/reconnect-proof', v: 1, sessionId: s.classroom.id, challengeId: ch.challengeId, challenge: ch.challenge, deviceKeyFingerprint: keyFingerprint(b.publicKey) };
    const cross = await t.fetch(`${s.url}/api/reconnect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, challengeId: ch.challengeId, devicePublicKey: b.publicKey, signature: b.sign(canonicalBytes(proof)) }) });
    expect(cross.status).toBe(403);
  });

  it('a device that never joined this session must pair with the code', async () => {
    const s = await start();
    await expect(reconnect({ url: s.url, transport: trFor(s.url), sessionId: s.classroom.id, device: device() })).rejects.toMatchObject({ status: 404 });
  });
});

describe('signed receipts', () => {
  async function submitted() {
    const { s, students: [a] } = await classWith(1);
    servers.push(s);
    const A = s.assignments.create({ title: 'Assignment 04', maxBytes: 1_000_000 });
    const f = makeFile(1234, 'lab.zip');
    const key = randomUUID();
    const receipt = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: A.id, path: f.path, idempotencyKey: key });
    return { s, a: a!, A, f, key, receipt };
  }

  it('receipt carries the required fields and verifies against the paired teacher key', async () => {
    const { s, a, A, f, receipt } = await submitted();
    expect(receipt.alg).toBe('Ed25519');
    expect(receipt.teacherPublicKey).toBe(s.teacherPublicKey);
    expect(receipt.payload).toMatchObject({
      type: 'classroom-lan/receipt', v: 1, submissionId: expect.any(String), receiptId: expect.any(String), assignmentId: A.id, sessionId: s.classroom.id,
      courseTitle: 'Class', memberId: a.memberId, studentKeyFingerprint: keyFingerprint(a.device.publicKey), rollNo: 'FA23-CS-100',
      fileName: 'lab.zip', size: 1234, sha256: f.sha256, late: false, version: 1, status: 'accepted', teacherKeyFingerprint: keyFingerprint(s.teacherPublicKey),
    });
    expect(verifyReceipt(receipt, { trustedTeacherKey: s.teacherPublicKey, sessionId: s.classroom.id }).ok).toBe(true);
  });

  const tampers: [string, (p: ReceiptPayload) => void][] = [
    ['fileName', (p) => { p.fileName = 'other.zip'; }],
    ['size', (p) => { p.size += 1; }],
    ['sha256', (p) => { p.sha256 = 'f'.repeat(64); }],
    ['submittedAt', (p) => { p.submittedAt -= 3_600_000; }],
    ['late', (p) => { p.late = !p.late; }],
    ['version', (p) => { p.version = 1 + p.version; }],
    ['student', (p) => { p.rollNo = 'FA23-CS-999'; p.studentKeyFingerprint = keyFingerprint(device().publicKey); }],
    ['assignment', (p) => { p.assignmentId = randomUUID(); }],
  ];
  for (const [field, tamper] of tampers) {
    it(`tampered ${field} fails verification`, async () => {
      const { s, receipt } = await submitted();
      const bad: Receipt = structuredClone(receipt);
      tamper(bad.payload);
      const r = verifyReceipt(bad, { trustedTeacherKey: s.teacherPublicKey });
      expect(r.ok).toBe(false);
    });
  }

  it('replaced teacher key, re-signed by an attacker, corrupted signature, other session: all fail', async () => {
    const { s, receipt } = await submitted();
    const attacker = device();
    const forged: Receipt = structuredClone(receipt);
    forged.payload.teacherKeyFingerprint = keyFingerprint(attacker.publicKey);
    forged.teacherPublicKey = attacker.publicKey;
    forged.signature = attacker.sign(canonicalBytes(forged.payload));
    expect(verifyReceipt(forged, { trustedTeacherKey: s.teacherPublicKey })).toMatchObject({ ok: false, reason: 'signed by a different teacher key' });
    const swapped: Receipt = { ...structuredClone(receipt), teacherPublicKey: attacker.publicKey };
    expect(verifyReceipt(swapped).ok).toBe(false);
    const corrupt: Receipt = structuredClone(receipt);
    const sig = b64u.decode(corrupt.signature); sig[5] = sig[5]! ^ 0xff; corrupt.signature = b64u.encode(sig);
    expect(verifyReceipt(corrupt, { trustedTeacherKey: s.teacherPublicKey })).toMatchObject({ ok: false });
    expect(verifyReceipt(receipt, { trustedTeacherKey: s.teacherPublicKey, sessionId: randomUUID() })).toMatchObject({ ok: false, reason: 'receipt is from another classroom session' });
    expect(verifyReceipt({ ...receipt, alg: 'none' } as unknown as Receipt).ok).toBe(false);
  });

  it('idempotent retry returns the byte-identical signed receipt', async () => {
    const { s, a, A, f, key, receipt } = await submitted();
    const again = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a.token, assignmentId: A.id, path: f.path, idempotencyKey: key });
    expect(JSON.stringify(again)).toBe(JSON.stringify(receipt));
    expect(s.assignments.listForStudent(a.memberId)[0]!.latest).toEqual(receipt);
  });

});

describe('tokens and secrets', () => {
  it('tokens have an absolute lifetime even when active', async () => {
    const { s, students: [a] } = await classWith(1);
    servers.push(s);
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now');
    // Keep using the token every 20 minutes, so the 30-minute idle expiry never triggers.
    for (let m = 20; m < 8 * 60; m += 20) {
      clock.mockReturnValue(t0 + m * 60_000);
      expect(s.classroom.authenticate(a!.token), `minute ${m}`).not.toBeNull();
    }
    clock.mockReturnValue(t0 + 8 * 60 * 60_000 + 1000);
    expect(s.classroom.authenticate(a!.token)).toBeNull();
  });

  it('the join code is never persisted', async () => {
    const dir = tmp();
    const s = await start('482915', 'OS', { dbPath: `${dir}/t.db` });
    const raw = (await import('node:fs')).readFileSync(`${dir}/t.db`);
    expect(raw.includes(Buffer.from('482915'))).toBe(false);
    const db = (s.classroom as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    expect(db.prepare('SELECT join_code FROM sessions').get()).toEqual({ join_code: '' });
  });

  it('redact() strips tokens, keys, OPAQUE blobs and codes', () => {
    const token = b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
    const pem = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----';
    const out = redact(`Authorization: Bearer ${token} key=${pem} code 482915 {"token":"abc","startLoginRequest":"zzz"} sig ${'A'.repeat(86)}`);
    for (const secret of [token, 'MC4CAQAw', '482915', '"abc"', '"zzz"', 'A'.repeat(86)]) expect(out).not.toContain(secret);
    expect(redact(new Error(`bad token ${token}`))).not.toContain(token);
  });
});

describe('receipt verifier CLI', () => {
  it('exit 0 verified, 1 tampered or wrong key, 2 unanchored', async () => {
    const { s, students: [a] } = await classWith(1);
    servers.push(s);
    const A = s.assignments.create({ title: 'A4', maxBytes: 1000 });
    const r = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: A.id, path: makeFile(10, 'x.pdf').path, idempotencyKey: randomUUID() });
    const { writeFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const dir = tmp();
    const cwd = (await import('node:url')).fileURLToPath(new URL('../../..', import.meta.url));
    const run = (receipt: unknown, key?: string) => {
      writeFileSync(`${dir}/r.json`, JSON.stringify(receipt));
      return spawnSync(process.execPath, ['tools/sim/verify-receipt.ts', `${dir}/r.json`, ...(key ? ['--teacher-key', key] : [])], { cwd, encoding: 'utf8' });
    };
    const ok = run(r, s.teacherPublicKey);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('Verified ✓');
    expect(run({ ...r, payload: { ...r.payload, fileName: 'other.pdf' } }, s.teacherPublicKey).status).toBe(1);
    expect(run(r, device().publicKey).status).toBe(1);
    expect(run(r).status).toBe(2);
  });
});

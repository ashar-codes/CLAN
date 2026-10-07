// Universal CLAN join: every CLAN type uses the same secure join (OPAQUE → bound TLS → device-key proof). Authority comes
// from server-side capabilities of the host, never from the CLAN type name or anything a member sends.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { b64u, canonicalBytes, capabilitiesFor, ClanType, JOIN_POLICY, verifyManifest, type ResourceView } from '@classroom/protocol';
import { PeerAgent } from '@classroom/client/peer';
import { Classroom, openDb, startClassroomServer, type RunningServer, type ServerOptions } from '../src/index.ts';
import { device, get, makeFile, secureJoin, socket, tmp, trFor, trustServer } from './helpers.ts';

const servers: RunningServer[] = [];
const agents: PeerAgent[] = [];
afterEach(async () => { await Promise.all(agents.splice(0).map((a) => a.stop())); await Promise.all(servers.splice(0).map((s) => s.close())); });

async function host(type: ClanType, o: Partial<ServerOptions> = {}) {
  const s = await startClassroomServer({ title: `${type} test`, host: '127.0.0.1', storageDir: tmp('clan-'), clan: { type, id: randomUUID(), expiresAt: type === 'TEMPORARY' ? Date.now() + 3600_000 : null }, ...o });
  servers.push(s); trustServer(s);
  return s;
}
const hostSocket = async (s: RunningServer) => { const w = socket(s.url, s.classroom.teacherToken); await w.opened; await w.next('hello'); return w; };
const MB = 1024 * 1024;
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('CLAN types', () => {
  it('every joinable type can be hosted; capabilities follow the type; Personal Space is not a CLAN type', async () => {
    for (const type of ClanType.options) {
      const s = await host(type);
      expect(s.classroom.info()).toMatchObject({ clanType: type, ended: false });
      expect(s.classroom.can({ role: 'teacher' }, 'APPROVE_MEMBERS')).toBe(true);
      expect(s.classroom.can({ role: 'teacher' }, 'CREATE_ASSIGNMENT')).toBe(type === 'CLASSROOM');
      expect(capabilitiesFor(type, 'member')).not.toContain('APPROVE_MEMBERS');
    }
    await expect(startClassroomServer({ title: 'x', host: '127.0.0.1', clan: { type: 'PERSONAL' as never } })).rejects.toThrow();
    await expect(startClassroomServer({ title: 'x', host: '127.0.0.1', clan: { type: 'TEMPORARY' } })).rejects.toThrow(/end time/);
  });

  it('a Study Group member joins with the six-digit code over the same secure pairing', async () => {
    const s = await host('STUDY_GROUP');
    s.classroom.setPolicy(JOIN_POLICY.CODE_ONLY);
    const j = await secureJoin(s, 1);
    expect(j.status).toBe('approved');
    const w = socket(s.url, j.token); await w.opened;
    const hello = await w.next('hello');
    expect(hello.classroom).toMatchObject({ clanType: 'STUDY_GROUP', clanId: s.classroom.clan.id });
    expect(hello.capabilities).toEqual(expect.arrayContaining(['VIEW_MEMBERS', 'SEND_MESSAGE']));
    expect(hello.capabilities).not.toContain('SUBMIT_ASSIGNMENT');
    const roster = await w.next('members');
    expect(roster.members.map((m) => m.name)).toEqual(['Host', 'Student 1']);
    expect(JSON.stringify(roster)).not.toMatch(/FA23|Laptop|deviceFingerprint/); // names only, no ids or keys
    w.close();
  });
});

describe('join policies', () => {
  it('APPROVAL_REQUIRED holds members pending until the host approves', async () => {
    const s = await host('PROJECT_TEAM');
    const j = await secureJoin(s, 1);
    expect(j.status).toBe('pending');
    const h = await hostSocket(s);
    h.send({ t: 'member.approve', memberId: j.memberId });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.classroom.status(j.memberId)).toBe('approved');
    h.close();
  });

  it('KNOWN_MEMBERS_AUTO_APPROVED is scoped to the CLAN: known in this CLAN, a stranger in another', async () => {
    const db = openDb(':memory:');
    const clanId = randomUUID(), d = device();
    const a = await host('STUDY_GROUP', { db, clan: { type: 'STUDY_GROUP', id: clanId } });
    a.classroom.setPolicy('open');
    await secureJoin(a, 1, d);
    await a.close(); servers.splice(servers.indexOf(a), 1);
    const again = await host('STUDY_GROUP', { db, clan: { type: 'STUDY_GROUP', id: clanId } });
    again.classroom.setPolicy(JOIN_POLICY.KNOWN_MEMBERS_AUTO_APPROVED);
    expect((await secureJoin(again, 1, d)).status).toBe('approved');
    const other = await host('STUDY_GROUP', { db, title: 'STUDY_GROUP test', clan: { type: 'STUDY_GROUP', id: randomUUID() } });
    other.classroom.setPolicy('known');
    expect((await secureJoin(other, 1, d)).status).toBe('pending'); // same title, different CLAN: not known
  });

  it('CODE_ONLY admits anyone who proves the code; a wrong code is still refused', async () => {
    const s = await host('FRIENDS');
    s.classroom.setPolicy('open');
    expect((await secureJoin(s, 1)).status).toBe('approved');
    await expect(secureJoin(s, 2, device(), s.classroom.code === '000000' ? '111111' : '000000')).rejects.toThrow();
  });
});

describe('authority', () => {
  it('a Study Group host cannot use Classroom authority (assignments); members cannot use host authority', async () => {
    const s = await host('STUDY_GROUP');
    s.classroom.setPolicy('open');
    const h = await hostSocket(s);
    h.send({ t: 'assignment.create', assignment: { title: 'x', instructions: '', allowedExtensions: ['pdf'], maxBytes: 1000, mode: 'individual' } });
    expect((await h.next('error')).code).toBe('forbidden');
    const j = await secureJoin(s, 1);
    const m = socket(s.url, j.token); await m.opened; await m.next('hello');
    for (const t of [{ t: 'member.approve', memberId: j.memberId }, { t: 'class.end' }, { t: 'class.peerAssist', enabled: true }, { t: 'resource.push', resourceId: 'x' }]) {
      m.send(t);
      expect((await m.next('error')).code).toBe('forbidden');
    }
    expect(s.classroom.info().ended).toBe(false);
    const up = await trFor(s.url).fetch(`${s.url}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${j.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(up.status).toBe(403);
    h.close(); m.close();
  });

  it('member of CLAN A has no access to CLAN B, even hosted from the same device database', async () => {
    const db = openDb(':memory:');
    const a = await host('STUDY_GROUP', { db }), b = await host('PROJECT_TEAM', { db });
    a.classroom.setPolicy('open');
    const j = await secureJoin(a, 1);
    expect((await get(`${a.url}/api/resources`, j.token)).status).toBe(200);
    expect((await get(`${b.url}/api/resources`, j.token)).status).toBe(401);
    expect(b.classroom.authenticate(j.token)).toBeNull();
  });

  it('a member cannot impersonate the host: data it signs is rejected as authority data', async () => {
    const s = await host('STUDY_GROUP');
    const f = makeFile(1 * MB);
    const r = await s.resources.importFile(f.path);
    const real = s.resources.manifest({ role: 'teacher' }, r.id);
    expect(verifyManifest(real, { trustedTeacherKey: s.teacherPublicKey, sessionId: s.classroom.id, resourceId: r.id }).ok).toBe(true);
    const member = generateKeyPairSync('ed25519');
    const pub = b64u.encode(new Uint8Array(member.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)));
    const { sign } = await import('node:crypto');
    const forged = { ...real, teacherPublicKey: pub, signature: b64u.encode(new Uint8Array(sign(null, canonicalBytes(real.payload), member.privateKey))) };
    expect(verifyManifest(forged, { trustedTeacherKey: s.teacherPublicKey, sessionId: s.classroom.id, resourceId: r.id }).ok).toBe(false);
  });

  it('removed members lose access at once; blocked members cannot come back', async () => {
    const s = await host('STUDY_GROUP');
    s.classroom.setPolicy('open');
    const d1 = device(), d2 = device();
    const a = await secureJoin(s, 1, d1), b = await secureJoin(s, 2, d2);
    const h = await hostSocket(s);
    h.send({ t: 'member.remove', memberId: a.memberId });
    h.send({ t: 'member.block', memberId: b.memberId });
    await new Promise((r) => setTimeout(r, 150));
    expect((await get(`${s.url}/api/resources`, a.token)).status).toBe(401);
    expect(() => s.classroom.reconnect(s.classroom.member(b.memberId)!.deviceId)).toThrow(/not allowed/); // device-key reconnect refused too
    await expect(secureJoin(s, 2, d2)).rejects.toThrow(/blocked/);
    expect((await secureJoin(s, 1, d1)).status).toBe('pending'); // removed: must be re-approved even under CODE_ONLY
    h.close();
  });
});

describe('files under generic CLAN authority', () => {
  const agent = (s: RunningServer, token: string, d: ReturnType<typeof device>) => {
    const a = new PeerAgent({ transport: trFor(s.url), url: s.url, token: () => token, sessionId: s.classroom.id, teacherKey: s.teacherPublicKey, device: d, host: '127.0.0.1', destDir: tmp(), canSeed: true });
    agents.push(a); return a;
  };
  const view = (r: ResourceView) => ({ id: r.id, name: r.name, size: r.size, sha256: r.sha256 });

  it('host shares a file; a Project Team member downloads and verifies it (host-signed manifest)', async () => {
    const s = await host('PROJECT_TEAM', { limits: { chunkSize: 256 * 1024 } });
    s.classroom.setPolicy('open');
    const d = device(), j = await secureJoin(s, 1, d);
    const f = makeFile(3 * MB);
    const r = await s.resources.importFile(f.path);
    const A = agent(s, j.token, d); await A.start();
    const out = await A.acquire(view(r), { peerAssist: false, chunkTimeoutMs: 3000, stallTimeoutMs: 10_000 });
    expect(sha(out.path)).toBe(f.sha256);
  });

  it('peer-assisted transfer works in a Study Group, and the relaying peer gains no host authority', async () => {
    const s = await host('STUDY_GROUP', { limits: { chunkSize: 256 * 1024, downloadRequestsPerMinute: 100_000 } });
    s.classroom.setPolicy('open'); s.classroom.setPeerAssist(true);
    const da = device(), db = device();
    const ja = await secureJoin(s, 1, da), jb = await secureJoin(s, 2, db);
    const f = makeFile(6 * MB);
    const r = await s.resources.importFile(f.path);
    const A = agent(s, ja.token, da), B = agent(s, jb.token, db);
    await A.start(); await B.start();
    await A.acquire(view(r), { peerAssist: true, chunkTimeoutMs: 3000, stallTimeoutMs: 10_000 });
    const end = Date.now() + 5000;
    while (!s.peers.sources(r.id, jb.memberId).length && Date.now() < end) await new Promise((x) => setTimeout(x, 20));
    const rb = await B.acquire(view(r), { peerAssist: true, chunkTimeoutMs: 3000, stallTimeoutMs: 10_000 });
    expect(sha(rb.path)).toBe(f.sha256);
    expect(rb.stats.peerBytes).toBeGreaterThan(0);
    expect(s.classroom.can({ role: 'student', memberId: ja.memberId }, 'SHARE_RESOURCE')).toBe(false);
    const m = socket(s.url, ja.token); await m.opened; await m.next('hello');
    m.send({ t: 'member.remove', memberId: jb.memberId });
    expect((await m.next('error')).code).toBe('forbidden');
    m.close();
  });
});

describe('Temporary CLAN', () => {
  it('ends at its end time: no new joins, member tokens stop working; the host can also end it early', () => {
    let t = 1_000_000;
    const db = openDb(':memory:');
    const c = new Classroom(db, 'Library study session', 'lan', { now: () => t, clan: { type: 'TEMPORARY', id: randomUUID(), expiresAt: t + 60_000 } });
    c.setPolicy('open');
    const m = c.join({ fullName: 'A', rollNo: 'R1', deviceName: 'L', devicePublicKey: device().publicKey });
    expect(c.authenticate(m.token)).not.toBeNull();
    t += 60_001;
    expect(c.info().ended).toBe(true);
    expect(c.authenticate(m.token)).toBeNull();
    expect(() => c.join({ fullName: 'B', rollNo: 'R2', deviceName: 'L', devicePublicKey: device().publicKey })).toThrow(/ended/);
    const early = new Classroom(db, 'Quick', 'lan', { clan: { type: 'TEMPORARY', expiresAt: Date.now() + 3600_000 } });
    early.end();
    expect(early.info().ended).toBe(true);
  });
});

describe('compatibility', () => {
  it('a session without CLAN data is a classroom exactly as before (trust keyed by course title)', async () => {
    const s = await startClassroomServer({ title: 'Operating Systems', host: '127.0.0.1' }); servers.push(s); trustServer(s);
    expect(s.classroom.info()).toMatchObject({ clanType: 'CLASSROOM', clanId: null });
    s.classroom.setPolicy('open');
    await secureJoin(s, 1);
    const db = (s.classroom as unknown as { db: ReturnType<typeof openDb> }).db;
    expect(db.prepare('SELECT course FROM trusted_devices').all()).toEqual([{ course: 'Operating Systems' }]);
  });

  it('signed payload types keep their legacy names, so archived receipts and manifests still verify', async () => {
    const s = await host('STUDY_GROUP');
    const r = await s.resources.importFile(makeFile(1000).path);
    expect(s.resources.manifest({ role: 'teacher' }, r.id).payload.type).toBe('classroom-lan/resource-manifest');
    const protocol = readdirSync(join(import.meta.dirname, '../../protocol/src')).map((f) => readFileSync(join(import.meta.dirname, '../../protocol/src', f), 'utf8')).join('\n');
    for (const t of ['join-proof', 'reconnect-proof', 'receipt', 'resource-manifest', 'peer-endorsement', 'peer-capability', 'peer-request', 'tls-binding']) expect(protocol).toContain(`'classroom-lan/${t}'`);
  });

  it('architecture: security/network code never requires CLAN type CLASSROOM', () => {
    const root = join(import.meta.dirname, '../..');
    const hits: string[] = [];
    for (const dir of ['server/src', 'client/src', 'protocol/src']) for (const f of readdirSync(join(root, dir))) {
      if (f === 'clan.ts') continue; // the capability table is the one place types map to behaviour
      readFileSync(join(root, dir, f), 'utf8').split('\n').forEach((l, i) => { if (/[!=]==\s*'CLASSROOM'/.test(l) && !/trust scope|trustScope/.test(l)) hits.push(`${dir}/${f}:${i + 1}`); });
    }
    expect(hits).toEqual([]);
  });
});

// Persistent hosting gates from docs/PHASE_14_2_HOSTING_DESIGN.md: authority/fencing, CLAN checkpoints, staging
// verification and activation import. Transport is simulated by copying served blobs (the real one: server tests).
import { describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { serverCheckpointSection } from '@classroom/server';
import { authorityHash, checkpointHash, hostSessionStatement, sectionBytes, sha256Hex, signHostStatement, verifyAuthorityChain, type AuthorityRecord, type CheckpointHeader, type CheckpointProvider, type HostDelegation } from '@classroom/protocol';
import { HostAuthority } from '../src/index.ts';
import { file, setup, user } from './helpers.ts';

const T0 = 1_000_000;
const key = () => nodeSigner(newEd25519().privatePkcs8);
type Signer = ReturnType<typeof key>;
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** One device: CLAN core + a HostAuthority with every production section (CLAN modules + host server). */
function device(o: { now: () => number; owner?: () => string | null; extra?: CheckpointProvider[]; base?: ReturnType<typeof setup> }) {
  const d = o.base ?? setup({ now: o.now });
  const h = new HostAuthority(d.db, d.app.clans, { now: o.now, dir: join(d.storageDir, 'hosting'), me: () => d.app.me, linkedDeviceKey: (k) => k === o.owner?.() });
  for (const p of [d.app.clans.checkpointProvider(), d.app.chat.checkpointProvider(), d.app.whiteboard.checkpointProvider(), d.app.files.checkpointProvider(), serverCheckpointSection(d.db, d.storageDir), ...(o.extra ?? [])]) h.register(p);
  return { ...d, h };
}
const restart = (d: { db: ReturnType<typeof setup>['db']; storageDir: string }, owner?: () => string | null) => device({ now: () => T0, owner, base: setup({ db: d.db, storageDir: d.storageDir, now: () => T0 }) }).h;

/** Phone owner (hosts epoch 0), the owner's linked desktop, and a member device of someone else. */
function world(o: { extra?: () => CheckpointProvider[] } = {}) {
  let t = T0; const now = () => t;
  const ownerKey = key(), deskKey = key(), thirdKey = key();
  const phone = device({ now, owner: () => ownerKey.publicKey, extra: o.extra?.() });
  const desk = device({ now, owner: () => ownerKey.publicKey, extra: o.extra?.() });
  const third = device({ now, owner: () => null, extra: o.extra?.() });
  const clan = phone.app.clans.create({ type: 'STUDY_GROUP', name: 'Mobile group', createdBy: phone.app.me });
  phone.h.establish(clan.id, phone.app.me, ownerKey);
  third.app.clans.recordJoined({ id: clan.id, type: 'STUDY_GROUP', name: 'Mobile group', hostDeviceId: 'phone', hostName: 'Phone', me: third.app.me });
  third.h.anchorFromPairing(clan.id, phone.h.chainOf(clan.id)![0]);
  // the linked desktop has never seen the CLAN: bare record + owner anchored through the personal device link
  desk.app.clans.ensureKnown({ id: clan.id, type: 'STUDY_GROUP', name: 'Mobile group', expiresAt: null, createdBy: desk.app.me });
  desk.h.anchorLinkedOwner(clan.id, ownerKey.publicKey);
  const close = () => { for (const d of [phone, desk, third]) d.db.close(); };
  return { phone, desk, third, ownerKey, deskKey, thirdKey, clan, close, tick: (ms: number) => { t += ms; } };
}
type World = ReturnType<typeof world>;
type Dev = World['phone'];

/** CLAN data on the current host: chat, board, a CLAN file, and host-server sessions/members/trust/resources. */
async function seed(w: World, d: Dev = w.phone) {
  const clanId = w.clan.id, p = user(d.app.me);
  const thread = d.app.chat.groupThread(clanId);
  d.app.chat.post({ id: randomUUID(), threadId: thread.id, author: 'h1', authorName: 'Host', body: 'Welcome to the group' });
  d.app.chat.post({ id: randomUUID(), threadId: thread.id, author: 'm1', authorName: 'Member', body: 'Thanks!' });
  const board = d.app.whiteboard.boardFor(clanId);
  d.app.whiteboard.append(board.id, 'h1', [{ t: 'put', id: randomUUID(), obj: randomUUID(), clock: 1, data: { kind: 'rect', page: 0, x: 1, y: 2, w: 10, h: 10, color: '#112233', width: 2, z: 0 } }]);
  const shared = await d.app.files.add(p, file(d.storageDir, 'notes.txt', 'shared CLAN notes'), 'notes.txt', { kind: 'clan', clanId });
  const sessionId = randomUUID(), resourceId = randomUUID(), bytes = 'lecture slides bytes';
  d.db.prepare("INSERT INTO sessions (id, title, join_code, network_mode, started_at, ended_at, clan_type, clan_id, teacher_key) VALUES (?, 'Mobile group', 'SECRET', 'lan', ?, ?, 'STUDY_GROUP', ?, 'old-teacher-key')").run(sessionId, T0, T0 + 10, clanId);
  for (const [id, status] of [[randomUUID(), 'approved'], [randomUUID(), 'blocked']] as const) d.db.prepare(`INSERT INTO members (id, session_id, device_id, full_name, roll_no, device_name, status, token_hash, token_expires, joined_at, last_seen, device_key)
    VALUES (?, ?, ?, 'Member', '', 'Laptop', ?, ?, 9999999999999, ?, ?, 'device-key')`).run(id, sessionId, `dev-${id}`, status, `secret-token-${id}`, T0, T0);
  d.db.prepare('INSERT INTO trusted_devices (course, fingerprint, public_key, full_name, roll_no, first_approved_at, last_approved_at) VALUES (?, \'fp1\', \'pk1\', \'Member\', \'\', ?, ?)').run(`clan:${clanId}`, T0, T0);
  mkdirSync(join(d.storageDir, 'resources'), { recursive: true });
  writeFileSync(join(d.storageDir, 'resources', resourceId), bytes);
  d.db.prepare("INSERT INTO resources (id, session_id, original_name, safe_name, mime, size, sha256, added_at, status, manifest) VALUES (?, ?, 'slides.pdf', 'slides.pdf', 'application/pdf', ?, ?, ?, 'ready', '{\"signed\":\"by old host\"}')")
    .run(resourceId, sessionId, Buffer.byteLength(bytes), sha(bytes), T0);
  return { thread, board, shared, sessionId, resourceId, bytes };
}

/** Destination downloads every blob the source serves (what the replication transport does). */
async function transfer(from: Dev, to: Dev, clanId: string, only?: (sha: string) => boolean) {
  for (const b of await to.h.stagingPathList(clanId)) if (!only || only(b.sha256)) { const src = from.h.checkpointBlob(clanId, b.sha256); if (src) copyFileSync(src, b.path); }
}

/** Full hand-over from `src` (holding `srcKey`) to `dst`. */
async function handoff(w: World, o: { src?: Dev; srcKey?: Signer; dst?: Dev; dstKey?: Signer; d?: HostDelegation } = {}) {
  const src = o.src ?? w.phone, srcKey = o.srcKey ?? w.ownerKey, dst = o.dst ?? w.desk, dstKey = o.dstKey ?? w.deskKey;
  const delegation = o.d ?? w.phone.h.delegate(w.clan.id, w.ownerKey, dstKey.publicKey, { id: randomUUID() });
  src.h.freeze(w.clan.id, srcKey.publicKey);
  const { header, hash } = await src.h.prepareCheckpoint(w.clan.id, srcKey.publicKey);
  const chain = src.h.chainOf(w.clan.id)!;
  dst.h.beginStaging(chain, delegation, header, dstKey.publicKey);
  await transfer(src, dst, w.clan.id);
  await dst.h.completeStaging(w.clan.id);
  const ack = dst.h.acknowledge(w.clan.id, dstKey);
  const record = src.h.relinquish(w.clan.id, srcKey, delegation, ack);
  return { delegation, ack, record, header, hash, chain: [...chain, record] };
}

describe('persistent hosting authority', () => {
  it('only the owner establishes authority; genesis is writable by the owner device only', () => {
    const w = world();
    try {
      expect(w.phone.h.status(w.clan.id, w.ownerKey.publicKey)).toMatchObject({ epoch: 0, state: 'active', writable: true });
      expect(w.phone.h.status(w.clan.id, w.deskKey.publicKey)?.writable).toBe(false);
      expect(() => w.third.h.establish(w.clan.id, w.third.app.me, w.thirdKey)).toThrow('owner');
      expect(() => w.phone.h.establish(w.clan.id, w.phone.app.me, w.ownerKey)).toThrow('already');
      expect(() => w.phone.h.delegate(w.clan.id, w.deskKey, w.deskKey.publicKey, { id: randomUUID() })).toThrow('owner key');
    } finally { w.close(); }
  });

  it('hands over the complete CLAN: one writable host, data intact, secrets not carried, old host fenced across restart', async () => {
    const w = world();
    try {
      const s = await seed(w);
      const h = await handoff(w);
      expect(Object.keys(h.header.sections).sort()).toEqual(['chat', 'clans', 'files', 'server', 'whiteboard']);
      expect(w.phone.h.status(w.clan.id, w.ownerKey.publicKey)).toMatchObject({ state: 'relinquished', writable: false });
      expect(() => w.phone.h.unfreeze(w.clan.id, w.ownerKey.publicKey)).toThrow();
      const again = restart(w.phone);
      expect(() => again.assertWritable(w.clan.id, w.ownerKey.publicKey)).toThrow();
      expect(again.relinquish(w.clan.id, w.ownerKey, h.delegation, h.ack)).toEqual(h.record);
      expect(await w.desk.h.accept(h.chain, w.deskKey.publicKey)).toMatchObject({ epoch: 1, state: 'active', writable: true });
      // the new host has the CLAN as its owner, with chat, board, files and host-server records
      const d = w.desk.app;
      expect(d.clans.isActiveMember(w.clan.id, d.me)).toBe(true);
      expect(d.chat.page(s.thread.id).map((m) => m.body)).toEqual(['Welcome to the group', 'Thanks!']);
      expect(d.whiteboard.since(s.board.id, 0).head).toBe(1);
      expect(d.files.list(user(d.me), { kind: 'clan', clanId: w.clan.id }).find((x) => x.name === 'notes.txt')?.sha256).toBe(s.shared.sha256);
      expect(readFileSync(join(w.desk.storageDir, 'resources', s.resourceId), 'utf8')).toBe(s.bytes);
      const members = w.desk.db.prepare('SELECT status, token_hash t, token_expires e FROM members WHERE session_id = ? ORDER BY status').all(s.sessionId) as { status: string; t: string; e: number }[];
      expect(members.map((m) => m.status)).toEqual(['approved', 'blocked']); // removed/blocked members stay so
      expect(members.every((m) => m.t.startsWith('replicated:') && m.e === 0)).toBe(true); // tokens never travel
      expect(w.desk.db.prepare('SELECT join_code c, teacher_key k FROM sessions WHERE id = ?').get(s.sessionId)).toEqual({ c: '', k: null });
      expect(w.desk.db.prepare('SELECT manifest FROM resources WHERE id = ?').get(s.resourceId)).toEqual({ manifest: null });
      expect(w.desk.db.prepare('SELECT count(*) n FROM trusted_devices WHERE course = ?').get(`clan:${w.clan.id}`)).toEqual({ n: 1 });
      expect(await w.phone.h.accept(h.chain, w.ownerKey.publicKey)).toMatchObject({ epoch: 1, state: 'standby', writable: false });
      expect((await w.desk.h.accept(h.chain, w.deskKey.publicKey)).state).toBe('active'); // idempotent
    } finally { w.close(); }
  });

  it('rejects unauthorized, copied-key, wrong-CLAN, expired and revoked delegations, and member destinations', async () => {
    const w = world();
    try {
      w.phone.h.freeze(w.clan.id, w.ownerKey.publicKey);
      const { header } = await w.phone.h.prepareCheckpoint(w.clan.id, w.ownerKey.publicKey);
      const chain = w.phone.h.chainOf(w.clan.id)!;
      const base = { type: 'clan-host-delegation' as const, v: 1 as const, id: randomUUID(), clanId: w.clan.id, ownerKey: w.ownerKey.publicKey, destKey: w.deskKey.publicKey, actions: ['host' as const], issuedAt: T0, expiresAt: 2 * T0 };
      const stage = (d: HostDelegation) => w.desk.h.beginStaging(chain, d, header, w.deskKey.publicKey);
      expect(() => stage(signHostStatement(w.deskKey, base))).toThrow('not signed by the CLAN owner');
      const other = w.phone.app.clans.create({ type: 'FRIENDS', name: 'Other', createdBy: w.phone.app.me });
      expect(() => stage(signHostStatement(w.ownerKey, { ...base, clanId: other.id }))).toThrow('another CLAN');
      expect(() => stage(w.phone.h.delegate(w.clan.id, w.ownerKey, w.thirdKey.publicKey, { id: randomUUID() }))).toThrow('another device');
      const short = w.phone.h.delegate(w.clan.id, w.ownerKey, w.deskKey.publicKey, { id: randomUUID(), ttlMs: 1000 });
      w.tick(5000);
      expect(() => stage(short)).toThrow('expired');
      const revoked = w.phone.h.delegate(w.clan.id, w.ownerKey, w.deskKey.publicKey, { id: randomUUID() });
      w.desk.h.accept(chain, w.deskKey.publicKey);
      w.desk.h.addRevocation(w.phone.h.revoke(w.clan.id, w.ownerKey, revoked.id));
      expect(() => stage(revoked)).toThrow('revoked');
      expect(() => w.desk.h.addRevocation(signHostStatement(w.deskKey, { type: 'clan-host-revocation' as const, v: 1 as const, clanId: w.clan.id, ownerKey: w.ownerKey.publicKey, delegationId: randomUUID(), revokedAt: 1 }))).toThrow('owner');
      // a device that only joined the CLAN (pairing anchor) is never a hosting destination, even with an owner delegation
      const toThird = w.phone.h.delegate(w.clan.id, w.ownerKey, w.thirdKey.publicKey, { id: randomUUID() });
      expect(() => w.third.h.beginStaging(chain, toThird, header, w.thirdKey.publicKey)).toThrow('owner\'s own devices');
      expect(() => w.desk.h.beginStaging(chain, w.phone.h.delegate(w.clan.id, w.ownerKey, w.deskKey.publicKey, { id: randomUUID() }), { ...header, epoch: 3 }, w.deskKey.publicKey)).toThrow('current epoch');
    } finally { w.close(); }
  });

  it('staging verifies every byte itself: corrupt, missing, extra, out-of-scope and non-canonical checkpoints are refused; resume after restart', async () => {
    const w = world();
    try {
      await seed(w);
      const d = w.phone.h.delegate(w.clan.id, w.ownerKey, w.deskKey.publicKey, { id: randomUUID() });
      w.phone.h.freeze(w.clan.id, w.ownerKey.publicKey);
      const { header } = await w.phone.h.prepareCheckpoint(w.clan.id, w.ownerKey.publicKey);
      const chain = w.phone.h.chainOf(w.clan.id)!;
      w.desk.h.beginStaging(chain, d, header, w.deskKey.publicKey);
      expect(() => w.desk.h.acknowledge(w.clan.id, w.deskKey)).toThrow('not fully verified');
      const fileSha = header.files[0]!.sha256;
      await transfer(w.phone, w.desk, w.clan.id, (x) => x !== fileSha); // interrupted transfer
      await expect(w.desk.h.completeStaging(w.clan.id)).rejects.toThrow('not been received');
      // restart mid-staging: the same header resumes and reports exactly what is missing
      const again = restart(w.desk, () => w.ownerKey.publicKey);
      expect(again.beginStaging(chain, d, header, w.deskKey.publicKey).hash).toBe(checkpointHash(header));
      expect((await again.missingBlobs(w.clan.id)).map((b) => b.sha256)).toEqual([fileSha]);
      // corrupt bytes of the right size: detected and deleted for re-download
      const p = again.stagingPath(w.clan.id, fileSha);
      writeFileSync(p, 'x'.repeat(header.files[0]!.size));
      await expect(again.completeStaging(w.clan.id)).rejects.toThrow('corrupt');
      expect(existsSync(p)).toBe(false);
      await transfer(w.phone, w.desk, w.clan.id, (x) => x === fileSha);
      await again.completeStaging(w.clan.id);
      expect(again.acknowledge(w.clan.id, w.deskKey).checkpointHash).toBe(checkpointHash(header));
      expect(() => again.stagingPath(w.clan.id, sha('not in checkpoint'))).toThrow('not part');

      // forged checkpoints: the destination never verifies them
      const inDir = join(w.desk.storageDir, 'hosting', 'in', w.clan.id);
      const put = (rows: unknown[]) => { const b = sectionBytes(rows), s = sha256Hex(b); writeFileSync(join(inDir, s), b); return { sha256: s, size: b.length, rows: rows.length }; };
      const forge = async (mutate: (h: CheckpointHeader) => CheckpointHeader) => {
        again.beginStaging(chain, d, mutate(structuredClone(header)), w.deskKey.publicKey);
        return again.completeStaging(w.clan.id);
      };
      await expect(forge((h) => ({ ...h, sections: { ...h.sections, chat: put([{ t: 'chat_threads', r: { id: randomUUID(), clan_id: randomUUID(), kind: 'group', pair: '', created_at: 1 } }]) } }))).rejects.toThrow('outside this CLAN');
      await expect(forge((h) => ({ ...h, sections: { ...h.sections, chat: put([{ t: 'chat_me', r: { clan_id: w.clan.id, handle: 'x' } }]) } }))).rejects.toThrow('unexpected table');
      await expect(forge((h) => ({ ...h, sections: { ...h.sections, chat: put([{ t: 'chat_names', r: { clan_id: w.clan.id, handle: 'x', name: 'y', extra: 1 } }]) } }))).rejects.toThrow('Unexpected column');
      await expect(forge((h) => ({ ...h, files: [] }))).rejects.toThrow('file list');
      await expect(forge((h) => ({ ...h, files: [...h.files, { sha256: put([1]).sha256, size: sectionBytes([1]).length }] }))).rejects.toThrow('file list');
      await expect(forge((h) => { const { whiteboard: _w, ...rest } = h.sections; return { ...h, sections: rest }; })).rejects.toThrow('sections differ');
      await expect(forge((h) => ({ ...h, sections: { ...h.sections, files: { ...put([]), rows: 3 } } }))).rejects.toThrow('not canonical');
      const spaced = new TextEncoder().encode('[ ]'), spacedSha = sha256Hex(spaced);
      writeFileSync(join(inDir, spacedSha), spaced);
      await expect(forge((h) => ({ ...h, sections: { ...h.sections, files: { sha256: spacedSha, size: spaced.length, rows: 0 } } }))).rejects.toThrow('not canonical');
      await expect(forge((h) => { const x = put([]); appendFileSync(join(inDir, x.sha256), ' '); return { ...h, sections: { ...h.sections, files: { ...x, size: x.size + 1 } } }; })).rejects.toThrow('corrupt');
    } finally { w.close(); }
  });

  it('binds the hand-over to the checkpoint the source prepared; a resumed source invalidates older acknowledgments', async () => {
    const w = world();
    try {
      await seed(w);
      const d = w.phone.h.delegate(w.clan.id, w.ownerKey, w.deskKey.publicKey, { id: randomUUID() });
      w.phone.h.freeze(w.clan.id, w.ownerKey.publicKey);
      const first = await w.phone.h.prepareCheckpoint(w.clan.id, w.ownerKey.publicKey);
      const chain = w.phone.h.chainOf(w.clan.id)!;
      w.desk.h.beginStaging(chain, d, first.header, w.deskKey.publicKey);
      await transfer(w.phone, w.desk, w.clan.id);
      await w.desk.h.completeStaging(w.clan.id);
      const staleAck = w.desk.h.acknowledge(w.clan.id, w.deskKey);
      expect(() => w.phone.h.unfreeze(w.clan.id, w.deskKey.publicKey)).toThrow('paused host');
      w.phone.h.unfreeze(w.clan.id, w.ownerKey.publicKey); // the owner keeps hosting; new chat arrives
      expect(w.phone.h.checkpointBlob(w.clan.id, first.header.files[0]!.sha256)).toBeNull();
      w.phone.app.chat.post({ id: randomUUID(), threadId: w.phone.app.chat.groupThread(w.clan.id).id, author: 'h1', authorName: 'Host', body: 'later' });
      w.phone.h.freeze(w.clan.id, w.ownerKey.publicKey);
      expect(() => w.phone.h.relinquish(w.clan.id, w.ownerKey, d, staleAck)).toThrow('different checkpoint');
      w.tick(1);
      const second = await w.phone.h.prepareCheckpoint(w.clan.id, w.ownerKey.publicKey);
      expect(second.hash).not.toBe(first.hash);
      w.desk.h.beginStaging(chain, d, second.header, w.deskKey.publicKey); // replaces the unacknowledged staging
      await transfer(w.phone, w.desk, w.clan.id);
      await w.desk.h.completeStaging(w.clan.id);
      const rec = w.phone.h.relinquish(w.clan.id, w.ownerKey, d, w.desk.h.acknowledge(w.clan.id, w.deskKey));
      await w.desk.h.accept([...chain, rec], w.deskKey.publicKey);
      expect(w.desk.app.chat.page(w.desk.app.chat.groupThread(w.clan.id).id).at(-1)?.body).toBe('later');
    } finally { w.close(); }
  });

  it('a failed import (crash before activation) leaves the device a standby; the retry activates', async () => {
    let fail = true;
    const flaky = (): CheckpointProvider => ({ section: 'zz-test', export: () => ({ rows: [], files: [] }), validate: () => [], import: () => { if (fail) throw new Error('crash during import'); } });
    const w = world({ extra: () => [flaky()] });
    try {
      const s = await seed(w);
      const h = await handoff(w);
      await expect(w.desk.h.accept(h.chain, w.deskKey.publicKey)).rejects.toThrow('crash during import');
      expect(w.desk.h.status(w.clan.id, w.deskKey.publicKey)).toMatchObject({ epoch: 0, writable: false });
      expect(w.desk.app.chat.page(s.thread.id)).toEqual([]); // imported rows rolled back with the authority update
      fail = false;
      expect(await w.desk.h.accept(h.chain, w.deskKey.publicKey)).toMatchObject({ epoch: 1, writable: true });
      expect(w.desk.app.chat.page(s.thread.id)).toHaveLength(2);
    } finally { w.close(); }
  });

  it('refuses tampered records, stale chains, simultaneous handoffs and equal-epoch conflicts', async () => {
    const w = world();
    try {
      const genesis = w.phone.h.chainOf(w.clan.id)!;
      const h = await handoff(w);
      // a second destination after relinquishment: refused
      const d2 = w.phone.h.delegate(w.clan.id, w.ownerKey, w.thirdKey.publicKey, { id: randomUUID() });
      const ack3 = signHostStatement(w.thirdKey, { type: 'clan-host-ack' as const, v: 1 as const, clanId: w.clan.id, epoch: 0, prevHash: authorityHash(genesis[0]!), checkpointHash: h.hash, delegationId: d2.id, destKey: w.thirdKey.publicKey });
      expect(() => w.phone.h.relinquish(w.clan.id, w.ownerKey, d2, ack3)).toThrow('already handed');
      await expect(w.desk.h.accept([...genesis, { ...h.record, checkpointHash: h.hash.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }], w.deskKey.publicKey)).rejects.toThrow();
      await expect(w.desk.h.accept([...genesis, { ...h.record, hostKey: w.thirdKey.publicKey }], w.deskKey.publicKey)).rejects.toThrow();
      // an equal-epoch fork signed by the same (compromised/copied) host key
      const { sig: _s, ...body } = h.record;
      const forkRec: AuthorityRecord = signHostStatement(w.ownerKey, { ...body, hostKey: w.thirdKey.publicKey, delegation: d2, ack: ack3 });
      expect(verifyAuthorityChain([...genesis, forkRec], { clanId: w.clan.id }).ok).toBe(true);
      await w.desk.h.accept(h.chain, w.deskKey.publicKey);
      await expect(w.desk.h.accept([...genesis, forkRec], w.deskKey.publicKey)).rejects.toThrow('Conflicting');
      expect(w.desk.h.status(w.clan.id, w.deskKey.publicKey)).toMatchObject({ state: 'conflict', writable: false });
      await expect(w.phone.h.accept([...genesis, forkRec], w.ownerKey.publicKey)).rejects.toThrow('did not sign');
      await expect(w.third.h.accept(h.chain, w.thirdKey.publicKey)).resolves.toMatchObject({ epoch: 1, state: 'standby' });
      await expect(w.third.h.accept(genesis, w.thirdKey.publicKey)).rejects.toThrow('older'); // stale
    } finally { w.close(); }
  });

  it('revocation stops the delegated host; it can still hand the CLAN back to the owner device; a never-relinquished host conflicts', async () => {
    const w = world();
    try {
      const s = await seed(w);
      const h = await handoff(w);
      await w.desk.h.accept(h.chain, w.deskKey.publicKey);
      w.desk.app.chat.post({ id: randomUUID(), threadId: s.thread.id, author: 'h1', authorName: 'Host', body: 'written on the desktop' });
      w.desk.h.addRevocation(w.phone.h.revoke(w.clan.id, w.ownerKey, h.delegation.id));
      expect(w.desk.h.status(w.clan.id, w.deskKey.publicKey)).toMatchObject({ epoch: 1, state: 'active', writable: false });
      expect((await w.desk.h.accept(h.chain, w.deskKey.publicKey)).epoch).toBe(1); // accepted history stays valid
      await w.phone.h.accept(h.chain, w.ownerKey.publicKey);
      const back = w.phone.h.delegate(w.clan.id, w.ownerKey, w.ownerKey.publicKey, { id: randomUUID() });
      const r = await handoff(w, { src: w.desk, srcKey: w.deskKey, dst: w.phone, dstKey: w.ownerKey, d: back });
      expect(await w.phone.h.accept([...h.chain, r.record], w.ownerKey.publicKey)).toMatchObject({ epoch: 2, state: 'active', writable: true });
      expect(w.phone.app.chat.page(s.thread.id).at(-1)?.body).toBe('written on the desktop');
      expect(await w.third.h.accept([...h.chain, r.record], w.thirdKey.publicKey)).toMatchObject({ epoch: 2, state: 'standby' });
      // an active host offered a successor it never signed → conflict, not takeover
      const v = world();
      try {
        const forged = signHostStatement(v.ownerKey, { type: 'clan-host-authority' as const, v: 1 as const, clanId: v.clan.id, ownerKey: v.ownerKey.publicKey, epoch: 0, hostKey: v.ownerKey.publicKey, prevHash: null, checkpointHash: null, delegation: null, ack: null, issuedAt: 5 });
        await expect(v.phone.h.accept([forged], v.ownerKey.publicKey)).rejects.toThrow('Conflicting');
        expect(v.phone.h.status(v.clan.id, v.ownerKey.publicKey)?.writable).toBe(false);
      } finally { v.close(); }
    } finally { w.close(); }
  });

  it('trusts no first chain: owner keys are anchored by owner, authenticated pairing or a linked device', async () => {
    const w = world();
    try {
      const attacker = key();
      const fake = signHostStatement(attacker, { type: 'clan-host-authority' as const, v: 1 as const, clanId: w.clan.id, ownerKey: attacker.publicKey, epoch: 0, hostKey: attacker.publicKey, prevHash: null, checkpointHash: null, delegation: null, ack: null, issuedAt: 1 });
      await expect(w.third.h.accept([fake], w.thirdKey.publicKey)).rejects.toThrow('another owner');
      expect(() => w.third.h.anchorFromPairing(w.clan.id, fake)).toThrow('different owner');
      expect(() => w.third.h.anchorLinkedOwner(w.clan.id, w.ownerKey.publicKey)).toThrow('not a linked device');
      // a linked device cannot claim a CLAN this device already has without an anchor (e.g. its own legacy CLAN)
      const legacy = w.desk.app.clans.create({ type: 'FRIENDS', name: 'Mine', createdBy: w.desk.app.me });
      expect(() => w.desk.h.anchorLinkedOwner(legacy.id, w.ownerKey.publicKey)).toThrow('cannot be taken over');
      // the same owner learned at pairing may be confirmed as a linked device (the owner's desktop that had joined)
      const both = device({ now: () => T0, owner: () => w.ownerKey.publicKey });
      try {
        both.app.clans.recordJoined({ id: w.clan.id, type: 'STUDY_GROUP', name: 'Mobile group', hostDeviceId: 'phone', hostName: 'Phone', me: both.app.me });
        both.h.anchorFromPairing(w.clan.id, w.phone.h.chainOf(w.clan.id)![0]);
        both.h.anchorLinkedOwner(w.clan.id, w.ownerKey.publicKey);
        expect(both.h.anchorOf(w.clan.id)).toEqual({ ownerKey: w.ownerKey.publicKey, source: 'linked-device' });
      } finally { both.db.close(); }
      const lone = device({ now: () => T0, owner: () => null });
      try {
        lone.app.clans.recordJoined({ id: w.clan.id, type: 'STUDY_GROUP', name: 'Mobile group', hostDeviceId: 'phone', hostName: 'Phone', me: lone.app.me });
        await expect(lone.h.accept(w.phone.h.chainOf(w.clan.id), w.thirdKey.publicKey)).rejects.toThrow('not yet trusted');
      } finally { lone.db.close(); }
    } finally { w.close(); }
  });

  it('members verify that a session is run by the current authorized host; stale and forged sessions are refused', async () => {
    const w = world();
    try {
      const session = (chain: AuthorityRecord[], by: Signer, sessionId = randomUUID(), teacherPublicKey = key().publicKey) =>
        ({ clanId: w.clan.id, sessionId, teacherPublicKey, authority: { chain, proof: by.sign(hostSessionStatement({ clanId: w.clan.id, epoch: chain.at(-1)!.epoch, sessionId, teacherPublicKey })) } });
      const genesis = w.phone.h.chainOf(w.clan.id)!;
      expect(await w.third.h.verifySession(session(genesis, w.ownerKey))).toBe(0);
      await expect(w.third.h.verifySession(session(genesis, w.thirdKey))).rejects.toThrow('not run by');
      const ok = session(genesis, w.ownerKey);
      await expect(w.third.h.verifySession({ ...ok, teacherPublicKey: key().publicKey })).rejects.toThrow('not run by'); // proof for another session key
      const h = await handoff(w);
      expect(await w.third.h.verifySession(session(h.chain, w.deskKey))).toBe(1); // the new host's session
      // the old host (it relinquished) cannot present its epoch to members who know the newer one
      await expect(w.third.h.verifySession(session(genesis, w.ownerKey))).rejects.toThrow('older');
      // a member device that never paired before anchors from this first authenticated session; a different owner is refused
      const fresh = device({ now: () => T0, owner: () => null });
      try {
        fresh.app.clans.recordJoined({ id: w.clan.id, type: 'STUDY_GROUP', name: 'Mobile group', hostDeviceId: 'desk', hostName: 'Desk', me: fresh.app.me });
        expect(await fresh.h.verifySession(session(h.chain, w.deskKey))).toBe(1);
        const attacker = key();
        const fake = signHostStatement(attacker, { type: 'clan-host-authority' as const, v: 1 as const, clanId: w.clan.id, ownerKey: attacker.publicKey, epoch: 0, hostKey: attacker.publicKey, prevHash: null, checkpointHash: null, delegation: null, ack: null, issuedAt: 1 });
        await expect(fresh.h.verifySession(session([fake], attacker))).rejects.toThrow();
      } finally { fresh.db.close(); }
    } finally { w.close(); }
  });

  it('direct local edits to CLAN data follow the fence: paused, handed-over and revoked hosts refuse; personal data and member caches do not', async () => {
    const w = world();
    try {
      const s = await seed(w);
      const p = user(w.phone.app.me), scope = { kind: 'clan' as const, clanId: w.clan.id };
      const post = (d: Dev) => d.app.chat.post({ id: randomUUID(), threadId: s.thread.id, author: 'h1', authorName: 'Host', body: 'x' });
      const draw = (d: Dev, board = s.board.id) => d.app.whiteboard.append(board, 'h1', [{ t: 'put', id: randomUUID(), obj: randomUUID(), clock: 9, data: { kind: 'rect', page: 0, x: 0, y: 0, w: 1, h: 1, color: '#000000', width: 1, z: 0 } }]);
      w.phone.h.freeze(w.clan.id, w.ownerKey.publicKey);
      expect(() => post(w.phone)).toThrow(/paused/);
      expect(() => draw(w.phone)).toThrow(/paused/);
      await expect(w.phone.app.files.add(p, file(w.phone.storageDir, 'late.txt', 'late'), 'late.txt', scope)).rejects.toThrow(/paused/);
      const mine = w.phone.app.notes.create(p, { title: 'Personal', body: 'still mine' }); // personal data is never gated
      expect(mine.title).toBe('Personal');
      w.phone.h.unfreeze(w.clan.id, w.ownerKey.publicKey);
      expect(post(w.phone).created).toBe(true);
      const h = await handoff(w);
      expect(() => post(w.phone)).toThrow(/handed hosting over/);
      await w.desk.h.accept(h.chain, w.deskKey.publicKey);
      expect(post(w.desk).created).toBe(true);
      w.desk.h.addRevocation(w.phone.h.revoke(w.clan.id, w.ownerKey, h.delegation.id));
      expect(() => draw(w.desk)).toThrow(/revoked/);
      // a member device's cache (standby) is not a host write
      await w.third.h.accept(h.chain, w.thirdKey.publicKey);
      expect(w.third.h.localWriteBlocked(w.clan.id)).toBeNull();
    } finally { w.close(); }
  });

  it('conflicts are resolved only by an owner-signed choice; the unchosen copy is kept, never auto-deleted', async () => {
    const w = world();
    try {
      const s = await seed(w);
      const genesis = w.phone.h.chainOf(w.clan.id)!;
      const h = await handoff(w);
      await w.desk.h.accept(h.chain, w.deskKey.publicKey);
      w.desk.app.chat.post({ id: randomUUID(), threadId: s.thread.id, author: 'h1', authorName: 'Host', body: 'desk wrote this' });
      // an equal-epoch fork signed with the (copied) epoch-0 host key arrives at the desktop
      const d2 = w.phone.h.delegate(w.clan.id, w.ownerKey, w.thirdKey.publicKey, { id: randomUUID() });
      const ack3 = signHostStatement(w.thirdKey, { type: 'clan-host-ack' as const, v: 1 as const, clanId: w.clan.id, epoch: 0, prevHash: authorityHash(genesis[0]!), checkpointHash: h.hash, delegationId: d2.id, destKey: w.thirdKey.publicKey });
      const { sig: _s, ...body } = h.record;
      const fork = [...genesis, signHostStatement(w.ownerKey, { ...body, hostKey: w.thirdKey.publicKey, delegation: d2, ack: ack3 })];
      await expect(w.desk.h.accept(fork, w.deskKey.publicKey)).rejects.toThrow('Conflicting');
      const st = await w.desk.h.handoverStatus(w.clan.id, w.deskKey.publicKey);
      expect(st.conflict).toMatchObject({ forkEpoch: 1, oursHost: w.deskKey.publicKey, theirsHost: w.thirdKey.publicKey });
      expect(w.desk.h.localWriteBlocked(w.clan.id)).toMatch(/Conflicting/);
      // nothing but the owner's signature resolves it: a forged resolution is refused
      expect(() => w.desk.h.resolveConflict(signHostStatement(w.deskKey, { type: 'clan-host-resolution' as const, v: 1 as const, clanId: w.clan.id, ownerKey: w.ownerKey.publicKey, epoch: 1, chosenHash: st.conflict!.ours, issuedAt: 1 }))).toThrow('owner');
      // the owner chooses the desktop's record: it resumes as host and the fork is refused from now on without a new conflict
      expect(w.desk.h.resolveConflict(w.phone.h.resolve(w.clan.id, w.ownerKey, 1, st.conflict!.ours))).toMatchObject({ state: 'active' });
      expect(w.desk.h.status(w.clan.id, w.deskKey.publicKey)?.writable).toBe(true);
      await expect(w.desk.h.accept(fork, w.deskKey.publicKey)).rejects.toThrow('already chose');
      expect(w.desk.h.status(w.clan.id, w.deskKey.publicKey)?.writable).toBe(true);

      // the other way: a device holding the unchosen branch keeps its data, becomes a standby, and cannot be overwritten
      const v = world();
      try {
        const sv = await seed(v);
        const vg = v.phone.h.chainOf(v.clan.id)!;
        const hv = await handoff(v);
        await v.desk.h.accept(hv.chain, v.deskKey.publicKey);
        v.desk.app.chat.post({ id: randomUUID(), threadId: sv.thread.id, author: 'h1', authorName: 'Host', body: 'only on the desktop' });
        const dd = v.phone.h.delegate(v.clan.id, v.ownerKey, v.thirdKey.publicKey, { id: randomUUID() });
        const a3 = signHostStatement(v.thirdKey, { type: 'clan-host-ack' as const, v: 1 as const, clanId: v.clan.id, epoch: 0, prevHash: authorityHash(vg[0]!), checkpointHash: hv.hash, delegationId: dd.id, destKey: v.thirdKey.publicKey });
        const { sig: _x, ...b2 } = hv.record;
        const other = [...vg, signHostStatement(v.ownerKey, { ...b2, hostKey: v.thirdKey.publicKey, delegation: dd, ack: a3 })];
        await expect(v.desk.h.accept(other, v.deskKey.publicKey)).rejects.toThrow('Conflicting');
        const choice = v.phone.h.resolve(v.clan.id, v.ownerKey, 1, authorityHash(other[1]!));
        expect(v.desk.h.resolveConflict(choice)).toMatchObject({ epoch: 1, state: 'standby', writable: false });
        expect(v.desk.app.chat.page(sv.thread.id).at(-1)?.body).toBe('only on the desktop'); // retained
        expect(v.desk.h.superseded(v.clan.id)).toMatchObject({ epoch: 1 });
        const back = v.phone.h.delegate(v.clan.id, v.ownerKey, v.deskKey.publicKey, { id: randomUUID() });
        expect(() => v.desk.h.beginStaging(other, back, hv.header, v.deskKey.publicKey)).toThrow('acknowledge');
        v.desk.h.acknowledgeSuperseded(v.clan.id);
        expect(v.desk.h.superseded(v.clan.id)).toBeNull();
      } finally { v.close(); }
    } finally { w.close(); }
  });

  it('refuses to receive a CLAN without enough storage, before any byte is transferred', async () => {
    const w = world();
    try {
      await seed(w);
      const lowDisk = new HostAuthority(w.desk.db, w.desk.app.clans, { now: () => T0, dir: join(w.desk.storageDir, 'hosting'), me: () => w.desk.app.me, freeBytes: async () => 10_000_000 });
      const d = w.phone.h.delegate(w.clan.id, w.ownerKey, w.deskKey.publicKey, { id: randomUUID() });
      w.phone.h.freeze(w.clan.id, w.ownerKey.publicKey);
      const { header } = await w.phone.h.prepareCheckpoint(w.clan.id, w.ownerKey.publicKey);
      w.desk.h.beginStaging(w.phone.h.chainOf(w.clan.id)!, d, header, w.deskKey.publicKey);
      await expect(lowDisk.ensureSpace(w.clan.id)).rejects.toMatchObject({ code: 'insufficient_storage' });
      expect((await w.desk.h.missingBlobs(w.clan.id)).length).toBeGreaterThan(0); // nothing was received or changed
      await expect(w.desk.h.ensureSpace(w.clan.id, 0)).resolves.toBeTruthy();
    } finally { w.close(); }
  });
});

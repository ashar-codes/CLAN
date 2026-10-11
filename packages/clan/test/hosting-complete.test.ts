// Hosting hand-over data completeness: every table is classified, a real hosted Classroom (assignments, submission
// bytes and receipts, quarantined shares awaiting review, logs, chat, board) arrives intact, and anything that cannot
// be carried blocks the hand-over or needs the owner's explicit acknowledgment. Nothing is dropped silently.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { openDb, serverCheckpointSection, SERVER_TABLES, startClassroomServer, type RunningServer } from '@classroom/server';
import { classifyTable, HostAuthority, openClan } from '../src/index.ts';
import { device as memberKey, secureJoin, tmp, trustServer } from '../../server/test/helpers.ts';

const servers: RunningServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
const key = () => nodeSigner(newEd25519().privatePkcs8);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A device exactly as the desktop composes it: one database, CLAN core + host server, hosting with every section. */
function dev(owner: () => string) {
  const db = openDb(':memory:'), storageDir = tmp('handover-');
  const app = openClan(db, { storageDir });
  const h = new HostAuthority(db, app.clans, { dir: join(storageDir, 'hosting'), me: () => app.me, linkedDeviceKey: (k) => k === owner() });
  for (const p of [app.clans.checkpointProvider(), app.chat.checkpointProvider(), app.whiteboard.checkpointProvider(), app.files.checkpointProvider(), serverCheckpointSection(db, storageDir)]) h.register(p);
  h.onActivated(() => app.syncClassrooms());
  return { db, storageDir, app, h };
}
type Dev = ReturnType<typeof dev>;
async function handOver(src: Dev, srcKey: ReturnType<typeof key>, dst: Dev, dstKey: ReturnType<typeof key>, clanId: string, acknowledge: string[] = []) {
  const d = src.h.delegate(clanId, srcKey, dstKey.publicKey, { id: randomUUID() });
  src.h.freeze(clanId, srcKey.publicKey);
  const { header } = await src.h.prepareCheckpoint(clanId, srcKey.publicKey, { acknowledge });
  const c = src.app.clans.get(clanId)!;
  dst.app.clans.ensureKnown({ id: clanId, type: c.type, name: c.name, expiresAt: c.expiresAt, createdBy: dst.app.me });
  if (!dst.h.anchorOf(clanId)) dst.h.anchorLinkedOwner(clanId, srcKey.publicKey);
  const chain = src.h.chainOf(clanId)!;
  dst.h.beginStaging(chain, d, header, dstKey.publicKey);
  for (const b of await dst.h.stagingPathList(clanId)) copyFileSync(src.h.checkpointBlob(clanId, b.sha256)!, b.path);
  await dst.h.completeStaging(clanId);
  const rec = src.h.relinquish(clanId, srcKey, d, dst.h.acknowledge(clanId, dstKey));
  return dst.h.accept([...chain, rec], dstKey.publicKey);
}

describe('hand-over data completeness', () => {
  it('classifies every table of a device database (CLAN core + host server)', () => {
    const { db } = dev(() => '');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'core_module_versions'").all() as { name: string }[]).map((r) => r.name);
    const unclassified = tables.filter((t) => !SERVER_TABLES[t] && !classifyTable(t));
    expect(unclassified).toEqual([]);
    db.close();
  });

  it('carries a real Classroom: assignments, submissions with bytes and receipts, pending reviews with quarantined bytes, logs', async () => {
    const ownerKey = key(), deskKey = key();
    const src = dev(() => ownerKey.publicKey), dst = dev(() => ownerKey.publicKey);
    const clan = src.app.clans.create({ type: 'CLASSROOM', name: 'Physics 101', createdBy: src.app.me });
    src.h.establish(clan.id, src.app.me, ownerKey);
    const s = await startClassroomServer({ title: 'Physics 101', host: '127.0.0.1', db: src.db, storageDir: src.storageDir, chat: src.app.chat, whiteboard: src.app.whiteboard, clan: { type: 'CLASSROOM', id: clan.id },
      authority: { assertWritable: () => void src.h.assertWritable(clan.id, ownerKey.publicKey), chain: () => src.h.chainOf(clan.id)!, sign: (b) => ownerKey.sign(b) } });
    servers.push(s); trustServer(s); s.classroom.setPolicy('open');
    const a = await secureJoin(s, 1, memberKey());
    const assignment = s.assignments.create({ title: 'Lab report', maxBytes: 1_000_000 });
    const report = Buffer.from('my lab report');
    const up = await s.assignments.init(a.memberId, { assignmentId: assignment.id, fileName: 'report.txt', size: report.length, sha256: sha(report), idempotencyKey: randomUUID() });
    const done = await s.assignments.append(a.memberId, up.uploadId, 0, Readable.from(report));
    expect(done.state).toBe('complete');
    s.classroom.setFilePolicy('approval');
    const share = Buffer.from('awaiting the teacher');
    const su = await s.shares.init(a.memberId, { fileName: 'idea.txt', size: share.length, sha256: sha(share), to: 'clan', idempotencyKey: randomUUID() });
    expect(await s.shares.append(a.memberId, su.uploadId, 0, Readable.from(share))).toMatchObject({ approval: 'pending' });
    src.app.chat.post({ id: randomUUID(), threadId: src.app.chat.groupThread(clan.id).id, author: 'host', authorName: 'Teacher', body: 'Reports due Friday' });

    // nothing moves while the session is live
    src.h.freeze(clan.id, ownerKey.publicKey);
    expect(src.h.preflight(clan.id)).toEqual([expect.objectContaining({ code: 'live_session', blocking: true })]);
    await expect(src.h.prepareCheckpoint(clan.id, ownerKey.publicKey)).rejects.toMatchObject({ code: 'incomplete_data' });
    src.h.unfreeze(clan.id, ownerKey.publicKey);
    s.classroom.end(); await s.close(); servers.splice(servers.indexOf(s), 1);

    const logs = (d: Dev) => d.db.prepare('SELECT (SELECT count(*) FROM events) e, (SELECT count(*) FROM presence) p, (SELECT count(*) FROM members) m').get();
    const before = logs(src);
    expect(await handOver(src, ownerKey, dst, deskKey, clan.id)).toMatchObject({ epoch: 1, writable: true });
    expect(logs(dst)).toEqual(before);
    const q = (sql: string, ...p: string[]) => dst.db.prepare(sql).all(...p);
    expect(q('SELECT title FROM assignments')).toEqual([{ title: 'Lab report' }]);
    const sub = dst.db.prepare('SELECT stored_path, sha256, receipt FROM submissions').get() as { stored_path: string; sha256: string; receipt: string };
    expect(readFileSync(join(dst.storageDir, ...sub.stored_path.split('/')))).toEqual(report);
    expect(JSON.parse(sub.receipt).payload).toMatchObject({ sha256: sha(report) }); // the student's signed receipt stays verifiable
    expect(q("SELECT approval, state FROM share_uploads")).toEqual([{ approval: 'pending', state: 'complete' }]);
    expect(readFileSync(join(dst.storageDir, 'tmp', `${su.uploadId}.part`))).toEqual(share);
    expect((q('SELECT count(*) n FROM events') as { n: number }[])[0]!.n).toBeGreaterThan(0);
    expect(dst.app.chat.page(dst.app.chat.groupThread(clan.id).id).map((m) => m.body)).toEqual(['Reports due Friday']);
    // the new host's sessions see the CLAN as its own (Classroom course link and members rebuilt from carried rows)
    expect(dst.app.clans.sessionsOf(clan.id)).toHaveLength(1);
    // the quarantined bytes survive the destination's own next host start (startup sweep keeps pending reviews)
    const again = await startClassroomServer({ title: 'Physics 101', host: '127.0.0.1', db: dst.db, storageDir: dst.storageDir, clan: { type: 'CLASSROOM', id: clan.id },
      authority: { assertWritable: () => void dst.h.assertWritable(clan.id, deskKey.publicKey), chain: () => dst.h.chainOf(clan.id)!, sign: (b) => deskKey.sign(b) } });
    servers.push(again);
    expect(readFileSync(join(dst.storageDir, 'tmp', `${su.uploadId}.part`))).toEqual(share);
    // and the old host refuses to host it again
    await expect(startClassroomServer({ title: 'x', host: '127.0.0.1', db: src.db, storageDir: src.storageDir, clan: { type: 'CLASSROOM', id: clan.id },
      authority: { assertWritable: () => void src.h.assertWritable(clan.id, ownerKey.publicKey), chain: () => src.h.chainOf(clan.id)!, sign: (b) => ownerKey.sign(b) } })).rejects.toThrow(/handed hosting over/);
    for (const x of servers.splice(0)) await x.close();
    src.db.close(); dst.db.close();
  }, 60_000);

  it('blocks or asks: interrupted uploads need acknowledgment; missing bytes and uncarriable data block', async () => {
    const ownerKey = key(), deskKey = key();
    const src = dev(() => ownerKey.publicKey), dst = dev(() => ownerKey.publicKey);
    const clan = src.app.clans.create({ type: 'STUDY_GROUP', name: 'Group', createdBy: src.app.me });
    src.h.establish(clan.id, src.app.me, ownerKey);
    const session = randomUUID(), member = randomUUID(), resource = randomUUID();
    src.db.prepare("INSERT INTO sessions (id, title, join_code, network_mode, started_at, ended_at, clan_type, clan_id) VALUES (?, 'Group', '', 'lan', 1, 2, 'STUDY_GROUP', ?)").run(session, clan.id);
    src.db.prepare("INSERT INTO members (id, session_id, device_id, full_name, roll_no, device_name, status, token_hash, token_expires, joined_at, last_seen) VALUES (?, ?, 'd', 'M', '', 'L', 'approved', 'h', 0, 1, 1)").run(member, session);
    src.db.prepare("INSERT INTO share_uploads (id, session_id, member_id, idempotency_key, file_name, size, sha256, target, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 5, ?, 'clan', 'uploading', 1, 1)").run(randomUUID(), session, member, randomUUID(), sha('xxxxx'));
    src.h.freeze(clan.id, ownerKey.publicKey);
    expect(src.h.preflight(clan.id)).toEqual([expect.objectContaining({ code: 'interrupted_uploads', count: 1, blocking: false })]);
    await expect(src.h.prepareCheckpoint(clan.id, ownerKey.publicKey)).rejects.toMatchObject({ code: 'needs_acknowledgment' });
    // a ready file whose bytes vanished: blocking, cannot be acknowledged away
    src.db.prepare("INSERT INTO resources (id, session_id, original_name, safe_name, mime, size, sha256, added_at, status) VALUES (?, ?, 'a.pdf', 'a.pdf', 'application/pdf', 3, ?, 1, 'ready')").run(resource, session, sha('abc'));
    await expect(src.h.prepareCheckpoint(clan.id, ownerKey.publicKey, { acknowledge: ['interrupted_uploads', 'missing_files'] })).rejects.toMatchObject({ code: 'incomplete_data' });
    mkdirSync(join(src.storageDir, 'resources'), { recursive: true });
    writeFileSync(join(src.storageDir, 'resources', resource), 'abc');
    // a CLAN-scoped item no section carries: blocking
    const obj = src.app.store.adopt({ sha256: sha('abc'), size: 3, mime: 'text/plain', location: join(src.storageDir, 'resources', resource) });
    src.app.store.ref(obj.id, { module: 'notes', entity: 'attachment', entityId: 'n1', scope: { kind: 'clan', clanId: clan.id }, createdBy: src.app.me });
    await expect(src.h.prepareCheckpoint(clan.id, ownerKey.publicKey, { acknowledge: ['interrupted_uploads'] })).rejects.toMatchObject({ code: 'incomplete_data', issues: [expect.objectContaining({ code: 'unsupported_data' })] });
    src.app.store.unref(src.app.store.refsIn({ kind: 'clan', clanId: clan.id }, 'notes')[0]!.id);
    src.h.unfreeze(clan.id, ownerKey.publicKey);
    // acknowledged: carried as recorded (state kept), never silently dropped
    expect(await handOver(src, ownerKey, dst, deskKey, clan.id, ['interrupted_uploads'])).toMatchObject({ epoch: 1 });
    expect(dst.db.prepare('SELECT state FROM share_uploads').all()).toEqual([{ state: 'uploading' }]);
    rmSync(join(src.storageDir, 'resources', resource));
    src.db.close(); dst.db.close();
  }, 60_000);
});

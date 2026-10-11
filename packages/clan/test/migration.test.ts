// Classroom → CLAN migration: ids, history, files, assignments, receipts and participants are preserved.
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openDb } from '@classroom/server';
import { setup, tmp } from './helpers.ts';

const LEGACY_TABLES = ['sessions', 'members', 'resources', 'assignments', 'uploads', 'submissions', 'presence', 'events', 'trusted_devices', 'transfers'];
const snapshot = (db: ReturnType<typeof openDb>) => Object.fromEntries(LEGACY_TABLES.map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())]));

function legacyDb(storage: string) {
  const db = openDb(':memory:');
  const s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID();
  const ins = db.prepare("INSERT INTO sessions (id, title, join_code, network_mode, started_at, ended_at, teacher_key) VALUES (?, ?, '', 'lan', ?, ?, 'TK')");
  ins.run(s1, 'Operating Systems', 1000, 2000); ins.run(s2, 'operating  systems ', 3000, 4000); ins.run(s3, 'Databases', 5000, null);
  const mem = db.prepare(`INSERT INTO members (id, session_id, device_id, full_name, roll_no, device_name, status, token_hash, token_expires, joined_at, last_seen, device_key)
    VALUES (?, ?, ?, ?, ?, 'Mac', ?, ?, 0, ?, ?, ?)`);
  const keyA = 'A'.repeat(43), keyB = 'B'.repeat(43);
  const m = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID(), b2: randomUUID(), c: randomUUID(), legacy: randomUUID() };
  mem.run(m.a1, s1, 'dev-a', 'Ayesha', 'R1', 'approved', randomUUID(), 1100, 1100, keyA);
  mem.run(m.a2, s2, 'dev-a', 'Ayesha', 'R1', 'approved', randomUUID(), 3100, 3100, keyA); // same device, second meeting
  mem.run(m.b1, s1, 'dev-b', 'Bilal', 'R2', 'approved', randomUUID(), 1200, 1200, keyB);
  mem.run(m.b2, s2, 'dev-b', 'Bilal', 'R2', 'removed', randomUUID(), 3200, 3200, keyB);   // removed in the later meeting
  mem.run(m.c, s3, 'dev-c', 'Chen', 'R3', 'rejected', randomUUID(), 5100, 5100, null);
  mem.run(m.legacy, s3, 'dev-old', 'Dana', 'R4', 'approved', randomUUID(), 5200, 5200, null); // pre-2.5 member, no key
  const content = 'lecture 1 slides', sha = createHash('sha256').update(content).digest('hex'), res = randomUUID();
  mkdirSync(join(storage, 'resources'), { recursive: true });
  writeFileSync(join(storage, 'resources', res), content);
  db.prepare("INSERT INTO resources (id, session_id, original_name, safe_name, mime, size, sha256, added_at, status, manifest) VALUES (?, ?, 'Lecture-01.pdf', 'Lecture-01.pdf', 'application/pdf', ?, ?, 1500, 'ready', '{\"m\":1}')").run(res, s1, content.length, sha);
  const asg = randomUUID(), up = randomUUID(), sub = randomUUID();
  db.prepare("INSERT INTO assignments (id, session_id, title, instructions, allowed_ext, max_bytes, mode, created_at) VALUES (?, ?, 'Lab 1', '', 'pdf', 100, 'individual', 1600)").run(asg, s1);
  db.prepare("INSERT INTO uploads (id, session_id, assignment_id, member_id, idempotency_key, file_name, size, sha256, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'k', 'a.pdf', 1, 'x', 'complete', 1, 1)").run(up, s1, asg, m.a1);
  db.prepare("INSERT INTO submissions (id, session_id, assignment_id, member_id, device_id, upload_id, version, file_name, safe_name, stored_path, size, sha256, submitted_at, late, receipt) VALUES (?, ?, ?, ?, 'dev-a', ?, 1, 'a.pdf', 'a.pdf', 'p', 1, 'x', 1700, 0, '{\"sig\":\"s\"}')").run(sub, s1, asg, m.a1, up);
  return { db, s1, s2, s3, m, res, sha, asg, sub };
}

describe('classroom → CLAN migration', () => {
  it('does not resurrect deleted authority or re-adopt files from retained legacy history', () => {
    const storage = tmp(), L = legacyDb(storage);
    try {
      const { app } = setup({ db: L.db, storageDir: storage });
      app.clans.requestCleanup(L.s1, app.me, 'delete'); app.purgeClanProjection(L.s1);
      const newSession = randomUUID(), newMember = randomUUID();
      L.db.prepare("INSERT INTO sessions (id, title, join_code, network_mode, started_at) VALUES (?, 'Operating Systems', '', 'lan', 10000)").run(newSession);
      L.db.prepare(`INSERT INTO members (id, session_id, device_id, full_name, roll_no, device_name, status, token_hash, token_expires, joined_at, last_seen)
        VALUES (?, ?, 'fresh', 'Fresh', 'R9', 'Mac', 'approved', ?, 0, 10001, 10001)`).run(newMember, newSession, randomUUID());
      const reopened = setup({ db: L.db, storageDir: storage }).app;
      expect(reopened.clans.clanOfSession(newSession)).toBe(L.s1); // retained identity blocks fresh legacy title recreation
      expect(reopened.clans.list(app.me).map((c) => c.id)).toEqual([L.s3]);
      expect(reopened.store.refsIn({ kind: 'clan', clanId: L.s1 })).toEqual([]);
      expect(reopened.clans.members(L.s1).every((m) => m.status === 'removed')).toBe(true);
      expect(reopened.clans.members(L.s1).some((m) => m.displayName === 'Fresh')).toBe(false);
      expect(reopened.clans.cleanup(L.s1)?.completedAt).toBeNull();
    } finally { L.db.close(); }
  });
  it('maps courses to CLASSROOM CLANs, keeping ids, members and history; legacy tables are untouched', () => {
    const storage = tmp();
    const L = legacyDb(storage);
    const before = snapshot(L.db);
    const { app } = setup({ db: L.db, storageDir: storage });

    const clans = app.clans.list(app.me);
    expect(clans.map((c) => [c.name, c.type]).sort()).toEqual([['Databases', 'CLASSROOM'], ['Operating Systems', 'CLASSROOM']]);
    const os = clans.find((c) => c.name === 'Operating Systems')!;
    expect(os.id).toBe(L.s1); // the course keeps its first session's id
    expect(app.clans.sessionsOf(os.id)).toEqual([L.s1, L.s2]); // both meetings, in order
    expect(app.clans.clanOfSession(L.s3)).toBe(clans.find((c) => c.name === 'Databases')!.id);

    const members = app.clans.members(os.id);
    const byName = Object.fromEntries(members.map((m) => [m.displayName, m]));
    expect(byName['Me']!.role).toBe('owner');
    expect(byName['Ayesha']!.status).toBe('active');          // one person across both meetings
    expect(byName['Bilal']!.status).toBe('removed');          // removal in the later meeting wins
    expect(members.filter((m) => m.displayName === 'Ayesha')).toHaveLength(1);
    const db3 = app.clans.members(L.s3).map((m) => m.displayName).sort();
    expect(db3).toEqual(['Dana', 'Me']);                       // rejected Chen is linked but not a member; keyless Dana kept

    // every member row is linked by its original id
    expect((L.db.prepare('SELECT count(*) n FROM clans_classroom_members').get() as { n: number }).n).toBe(6);

    // classroom files appear in the CLAN without copying; assignments/submissions/receipts stay put and stay reachable
    const files = app.files.list({ kind: 'user', userId: app.me }, { kind: 'clan', clanId: os.id });
    expect(files).toMatchObject([{ name: 'Lecture-01.pdf', sha256: L.sha, source: 'classroom' }]);
    expect(app.store.object(files[0]!.objectId)!.location).toBe(join(storage, 'resources', L.res));
    const subs = L.db.prepare('SELECT s.receipt FROM submissions s WHERE s.session_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(app.clans.sessionsOf(os.id))) as { receipt: string }[];
    expect(subs).toEqual([{ receipt: '{"sig":"s"}' }]);

    expect(snapshot(L.db)).toEqual(before);
  });

  it('is idempotent and picks up classes held after the first import', async () => {
    const storage = tmp();
    const L = legacyDb(storage);
    const { app } = setup({ db: L.db, storageDir: storage });
    const created = () => (L.db.prepare("SELECT count(*) n FROM core_events WHERE type = 'CLANCreated'").get() as { n: number }).n;
    expect(created()).toBe(2);
    expect(app.syncClassrooms()).toEqual({ courses: 0, clans: 0, sessions: 0, members: 0, files: 0 });
    // reopening the same database (app restart) changes nothing
    setup({ db: L.db, storageDir: storage });
    expect(created()).toBe(2);

    const s4 = randomUUID();
    L.db.prepare("INSERT INTO sessions (id, title, join_code, network_mode, started_at) VALUES (?, 'Databases', '', 'lan', 9000)").run(s4);
    expect(app.syncClassrooms()).toMatchObject({ clans: 0, sessions: 1 });
    expect(app.clans.sessionsOf(L.s3)).toEqual([L.s3, s4]);
  });

  it('runs on a database written by the real classroom server migrations (fresh install)', () => {
    const { app } = setup();
    expect(app.clans.list(app.me)).toEqual([]);
  });

  it('sessions hosted for a CLAN link straight to it, for every type; members record joined CLANs canonically', () => {
    const { app, db } = setup();
    const sg = app.clans.create({ type: 'STUDY_GROUP', name: 'OS study group', createdBy: app.me });
    const s1 = randomUUID(), s2 = randomUUID();
    const ins = db.prepare("INSERT INTO sessions (id, title, join_code, network_mode, started_at, clan_type, clan_id) VALUES (?, ?, '', 'lan', ?, ?, ?)");
    ins.run(s1, 'OS study group', 1, 'STUDY_GROUP', sg.id); ins.run(s2, 'OS study group', 2, 'STUDY_GROUP', sg.id);
    db.prepare(`INSERT INTO members (id, session_id, device_id, full_name, roll_no, device_name, status, token_hash, token_expires, joined_at, last_seen, device_key)
      VALUES (?, ?, 'x', 'Hana', 'R', 'L', 'approved', ?, 0, 5, 5, ?)`).run(randomUUID(), s2, randomUUID(), 'H'.repeat(43));
    app.syncClassrooms();
    expect(app.clans.sessionsOf(sg.id)).toEqual([s1, s2]);
    expect(app.clans.list(app.me).map((c) => c.type)).toEqual(['STUDY_GROUP']); // no stray CLASSROOM CLAN by title
    expect(app.clans.members(sg.id).map((m) => m.displayName).sort()).toEqual(['Hana', 'Me']);

    // the member's own device: one CLAN row, host identified by its device key, local profile not copied
    const member = setup();
    const joined = member.app.clans.recordJoined({ id: sg.id, type: 'STUDY_GROUP', name: 'OS study group', hostDeviceId: 'host-fp', hostName: 'OS study group host', me: member.app.me });
    member.app.clans.recordJoined({ id: sg.id, type: 'STUDY_GROUP', name: 'OS study group', hostDeviceId: 'host-fp', hostName: 'x', me: member.app.me });
    expect(member.app.clans.list(member.app.me)).toEqual([joined]);
    expect(member.app.clans.members(sg.id).map((m) => m.role).sort()).toEqual(['member', 'owner']);
    expect(() => member.app.clans.recordJoined({ id: randomUUID(), type: 'PERSONAL' as never, name: 'x', hostDeviceId: 'h', hostName: 'h', me: member.app.me })).toThrow();
    member.app.clans.archive(sg.id);
    expect(member.app.clans.list(member.app.me)).toEqual([]); // ended CLAN leaves My CLANs
  });
});

describe('Classroom → Course', () => {
  it('each CLASSROOM CLAN gets one linked Course (idempotent, references only); its assignments are projected, never copied into Tasks', () => {
    const storage = tmp();
    const L = legacyDb(storage);
    const { app } = setup({ db: L.db, storageDir: storage });
    const me = { kind: 'user' as const, userId: app.me };
    const courses = app.courses.list(me);
    expect(courses.map((c) => [c.name, c.clanId]).sort()).toEqual([['Databases', L.s3], ['Operating Systems', L.s1]]);
    expect(app.syncClassrooms().courses).toBe(0);
    // reopening the same database changes nothing
    expect(setup({ db: L.db, storageDir: storage }).app.courses.list(me)).toHaveLength(2);
    // the host sees its classroom assignment through the course; nothing is duplicated
    const os = app.courses.forClan(me, L.s1)!;
    expect(app.assignments.list(me, { clanId: os.clanId! })).toMatchObject([{ id: L.asg, title: 'Lab 1', role: 'host', submitted: 1 }]);
    expect(app.tasks.list(me)).toEqual([]);
    expect(app.courses.links(me, os.id)).toEqual([]); // the CLAN's files stay in the CLAN until the student links them
    // an archived course is not recreated
    app.courses.archive(me, os.id);
    expect(app.syncClassrooms().courses).toBe(0);
    expect(app.courses.list(me).map((c) => c.name)).toEqual(['Databases']);
  });
});

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { file, setup, user } from './helpers.ts';

describe('device-local CLAN lifecycle', () => {
  it('retains authenticated session scope for cleanup after leave and rejects session reassignment', () => {
    const { app: c, db, storageDir } = setup();
    try {
      const id = randomUUID(), sessionId = randomUUID();
      const joined = { id, sessionId, type: 'FRIENDS' as const, name: 'Friends', hostDeviceId: 'scope-host', hostName: 'Host', me: c.me };
      c.clans.recordJoined(joined); c.clans.leave(id, c.me);
      expect(setup({ db, storageDir }).app.clans.localSessionsOf(id, c.me)).toEqual([sessionId]);
      expect(c.clans.localSessionsOf(id, 'other-user')).toEqual([]);
      const other = c.clans.create({ type: 'FRIENDS', name: 'Other', createdBy: c.me });
      expect(() => c.clans.recordJoined({ ...joined, id: other.id })).toThrow('different CLAN');
      expect(c.clans.localSessionsOf(id, c.me)).toEqual([sessionId]);
    } finally { db.close(); }
  });
  it('scoped projection cleanup preserves private study data, course file IDs and other CLAN references', async () => {
    const { app: c, db, storageDir } = setup();
    try {
      const p = user(c.me), clan = c.clans.create({ type: 'STUDY_GROUP', name: 'Delete', createdBy: c.me });
      const other = c.clans.create({ type: 'STUDY_GROUP', name: 'Keep', createdBy: c.me });
      const note = c.notes.create(p, { title: 'Private keeper', body: 'Keep this body' });
      c.notes.share(p, note.id, clan.id); c.notes.share(p, note.id, other.id);
      const saved = c.saved.add(p, { url: 'https://example.org', title: 'Private link' }); c.saved.share(p, saved.id, clan.id);
      const scope = { kind: 'clan' as const, clanId: clan.id };
      const shared = await c.files.add(p, file(storageDir, 'shared.txt', 'same content'), 'shared.txt', scope);
      c.files.share(p, shared.refId, { kind: 'clan', clanId: other.id });
      const courseFile = await c.files.add(p, file(storageDir, 'course.txt', 'course protected content'), 'course.txt', scope);
      const course = c.courses.create(p, { name: 'Personal course' });
      c.courses.link(p, course.id, { module: 'files', entityId: courseFile.refId });
      c.courses.archive(p, course.id); // archived personal courses also retain their files
      const ownBoard = c.whiteboard.create(p, { kind: 'personal', id: c.me }, 'Private board');
      const clanBoard = c.whiteboard.boardFor(clan.id, 'Shared board');
      const thread = c.chat.groupThread(clan.id); c.chat.setMe(clan.id, 'mine');
      c.chat.post({ id: 'cleanup-message', threadId: thread.id, author: 'peer', authorName: 'Peer', body: 'Remove this chat' });
      expect(() => c.purgeClanProjection(clan.id)).toThrow('intent');
      c.clans.requestCleanup(clan.id, c.me, 'delete');
      expect(c.purgeClanProjection(clan.id).sort()).toEqual([shared.objectId, courseFile.objectId].sort());
      expect(c.purgeClanProjection(clan.id)).toHaveLength(2); // journal survives idempotent retry
      expect(c.clans.cleanup(clan.id)?.completedAt).toBeNull(); // bytes/server cleanup is still required
      expect(c.notes.get(p, note.id)).toMatchObject({ body: 'Keep this body', sharedWith: [other.id] });
      expect(c.saved.get(p, saved.id)?.sharedWith).toEqual([]);
      expect(c.files.get(p, courseFile.refId)).toMatchObject({ scope: { kind: 'personal', ownerId: c.me }, name: 'course.txt' });
      expect(await c.store.verify(courseFile.objectId)).toBe(true);
      expect(c.files.list(p, { kind: 'clan', clanId: other.id })).toHaveLength(1);
      expect(c.chat.thread(thread.id)).toBeNull();
      expect(c.notifications.list(p)).toEqual([]);
      expect(db.prepare('SELECT 1 FROM wb_boards WHERE id = ?').get(clanBoard.id)).toBeUndefined();
      expect(db.prepare('SELECT 1 FROM wb_boards WHERE id = ?').get(ownBoard.id)).toBeDefined();
      const reopened = setup({ db, storageDir }).app;
      expect(reopened.clans.cleanupObjects(clan.id)).toHaveLength(2);
      expect(reopened.clans.isActiveMember(clan.id, c.me)).toBe(false);
    } finally { db.close(); }
  });
  it('cleanup intent survives restart, fences authority and allows only completed member-copy removal to rejoin', () => {
    const { app: c, db, storageDir } = setup();
    try {
      const owner = c.identity.userForDevice('cleanup-host', 'Host');
      const clan = c.clans.create({ type: 'FRIENDS', name: 'Remove copy', createdBy: owner }); c.clans.addMember(clan.id, c.me);
      const other = c.clans.create({ type: 'FRIENDS', name: 'Keep', createdBy: c.me });
      const join = { id: clan.id, type: 'FRIENDS' as const, name: clan.name, hostDeviceId: 'cleanup-host', hostName: 'Host', me: c.me };
      expect(() => c.clans.requestCleanup(clan.id, c.me, 'delete')).toThrow('Only the owner');
      expect(() => c.clans.requestCleanup(other.id, c.me, 'remove')).toThrow('owner must hand off');
      c.clans.requestCleanup(clan.id, c.me, 'remove');
      expect(c.clans.has(clan.id, 'chat')).toBe(false);
      expect(c.clans.isActiveMember(clan.id, c.me)).toBe(false);
      expect(c.clans.list(c.me).map((x) => x.id)).toEqual([other.id]);
      expect(() => c.clans.addMember(clan.id, c.me)).toThrow('awaiting cleanup');
      expect(() => c.clans.recordJoined(join)).toThrow('Finish removing');
      const reopened = setup({ db, storageDir }).app;
      expect(reopened.clans.pendingCleanup(c.me)).toHaveLength(1);
      reopened.clans.completeCleanup(clan.id, owner); // another identity cannot complete the local request
      expect(() => reopened.clans.recordJoined(join)).toThrow('Finish removing');
      reopened.clans.completeCleanup(clan.id, c.me);
      reopened.clans.recordJoined(join);
      expect(reopened.clans.isActiveMember(clan.id, c.me)).toBe(true);
      expect(reopened.clans.cleanup(clan.id)).toBeUndefined();
      c.clans.requestCleanup(other.id, c.me, 'delete'); c.clans.completeCleanup(other.id, c.me);
      expect(() => c.clans.recordJoined({ ...join, id: other.id })).toThrow('deleted');
      expect(c.clans.isActiveMember(other.id, c.me)).toBe(false);
    } finally { db.close(); }
  });
  for (const method of ['add', 'ingest'] as const) it(`${method} refuses publication if membership ends during file storage`, async () => {
    const { app: c, db, storageDir } = setup();
    try {
      const owner = c.identity.userForDevice('copy-host', 'Host');
      const clan = c.clans.create({ type: 'STUDY_GROUP', name: 'Race', createdBy: owner }); c.clans.addMember(clan.id, c.me);
      const source = file(storageDir, `${method}.txt`, 'Verified bytes must not become a shared file after leave');
      const storeMethod = method === 'add' ? 'put' : 'ingest';
      const original = c.store[storeMethod].bind(c.store);
      c.store[storeMethod] = async (path: string, mime?: string) => {
        const stored = await original(path, mime);
        c.clans.leave(clan.id, c.me);
        return stored;
      };
      await expect(c.files[method](user(c.me), source, 'race.txt', { kind: 'clan', clanId: clan.id })).rejects.toThrow('Not allowed');
      expect(c.store.refsIn({ kind: 'clan', clanId: clan.id })).toEqual([]);
      // An app-produced source may have moved, but its verified bytes are still recoverable in the store.
      expect(c.store.orphans()).toHaveLength(1);
      expect(await c.store.verify(c.store.orphans()[0]!.id)).toBe(true);
      expect(db.prepare("SELECT 1 FROM core_events WHERE type = 'ResourceShared'").get()).toBeUndefined();
    } finally { db.close(); }
  });
  it('archive changes only the local list and survives reopen, without changing authorization', () => {
    const { app: c, db, storageDir } = setup();
    try {
      const clan = c.clans.create({ type: 'STUDY_GROUP', name: 'Archive me', createdBy: c.me });
      const other = c.identity.userForDevice('other-device', 'Other'); c.clans.addMember(clan.id, other);
      const note = c.notes.create(user(c.me), { title: 'Shared notes', body: 'Keep me' }); c.notes.share(user(c.me), note.id, clan.id, true);
      c.clans.setLocalArchive(clan.id, c.me, true); c.clans.setLocalArchive(clan.id, c.me, true);
      expect(c.clans.list(c.me)).toEqual([]);
      expect(c.clans.list(c.me, { archived: true }).map((x) => x.id)).toEqual([clan.id]);
      expect(c.clans.list(other).map((x) => x.id)).toEqual([clan.id]);
      expect(c.permissions.canRead(user(c.me), { kind: 'clan', clanId: clan.id })).toBe(true);
      expect(c.permissions.clansOf(user(c.me))).toContain(clan.id);
      expect(c.notes.inClan(user(c.me), clan.id).map((x) => x.id)).toContain(note.id);
      const reopened = setup({ db, storageDir }).app;
      expect(reopened.clans.list(c.me)).toEqual([]);
      reopened.clans.setLocalArchive(clan.id, c.me, false);
      expect(reopened.clans.list(c.me).map((x) => x.id)).toEqual([clan.id]);
    } finally { db.close(); }
  });

  it('leave revokes only the local member, preserves personal data, and requires approval to join again', () => {
    const { app: c, db } = setup();
    try {
      const owner = c.identity.userForDevice('owner-device', 'Host');
      const clan = c.clans.create({ type: 'FRIENDS', name: 'Friends', createdBy: owner }); c.clans.addMember(clan.id, c.me);
      const ownNote = c.notes.create(user(c.me), { title: 'Personal note' });
      c.clans.setLocalArchive(clan.id, c.me, true); c.clans.leave(clan.id, c.me);
      expect(c.clans.isActiveMember(clan.id, c.me)).toBe(false);
      expect(c.clans.isActiveMember(clan.id, owner)).toBe(true);
      expect(c.clans.list(c.me, { archived: true })).toEqual([]);
      expect(c.notes.mine(user(c.me)).map((x) => x.id)).toContain(ownNote.id);
      expect(() => c.clans.setLocalArchive(clan.id, c.me, false)).toThrow('Not allowed');
      expect(() => c.clans.leave(clan.id, owner)).toThrow('owner cannot leave');
      // Only the trusted authenticated-join coordinator calls recordJoined.
      c.clans.recordJoined({ id: clan.id, type: 'FRIENDS', name: 'Friends', hostDeviceId: 'owner-device', hostName: 'Host', me: c.me });
      expect(c.clans.isActiveMember(clan.id, c.me)).toBe(true);
    } finally { db.close(); }
  });

  it('rejects archive and leave by outsiders and retains ended/expired CLAN semantics', () => {
    const { app: c, db } = setup({ now: () => 100 });
    try {
      const clan = c.clans.create({ type: 'TEMPORARY', name: 'Expired', createdBy: c.me, expiresAt: 50 });
      const other = c.identity.userForDevice('outsider', 'Other');
      expect(() => c.clans.setLocalArchive(clan.id, other, true)).toThrow('Not allowed');
      expect(() => c.clans.leave(clan.id, other)).toThrow('Not allowed');
      expect(c.clans.list(c.me, { includeArchived: true })).toEqual([]);
      expect(c.clans.isActiveMember(clan.id, c.me)).toBe(false);
    } finally { db.close(); }
  });

  it('archiving a classroom preserves linked courses and real assignment deadlines', () => {
    const { app: c, db } = setup();
    try {
      const owner = c.identity.userForDevice('teacher-device', 'Teacher');
      const clan = c.clans.create({ type: 'CLASSROOM', name: 'Math', createdBy: owner }); c.clans.addMember(clan.id, c.me);
      c.assignments.seen(user(c.me), clan.id, [{ id: 'assignment-142', title: 'Real homework', dueAt: 2000, closed: false, latest: null }]);
      c.clans.setLocalArchive(clan.id, c.me, true);
      expect(c.courses.linkClassrooms(user(c.me))).toBe(1);
      expect(c.courses.linkClassrooms(user(c.me))).toBe(0);
      expect(c.courses.list(user(c.me)).filter((x) => x.clanId === clan.id)).toHaveLength(1);
      expect(c.assignments.list(user(c.me)).map((x) => x.title)).toContain('Real homework');
    } finally { db.close(); }
  });
});

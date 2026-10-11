import { describe, expect, it } from 'vitest';
import { setup, user } from './helpers.ts';

describe('device-local CLAN lifecycle', () => {
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

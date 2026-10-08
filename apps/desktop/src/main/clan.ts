// CLAN services for the desktop shell. Every call acts as this device's local user; the renderer never chooses a user.
import { ipcMain } from 'electron';
import { z } from 'zod';
import { openClan, AI_GRANTEE, type ClanApp } from '@clan/core';
import { ClanType, keyFingerprint } from '@classroom/protocol';
import type { HomeView } from '../shared.ts';

const Id = z.uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ACTIVITY: Record<string, string> = { CLANCreated: 'CLAN created', MemberJoined: 'CLAN membership added', NoteCreated: 'Note written', NoteShared: 'Note shared', SavedItemAdded: 'Link saved', SavedItemShared: 'Link shared', ResourceShared: 'File added', ReminderCreated: 'Reminder set' };

export type DesktopClan = ClanApp & { classroomClanFor(title: string): string | null };

export function registerClan(db: Parameters<typeof openClan>[0], storageDir: string, localName: () => string | undefined): DesktopClan {
  const c = openClan(db, { storageDir, localName: localName() });
  const me = { kind: 'user' as const, userId: c.me };
  const handle = (ch: string, f: (...a: unknown[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => f(...a));

  handle('clan:home', (): HomeView => {
    const now = Date.now();
    const recent = c.db.prepare(`SELECT type, ts FROM core_events WHERE type IN (${Object.keys(ACTIVITY).map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 8`).all(...Object.keys(ACTIVITY)) as { type: string; ts: number }[];
    return {
      me: { id: c.me, name: c.identity.displayName(c.me) ?? 'Me' },
      library: { notes: c.notes.mine(me, 500).length, saved: c.saved.items(me).length, courses: c.clans.list(c.me).filter((x) => x.type === 'CLASSROOM').length, files: c.files.list(me, { kind: 'personal', ownerId: c.me }).length },
      inboxCount: c.capture.inbox(me).length, // Personal Space › Inbox: everything captured and not yet filed
      diaryToday: !!c.diary.day(me, new Date().toLocaleDateString('en-CA')),
      clans: c.clans.list(c.me).map((x) => ({ id: x.id, name: x.name, type: x.type, members: c.clans.members(x.id).filter((m) => m.status === 'active').length })),
      continueNotes: c.notes.mine(me, 3).map((n) => ({ id: n.id, title: n.title, updatedAt: n.updatedAt })),
      deadlines: c.reminders.upcoming(me, now + 14 * 86_400_000),
      inbox: c.saved.items(me, c.saved.inbox(me)).slice(0, 5),
      activity: recent.map((r) => ({ label: ACTIVITY[r.type]!, ts: r.ts })),
      aiProvider: null,
    };
  });

  handle('clan:list', () => c.clans.list(c.me));
  /** CLANs as places: real counts only. */
  handle('clan:places', () => c.clans.list(c.me).map((x) => {
    const members = c.clans.members(x.id).filter((m) => m.status === 'active');
    const owner = members.find((m) => m.role === 'owner');
    return { id: x.id, name: x.name, type: x.type, expiresAt: x.expiresAt, members: members.length, files: c.files.list(me, { kind: 'clan', clanId: x.id }).length,
      sessions: c.clans.sessionsOf(x.id).length, host: owner?.userId === c.me ? 'You' : owner?.displayName ?? null, mine: owner?.userId === c.me };
  }));
  /** Knowledge Campus: CLASSROOM CLANs are the courses we really know about. No progress is inferred. */
  handle('study:courses', () => c.clans.list(c.me).filter((x) => x.type === 'CLASSROOM').map((x) => {
    const notes = c.notes.inClan(me, x.id);
    return { id: x.id, name: x.name, sessions: c.clans.sessionsOf(x.id).length, files: c.files.list(me, { kind: 'clan', clanId: x.id }).length,
      notes: notes.length, recentNotes: notes.filter((n) => n.updatedAt > Date.now() - 7 * 86_400_000).length, exams: 0 };
  }));
  handle('files:personal', () => c.files.list(me, { kind: 'personal', ownerId: c.me }));
  /** Called by the member UI once the host approved it. Values come from the authenticated session (hello) + the paired host key. */
  handle('clan:joined', (raw) => {
    const a = z.object({ sessionId: Id, clanId: Id.nullable(), type: ClanType, name: z.string().trim().min(1).max(80), hostKey: z.string().max(64), expiresAt: z.number().int().nullable(), hostName: z.string().trim().min(1).max(80).nullable().optional() }).parse(raw);
    c.clans.recordJoined({ id: a.clanId ?? a.sessionId, type: a.type, name: a.name, hostDeviceId: keyFingerprint(a.hostKey), hostName: a.hostName ?? `${a.name} host`, expiresAt: a.expiresAt, me: c.me });
  });
  handle('clan:detail', (id) => {
    const clan = c.clans.get(Id.parse(id));
    if (!clan || !c.clans.isActiveMember(clan.id, c.me)) throw new Error('Not found.');
    return {
      clan, mine: c.clans.members(clan.id).some((m) => m.userId === c.me && m.role === 'owner'), members: c.clans.members(clan.id).filter((m) => m.status === 'active').map((m) => ({ userId: m.userId, name: m.displayName ?? 'Someone', role: m.role })),
      sessions: c.clans.sessionsOf(clan.id).length, files: c.files.list(me, { kind: 'clan', clanId: clan.id }),
      notes: c.notes.inClan(me, clan.id).map((n) => ({ id: n.id, title: n.title, mine: n.ownerId === c.me })), saved: c.saved.inClan(me, clan.id),
    };
  });

  handle('notes:mine', () => c.notes.mine(me, 200));
  handle('notes:create', (raw) => c.notes.create(me, z.object({ title: z.string(), body: z.string().optional() }).parse(raw)));
  handle('notes:update', (id, raw) => c.notes.update(me, Id.parse(id), z.object({ title: z.string().optional(), body: z.string().optional() }).parse(raw)));
  handle('notes:remove', (id) => c.notes.remove(me, Id.parse(id)));
  handle('notes:share', (id, clanId, on) => c.notes.share(me, Id.parse(id), Id.parse(clanId), z.boolean().parse(on)));

  handle('saved:collections', () => c.saved.collections(me));
  handle('saved:items', () => c.saved.items(me));
  handle('saved:add', (raw) => c.saved.add(me, z.object({ url: z.string(), title: z.string().optional(), note: z.string().optional(), tags: z.array(z.string()).optional(), collectionId: Id.optional() }).parse(raw)));
  handle('saved:collection', (name) => c.saved.createCollection(me, z.string().parse(name)));
  handle('saved:move', (id, col) => c.saved.move(me, Id.parse(id), Id.parse(col)));
  handle('saved:share', (id, clanId, on) => c.saved.share(me, Id.parse(id), Id.parse(clanId), z.boolean().parse(on)));

  handle('diary:day', (day) => c.diary.day(me, Day.parse(day)));
  handle('diary:write', (raw) => c.diary.write(me, z.object({ day: Day, body: z.string(), mood: z.string().nullable().optional() }).parse(raw) as never));
  handle('diary:recent', () => c.diary.recent(me, 14));

  handle('reminders:create', (raw) => c.reminders.create(me, z.object({ text: z.string(), dueAt: z.number().int(), target: z.object({ module: z.string(), id: z.string() }).optional() }).parse(raw)));
  handle('reminders:done', (id) => c.reminders.done(me, Id.parse(id)));

  handle('search', (q) => c.search.query(me, z.string().max(200).parse(q)));
  handle('me:rename', (name) => c.identity.rename(c.me, z.string().trim().min(1).max(80).parse(name)));
  handle('privacy:get', () => ({ aiDiary: c.permissions.hasGrant(c.me, AI_GRANTEE, 'diary') }));
  handle('privacy:aiDiary', (on) => (z.boolean().parse(on) ? c.permissions.grant(c.me, AI_GRANTEE, 'diary') : c.permissions.revoke(c.me, AI_GRANTEE, 'diary')));
  const courseKey = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');
  return Object.assign(c, {
    /** The CLASSROOM CLAN for a course title, if one exists (keeps every meeting of a course in one CLAN). */
    classroomClanFor: (title: string) => c.clans.list(c.me).find((x) => x.type === 'CLASSROOM' && courseKey(x.name) === courseKey(title))?.id ?? null,
  });
}

// Notifications consumer (core/contracts.ts `Notifications`). Producers only publish events; this module decides what
// this device's person is told. Privacy first: a host device stores and relays direct conversations between other
// members, but nothing about them ever becomes a notice here — only conversations this person is part of.
import { randomUUID } from 'node:crypto';
import type { Db, ModuleSchema } from '../../core/db.ts';
import type { EventBus } from '../../core/events.ts';
import { userOf, type Principal } from '../../core/permissions.ts';
import type { Notice, Notifications as NotificationsContract } from '../../core/contracts.ts';
import { MessageCreated, type Chat } from '../chat/index.ts';
import { ReminderDue } from '../reminders/index.ts';
import { StudySessionEnded, StudySessionStarted } from '../study/index.ts';
import type { Clans } from '../clans/index.ts';
import type { SyncProvider } from '../../core/syncrows.ts';
import { z } from 'zod';

export const schema: ModuleSchema = {
  module: 'notifications', prefix: 'notify',
  migrations: [`
    CREATE TABLE notify_notices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('group','direct','file')),
      title TEXT NOT NULL, body TEXT NOT NULL, ref_module TEXT, ref_id TEXT, thread_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER);
    CREATE INDEX notify_notices_user ON notify_notices(user_id, read_at, created_at);
    CREATE TABLE notify_prefs (user_id TEXT PRIMARY KEY, groups INTEGER NOT NULL DEFAULT 1, direct INTEGER NOT NULL DEFAULT 1,
      files INTEGER NOT NULL DEFAULT 1, previews INTEGER NOT NULL DEFAULT 0);
  `, `
    -- 2: study notices (reminders, tasks due, planned sessions, cards due). Conservative defaults: card reminders off.
    CREATE TABLE notify_notices2 (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('group','direct','file','reminder','task','exam','study','cards')),
      title TEXT NOT NULL, body TEXT NOT NULL, ref_module TEXT, ref_id TEXT, thread_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER);
    INSERT INTO notify_notices2 SELECT id, user_id, kind, title, body, ref_module, ref_id, thread_id, created_at, read_at FROM notify_notices;
    DROP TABLE notify_notices;
    ALTER TABLE notify_notices2 RENAME TO notify_notices;
    CREATE INDEX notify_notices_user2 ON notify_notices(user_id, read_at, created_at);
    ALTER TABLE notify_prefs ADD COLUMN reminders INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE notify_prefs ADD COLUMN tasks INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE notify_prefs ADD COLUMN sessions INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE notify_prefs ADD COLUMN exams INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE notify_prefs ADD COLUMN cards INTEGER NOT NULL DEFAULT 0;
    -- one notice per (thing, occurrence): ticks are idempotent
    CREATE TABLE notify_sent (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `],
};

export type NoticePrefs = { groups: boolean; direct: boolean; files: boolean; previews: boolean; reminders: boolean; tasks: boolean; exams: boolean; sessions: boolean; cards: boolean };
type Kind = 'group' | 'direct' | 'file' | 'reminder' | 'task' | 'exam' | 'study' | 'cards';
export type NoticeContext = { foreground: boolean; viewing: string | null; focus: boolean };
export type DeliveredNotice = Notice & { kind: Kind; threadId: string; clanId: string; alert: boolean };
/** Study sources the consumer checks on `tick()` (only counts and titles; nothing private leaves its module). */
export type StudySources = {
  reminderText(id: string): { text: string } | null;
  tasksDueSoon(from: number, to: number): { id: string; ownerId: string; title: string; dueAt: number }[];
  examsSoon(from: number, to: number): { id: string; ownerId: string; name: string; at: number }[];
  sessionsStartingSoon(from: number, to: number): { id: string; ownerId: string; goal: string; plannedAt: number }[];
  cardsDue(): { ownerId: string; n: number }[];
};
/** Group conversations alert at most this often per conversation (the rest only count as unread). */
const GROUP_COALESCE_MS = 60_000;

export class Notifications implements NotificationsContract {
  private db: Db; private chat: Chat; private clans: Clans; private localUser: () => string; private now: () => number;
  private lastAlert = new Map<string, number>();
  context: NoticeContext = { foreground: false, viewing: null, focus: false };
  /** The host app shows OS/in-app notices through this sink. */
  onNotice: (n: DeliveredNotice) => void = () => {};

  private study: StudySources | null = null;
  /** A focus study session is running: everything except your own reminders waits quietly in the list. */
  private sessionFocus = false;
  constructor(db: Db, bus: EventBus, chat: Chat, clans: Clans, localUser: () => string, now = () => Date.now()) {
    this.db = db; this.chat = chat; this.clans = clans; this.localUser = localUser; this.now = now;
    bus.subscribe('notifications.chat', MessageCreated, (e) => this.onMessage(e.payload.messageId));
    bus.subscribe('notifications.reminder', ReminderDue, (e) => {
      const r = this.study?.reminderText(e.payload.reminderId);
      if (r && e.payload.ownerId === this.localUser()) this.deliver('reminder', 'Reminder', r.text, 'reminders', e.payload.reminderId, `reminder:${e.payload.reminderId}:${e.payload.at}`, true);
    });
    bus.subscribe('notifications.focus+', StudySessionStarted, (e) => { if (e.payload.ownerId === this.localUser()) this.sessionFocus = e.payload.focus; });
    bus.subscribe('notifications.focus-', StudySessionEnded, (e) => { if (e.payload.ownerId === this.localUser()) this.sessionFocus = false; });
  }

  /** Personal sync: notification preferences (what was already delivered stays per device). */
  syncProviders(): SyncProvider[] {
    const COLS = ['groups', 'direct', 'files', 'previews', 'reminders', 'tasks', 'sessions', 'exams', 'cards'] as const;
    const one = (owner: string) => { const r = this.db.prepare('SELECT * FROM notify_prefs WHERE user_id = ?').get(owner) as Record<string, number> | undefined; return r ? Object.fromEntries(COLS.map((c) => [c, r[c]])) : null; };
    return [{ kind: 'notify-prefs', policy: 'lww',
      all: (owner) => { const p = one(owner); return new Map(p ? [['prefs', p]] : []); },
      one: (owner, id) => id === 'prefs' ? one(owner) : null,
      apply: (owner, id, payload) => {
        if (id !== 'prefs' || payload === null) return;
        const v = z.object(Object.fromEntries(COLS.map((c) => [c, z.number().int().min(0).max(1)]))).parse(payload) as Record<string, number>;
        this.db.prepare(`INSERT INTO notify_prefs (user_id, ${COLS.join(', ')}) VALUES (?, ${COLS.map(() => '?').join(', ')}) ON CONFLICT (user_id) DO UPDATE SET ${COLS.map((c) => `${c} = excluded.${c}`).join(', ')}`).run(owner, ...COLS.map((c) => v[c]!));
      } }];
  }
  get focused() { return this.context.focus || this.sessionFocus; }
  connectStudy(s: StudySources) { this.study = s; }

  /**
   * Periodic check (the host app calls it about once a minute): tasks due within 24 h (once per task and due date),
   * exams within 24 h (once per exam and date),
   * planned study starting within 10 min, and — only if enabled — one "cards due" notice per day.
   */
  tick(now = this.now()) {
    const u = this.localUser();
    if (!u || !this.study) return;
    for (const t of this.study.tasksDueSoon(now, now + 86_400_000)) if (t.ownerId === u) this.deliver('task', 'Task due soon', `${t.title} · ${new Date(t.dueAt).toLocaleString()}`, 'tasks', t.id, `task:${t.id}:${t.dueAt}`, false);
    for (const e of this.study.examsSoon(now, now + 86_400_000)) if (e.ownerId === u) this.deliver('exam', 'Exam tomorrow', `${e.name} · ${new Date(e.at).toLocaleString()}`, 'exams', e.id, `exam:${e.id}:${e.at}`, false);
    for (const s of this.study.sessionsStartingSoon(now, now + 10 * 60_000)) if (s.ownerId === u) this.deliver('study', 'Planned study starting', s.goal || 'Study session', 'study', s.id, `study:${s.id}:${s.plannedAt}`, false);
    const cards = this.study.cardsDue().find((c) => c.ownerId === u);
    if (cards && cards.n > 0) this.deliver('cards', 'Flashcards', `${cards.n} card${cards.n === 1 ? '' : 's'} due`, 'flashcards', '', `cards:${new Date(now).toDateString()}`, false);
  }
  private deliver(kind: Kind, title: string, body: string, module: string, id: string, key: string, critical: boolean) {
    const user = this.localUser(), prefs = this.prefs({ kind: 'user', userId: user });
    const on = kind === 'reminder' ? prefs.reminders : kind === 'task' ? prefs.tasks : kind === 'exam' ? prefs.exams : kind === 'study' ? prefs.sessions : kind === 'cards' ? prefs.cards : true;
    if (!on || this.db.prepare('INSERT OR IGNORE INTO notify_sent (key, at) VALUES (?, ?)').run(key, this.now()).changes === 0) return;
    const n: DeliveredNotice = { id: randomUUID(), userId: user, title, body, ref: { module, entityId: id }, createdAt: this.now(), kind, threadId: '', clanId: '', alert: critical || !this.focused };
    this.db.prepare('INSERT INTO notify_notices (id, user_id, kind, title, body, ref_module, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(n.id, user, kind, title, body, module, id, n.createdAt);
    this.onNotice(n);
  }

  prefs(p: Principal): NoticePrefs {
    const r = this.db.prepare('SELECT groups, direct, files, previews, reminders, tasks, exams, sessions, cards FROM notify_prefs WHERE user_id = ?').get(userOf(p)) as Record<keyof NoticePrefs, number> | undefined;
    return { groups: !!(r?.groups ?? 1), direct: !!(r?.direct ?? 1), files: !!(r?.files ?? 1), previews: !!(r?.previews ?? 0), reminders: !!(r?.reminders ?? 1), tasks: !!(r?.tasks ?? 1), exams: !!(r?.exams ?? 1), sessions: !!(r?.sessions ?? 1), cards: !!(r?.cards ?? 0) };
  }
  setPrefs(p: Principal, next: Partial<NoticePrefs>) {
    const v = { ...this.prefs(p), ...next };
    this.db.prepare(`INSERT INTO notify_prefs (user_id, groups, direct, files, previews, reminders, tasks, exams, sessions, cards) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET groups = excluded.groups, direct = excluded.direct, files = excluded.files, previews = excluded.previews,
        reminders = excluded.reminders, tasks = excluded.tasks, exams = excluded.exams, sessions = excluded.sessions, cards = excluded.cards`)
      .run(userOf(p), +v.groups, +v.direct, +v.files, +v.previews, +v.reminders, +v.tasks, +v.exams, +v.sessions, +v.cards);
    return v;
  }

  list(p: Principal, o: { unreadOnly?: boolean } = {}): Notice[] {
    return (this.db.prepare(`SELECT id, user_id userId, title, body, ref_module m, ref_id r, created_at createdAt FROM notify_notices WHERE user_id = ? ${o.unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`)
      .all(userOf(p)) as unknown as (Notice & { m: string | null; r: string | null })[]).map(({ m, r, ...n }) => ({ ...n, ...(m && r ? { ref: { module: m, entityId: r } } : {}) }));
  }
  markRead(p: Principal, id: string) { this.db.prepare('UPDATE notify_notices SET read_at = ? WHERE id = ? AND user_id = ?').run(this.now(), id, userOf(p)); }
  /** Opening a conversation clears its notices. */
  markThreadRead(p: Principal, threadId: string) { this.db.prepare('UPDATE notify_notices SET read_at = ? WHERE thread_id = ? AND user_id = ? AND read_at IS NULL').run(this.now(), threadId, userOf(p)); }

  /** Lifecycle coordinator supplies exactly the threads removed by Chat. Personal study notices stay. */
  forgetThreads(threadIds: string[]) {
    for (const id of threadIds) {
      this.db.prepare('DELETE FROM notify_notices WHERE thread_id = ?').run(id);
      this.lastAlert.delete(id);
      if (this.context.viewing === id) this.context.viewing = null;
    }
  }

  private onMessage(messageId: string) {
    const user = this.localUser();
    const hit = user && this.chat.concernsLocal(messageId); // null unless this person is a participant
    if (!hit || hit.message.author === hit.me || hit.message.removed) return;
    const { message: m, thread: t } = hit;
    const kind = t.kind === 'group' ? 'group' : m.attachment?.kind === 'file' ? 'file' : 'direct';
    const prefs = this.prefs({ kind: 'user', userId: user });
    if (!(kind === 'group' ? prefs.groups : kind === 'file' ? prefs.files : prefs.direct)) return;
    if (this.context.foreground && this.context.viewing === t.id) return; // they are looking at it
    const clan = this.clans.get(t.clanId)?.name ?? 'CLAN';
    const preview = m.attachment?.kind === 'file' ? `Sent ${t.kind === 'direct' ? 'you ' : ''}a file: ${m.attachment.name}` : m.body.replace(/\s+/g, ' ').slice(0, 140);
    const body = prefs.previews ? preview : kind === 'file' ? 'Sent you a file' : kind === 'direct' ? 'Sent you a message' : 'New message';
    const n: DeliveredNotice = { id: randomUUID(), userId: user, title: t.kind === 'direct' ? `${m.authorName} · ${clan}` : `${m.authorName} in ${clan}`, body,
      ref: { module: 'chat', entityId: m.id }, createdAt: this.now(), kind, threadId: t.id, clanId: t.clanId, alert: !this.focused };
    if (kind === 'group') {
      const last = this.lastAlert.get(t.id) ?? 0;
      if (this.now() - last < GROUP_COALESCE_MS) n.alert = false; // count, don't ping, for a busy group
      else if (n.alert) this.lastAlert.set(t.id, this.now());
    }
    this.db.prepare('INSERT INTO notify_notices (id, user_id, kind, title, body, ref_module, ref_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(n.id, user, kind, n.title, n.body, 'chat', m.id, t.id, n.createdAt);
    this.onNotice(n);
  }
}

// Notifications consumer (core/contracts.ts `Notifications`). Producers only publish events; this module decides what
// this device's person is told. Privacy first: a host device stores and relays direct conversations between other
// members, but nothing about them ever becomes a notice here — only conversations this person is part of.
import { randomUUID } from 'node:crypto';
import type { Db, ModuleSchema } from '../../core/db.ts';
import type { EventBus } from '../../core/events.ts';
import { userOf, type Principal } from '../../core/permissions.ts';
import type { Notice, Notifications as NotificationsContract } from '../../core/contracts.ts';
import { MessageCreated, type Chat } from '../chat/index.ts';
import type { Clans } from '../clans/index.ts';

export const schema: ModuleSchema = {
  module: 'notifications', prefix: 'notify',
  migrations: [`
    CREATE TABLE notify_notices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('group','direct','file')),
      title TEXT NOT NULL, body TEXT NOT NULL, ref_module TEXT, ref_id TEXT, thread_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER);
    CREATE INDEX notify_notices_user ON notify_notices(user_id, read_at, created_at);
    CREATE TABLE notify_prefs (user_id TEXT PRIMARY KEY, groups INTEGER NOT NULL DEFAULT 1, direct INTEGER NOT NULL DEFAULT 1,
      files INTEGER NOT NULL DEFAULT 1, previews INTEGER NOT NULL DEFAULT 0);
  `],
};

export type NoticePrefs = { groups: boolean; direct: boolean; files: boolean; previews: boolean };
export type NoticeContext = { foreground: boolean; viewing: string | null; focus: boolean };
export type DeliveredNotice = Notice & { kind: 'group' | 'direct' | 'file'; threadId: string; clanId: string; alert: boolean };
/** Group conversations alert at most this often per conversation (the rest only count as unread). */
const GROUP_COALESCE_MS = 60_000;

export class Notifications implements NotificationsContract {
  private db: Db; private chat: Chat; private clans: Clans; private localUser: () => string; private now: () => number;
  private lastAlert = new Map<string, number>();
  context: NoticeContext = { foreground: false, viewing: null, focus: false };
  /** The host app shows OS/in-app notices through this sink. */
  onNotice: (n: DeliveredNotice) => void = () => {};

  constructor(db: Db, bus: EventBus, chat: Chat, clans: Clans, localUser: () => string, now = () => Date.now()) {
    this.db = db; this.chat = chat; this.clans = clans; this.localUser = localUser; this.now = now;
    bus.subscribe('notifications.chat', MessageCreated, (e) => this.onMessage(e.payload.messageId));
  }

  prefs(p: Principal): NoticePrefs {
    const r = this.db.prepare('SELECT groups, direct, files, previews FROM notify_prefs WHERE user_id = ?').get(userOf(p)) as Record<keyof NoticePrefs, number> | undefined;
    return { groups: !!(r?.groups ?? 1), direct: !!(r?.direct ?? 1), files: !!(r?.files ?? 1), previews: !!(r?.previews ?? 0) };
  }
  setPrefs(p: Principal, next: Partial<NoticePrefs>) {
    const v = { ...this.prefs(p), ...next };
    this.db.prepare(`INSERT INTO notify_prefs (user_id, groups, direct, files, previews) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET groups = excluded.groups, direct = excluded.direct, files = excluded.files, previews = excluded.previews`)
      .run(userOf(p), +v.groups, +v.direct, +v.files, +v.previews);
    return v;
  }

  list(p: Principal, o: { unreadOnly?: boolean } = {}): Notice[] {
    return (this.db.prepare(`SELECT id, user_id userId, title, body, ref_module m, ref_id r, created_at createdAt FROM notify_notices WHERE user_id = ? ${o.unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`)
      .all(userOf(p)) as unknown as (Notice & { m: string | null; r: string | null })[]).map(({ m, r, ...n }) => ({ ...n, ...(m && r ? { ref: { module: m, entityId: r } } : {}) }));
  }
  markRead(p: Principal, id: string) { this.db.prepare('UPDATE notify_notices SET read_at = ? WHERE id = ? AND user_id = ?').run(this.now(), id, userOf(p)); }
  /** Opening a conversation clears its notices. */
  markThreadRead(p: Principal, threadId: string) { this.db.prepare('UPDATE notify_notices SET read_at = ? WHERE thread_id = ? AND user_id = ? AND read_at IS NULL').run(this.now(), threadId, userOf(p)); }

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
      ref: { module: 'chat', entityId: m.id }, createdAt: this.now(), kind, threadId: t.id, clanId: t.clanId, alert: !this.context.focus };
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

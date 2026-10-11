// Chat: CLAN group conversations and direct conversations between members of one CLAN.
// The same tables serve two roles: on the host device they are the authority (the host assigns `seq`, the per-thread
// order); on member devices they cache what the host delivered (history, offline reading) and hold the Outbox of messages
// not yet acknowledged. People are CLAN-scoped handles (see @classroom/protocol chat.ts), never device keys. Attachments
// reference resources by id — no file bytes ever live here. Message ids are globally unique and client-chosen, so a
// retried send is recognised instead of duplicated.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EDIT_WINDOW_MS, REACTIONS, tableSection, type CheckpointProvider, type ChatAttachment, type ChatCursors, type ChatMessageView, type ChatThreadView } from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import type { Permissions, Principal, Scope } from '../../core/permissions.ts';
import type { SearchProvider } from '../../core/search.ts';

export const schema: ModuleSchema = {
  module: 'chat', prefix: 'chat',
  migrations: [`
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, clan_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('group','direct')),
      pair TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE (clan_id, kind, pair));
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES chat_threads(id), seq INTEGER NOT NULL,
      author TEXT NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT, attachment TEXT,
      created_at INTEGER NOT NULL, edited_at INTEGER, removed_at INTEGER, removed_by TEXT CHECK (removed_by IN ('author','host')),
      UNIQUE (thread_id, seq));
    CREATE TABLE chat_reactions (message_id TEXT NOT NULL REFERENCES chat_messages(id), author TEXT NOT NULL, reaction TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (message_id, author, reaction));
    CREATE TABLE chat_cursors (thread_id TEXT NOT NULL REFERENCES chat_threads(id), handle TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread_id, handle));
    -- Last known display name per handle (direct conversations outlive sessions) and this device's own handle per CLAN.
    CREATE TABLE chat_names (clan_id TEXT NOT NULL, handle TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (clan_id, handle));
    CREATE TABLE chat_me (clan_id TEXT PRIMARY KEY, handle TEXT NOT NULL);
    -- Sender side: messages not yet acknowledged by the host. Survives restarts; retried with the same id.
    CREATE TABLE chat_outbox (id TEXT PRIMARY KEY, clan_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX chat_outbox_clan ON chat_outbox(clan_id, created_at);
  `],
};

const ids = { messageId: z.string(), threadId: z.string(), clanId: z.string() };
/** No message text in events: consumers that need it (search) read it through the module and its scopes. */
export const MessageCreated = defineEvent('MessageCreated', 1, z.object({ ...ids, kind: z.enum(['group', 'direct']), author: z.string(), seq: z.number().int() }));
export const MessageEdited = defineEvent('MessageEdited', 1, z.object(ids));
export const MessageRemoved = defineEvent('MessageRemoved', 1, z.object({ ...ids, by: z.enum(['author', 'host']) }));
export const ReactionChanged = defineEvent('ReactionChanged', 1, z.object({ ...ids, author: z.string(), reaction: z.string(), on: z.boolean() }));
export const ResourceSentToMember = defineEvent('ResourceSentToMember', 1, z.object({ clanId: z.string(), resourceId: z.string(), threadId: z.string(), by: z.string(), to: z.array(z.string()) }));

export class ChatError extends Error {
  code: string; status: number;
  constructor(status: number, code: string, message: string) { super(message); this.name = 'ChatError'; this.status = status; this.code = code; }
}

type Thread = { id: string; clanId: string; kind: 'group' | 'direct'; pair: string[] };
type TRow = { id: string; clan_id: string; kind: 'group' | 'direct'; pair: string; created_at: number };
type MRow = { id: string; thread_id: string; seq: number; author: string; author_name: string; body: string; reply_to: string | null; attachment: string | null;
  created_at: number; edited_at: number | null; removed_at: number | null; removed_by: 'author' | 'host' | null };
const toThread = (r: TRow): Thread => ({ id: r.id, clanId: r.clan_id, kind: r.kind, pair: r.pair ? r.pair.split('|') : [] });

export class Chat {
  private db: Db; private bus: EventBus; private perms: Permissions; private now: () => number; private localUser: () => string;
  private clanAvailable: (clanId: string) => boolean;
  private hostGate: (clanId: string) => string | null = () => null;
  /** Persistent hosting: a reason this device may not make authoritative writes to a CLAN (paused, handed over, conflicted
   *  or revoked host), or null. Member-side caching is never gated. */
  guardHostWrites(f: (clanId: string) => string | null) { this.hostGate = f; }
  private hostWrite(clanId: string) { const why = this.hostGate(clanId); if (why) throw new ChatError(503, 'host_unavailable', why); }
  constructor(db: Db, bus: EventBus, perms: Permissions, now = () => Date.now(), localUser: () => string = () => '', clanAvailable: (clanId: string) => boolean = () => true) {
    this.db = db; this.bus = bus; this.perms = perms; this.now = now; this.localUser = localUser;
    this.clanAvailable = clanAvailable;
  }

  /** Persistent hosting: the authoritative conversation of one CLAN (threads, messages, reactions, read positions,
   *  names). Device-local rows (this device's handle, its Outbox) are never carried; attachments are Files/server bytes. */
  checkpointProvider(): CheckpointProvider {
    const IN_THREADS = 'thread_id IN (SELECT id FROM chat_threads WHERE clan_id = ?)';
    const rows = tableSection(this.db, [
      { table: 'chat_threads', where: 'clan_id = ?', scope: { clan_id: 'clan' } },
      { table: 'chat_messages', where: IN_THREADS, scope: { thread_id: { table: 'chat_threads', column: 'id' } } },
      { table: 'chat_reactions', where: `message_id IN (SELECT id FROM chat_messages WHERE ${IN_THREADS})`, scope: { message_id: { table: 'chat_messages', column: 'id' } } },
      { table: 'chat_cursors', where: IN_THREADS, scope: { thread_id: { table: 'chat_threads', column: 'id' } } },
      { table: 'chat_names', where: 'clan_id = ?', scope: { clan_id: 'clan' } },
    ]);
    return { section: 'chat', export: (clanId) => ({ rows: rows.export(clanId), files: [] }), validate: (clanId, raw) => { rows.validate(clanId, raw); return []; }, import: (clanId, raw) => rows.import(clanId, raw) };
  }

  // ---- threads ----
  /** Lifecycle coordinator only; attachment bytes belong to Files, not Chat. */
  forgetClan(clanId: string) {
    const ids = (this.db.prepare('SELECT id FROM chat_threads WHERE clan_id = ?').all(clanId) as { id: string }[]).map((r) => r.id);
    tx(this.db, () => {
      for (const id of ids) {
        this.db.prepare('DELETE FROM chat_reactions WHERE message_id IN (SELECT id FROM chat_messages WHERE thread_id = ?)').run(id);
        this.db.prepare('DELETE FROM chat_cursors WHERE thread_id = ?').run(id);
        this.db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(id);
        this.db.prepare('DELETE FROM chat_threads WHERE id = ?').run(id);
      }
      for (const table of ['chat_names', 'chat_me', 'chat_outbox']) this.db.prepare(`DELETE FROM ${table} WHERE clan_id = ?`).run(clanId);
    });
    return ids;
  }
  thread(id: string): Thread | null { const r = this.db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id) as TRow | undefined; return r ? toThread(r) : null; }
  groupThread(clanId: string, id?: string): Thread { return this.ensureThread(clanId, 'group', '', id); }
  directThread(clanId: string, a: string, b: string, id?: string): Thread {
    if (a === b) throw new ChatError(400, 'invalid', 'A conversation needs two people.');
    return this.ensureThread(clanId, 'direct', [a, b].sort().join('|'), id);
  }
  private ensureThread(clanId: string, kind: 'group' | 'direct', pair: string, id?: string): Thread {
    this.db.prepare('INSERT OR IGNORE INTO chat_threads (id, clan_id, kind, pair, created_at) VALUES (?, ?, ?, ?, ?)').run(id ?? randomUUID(), clanId, kind, pair, this.now());
    return toThread(this.db.prepare('SELECT * FROM chat_threads WHERE clan_id = ? AND kind = ? AND pair = ?').get(clanId, kind, pair) as TRow);
  }
  /** Group threads are readable by every CLAN member (the caller checks membership); direct ones only by their pair. */
  canRead(t: Thread, handle: string) { return t.kind === 'group' || t.pair.includes(handle); }

  setName(clanId: string, handle: string, name: string) {
    this.db.prepare('INSERT INTO chat_names (clan_id, handle, name) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET name = excluded.name').run(clanId, handle, name.slice(0, 80));
  }
  setMe(clanId: string, handle: string) { this.assertAvailable(clanId); this.db.prepare('INSERT INTO chat_me (clan_id, handle) VALUES (?, ?) ON CONFLICT DO UPDATE SET handle = excluded.handle').run(clanId, handle); }
  me(clanId: string) { return (this.db.prepare('SELECT handle h FROM chat_me WHERE clan_id = ?').get(clanId) as { h: string } | undefined)?.h ?? null; }

  /** Threads `handle` can read in this CLAN, newest activity first (the group conversation always exists). */
  threads(clanId: string, handle: string): ChatThreadView[] {
    this.groupThread(clanId);
    const rows = this.db.prepare(`SELECT t.*, coalesce((SELECT max(seq) FROM chat_messages m WHERE m.thread_id = t.id), 0) last_seq,
        coalesce((SELECT max(created_at) FROM chat_messages m WHERE m.thread_id = t.id), t.created_at) updated
      FROM chat_threads t WHERE t.clan_id = ? AND (t.kind = 'group' OR instr('|' || t.pair || '|', ?) > 0) ORDER BY updated DESC`)
      .all(clanId, `|${handle}|`) as (TRow & { last_seq: number; updated: number })[];
    return rows.map((r) => this.view(toThread(r), handle, r.last_seq, r.updated));
  }
  threadView(t: Thread, handle: string): ChatThreadView {
    const r = this.db.prepare('SELECT coalesce(max(seq), 0) s, coalesce(max(created_at), 0) u FROM chat_messages WHERE thread_id = ?').get(t.id) as { s: number; u: number };
    return this.view(t, handle, r.s, r.u);
  }
  private view(t: Thread, handle: string, lastSeq: number, updatedAt: number): ChatThreadView {
    const readSeq = (this.db.prepare('SELECT read FROM chat_cursors WHERE thread_id = ? AND handle = ?').get(t.id, handle) as { read: number } | undefined)?.read ?? 0;
    const unread = (this.db.prepare('SELECT count(*) n FROM chat_messages WHERE thread_id = ? AND seq > ? AND author <> ? AND removed_at IS NULL').get(t.id, readSeq, handle) as { n: number }).n;
    const other = t.kind === 'direct' ? t.pair.find((h) => h !== handle) ?? null : null;
    const name = other && (this.db.prepare('SELECT name FROM chat_names WHERE clan_id = ? AND handle = ?').get(t.clanId, other) as { name: string } | undefined)?.name;
    return { id: t.id, kind: t.kind, clanId: t.clanId, with: other ? { handle: other, name: name ?? 'Someone', here: false } : null, lastSeq, readSeq, unread, updatedAt };
  }

  // ---- messages (host: authority) ----
  /** Stores a message and assigns its place in the thread. The same id again (a retry) returns the stored message. */
  post(o: { id: string; threadId: string; author: string; authorName: string; body: string; replyTo?: string | null; attachment?: ChatAttachment | null }): { message: ChatMessageView; created: boolean } {
    return tx(this.db, () => {
      const t = this.thread(o.threadId);
      if (!t) throw new ChatError(404, 'not_found', 'No such conversation.');
      this.hostWrite(t.clanId);
      const prev = this.row(o.id);
      if (prev) {
        if (prev.author !== o.author || prev.thread_id !== o.threadId) throw new ChatError(409, 'conflict', 'That message id is already used.');
        return { message: this.full(prev), created: false };
      }
      if (o.replyTo) { const r = this.row(o.replyTo); if (!r || r.thread_id !== o.threadId) throw new ChatError(400, 'bad_reply', 'You can only reply to a message in this conversation.'); }
      const seq = (this.db.prepare('SELECT coalesce(max(seq), 0) + 1 s FROM chat_messages WHERE thread_id = ?').get(o.threadId) as { s: number }).s;
      this.db.prepare(`INSERT INTO chat_messages (id, thread_id, seq, author, author_name, body, reply_to, attachment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(o.id, o.threadId, seq, o.author, o.authorName.slice(0, 80), o.body, o.replyTo ?? null, o.attachment ? JSON.stringify(o.attachment) : null, this.now());
      this.setName(t.clanId, o.author, o.authorName);
      this.bus.publish(MessageCreated, 'chat', { messageId: o.id, threadId: t.id, clanId: t.clanId, kind: t.kind, author: o.author, seq });
      return { message: this.full(this.row(o.id)!), created: true };
    });
  }

  get(id: string) { const r = this.row(id); return r ? this.full(r) : null; }
  private row(id: string) { return this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as MRow | undefined; }

  /** A page of a thread in order. `before`: older history (scrolling up); `after`: catching up after a reconnect. */
  page(threadId: string, o: { before?: number; after?: number; limit?: number } = {}): ChatMessageView[] {
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const rows = o.after !== undefined
      ? this.db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(threadId, o.after, limit) as MRow[]
      : (this.db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(threadId, o.before ?? Number.MAX_SAFE_INTEGER, limit) as MRow[]).reverse();
    return rows.map((r) => this.full(r));
  }

  edit(id: string, author: string, body: string): ChatMessageView {
    const r = this.row(id);
    if (!r || r.author !== author) throw new ChatError(403, 'forbidden', 'You can only edit your own messages.');
    this.hostWrite(this.thread(r.thread_id)!.clanId);
    if (r.removed_at) throw new ChatError(409, 'removed', 'That message was removed.');
    if (this.now() - r.created_at > EDIT_WINDOW_MS) throw new ChatError(409, 'too_late', 'Messages can only be edited for 15 minutes.');
    this.db.prepare('UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?').run(body, this.now(), id);
    this.bus.publish(MessageEdited, 'chat', { messageId: id, threadId: r.thread_id, clanId: this.thread(r.thread_id)!.clanId });
    return this.get(id)!;
  }

  /** Never a silent rewrite: the message keeps its place and says it was removed, and by whom. */
  remove(id: string, by: { handle: string; moderator: boolean }): ChatMessageView {
    const r = this.row(id);
    const t = r && this.thread(r.thread_id);
    if (!r || !t) throw new ChatError(404, 'not_found', 'No such message.');
    this.hostWrite(t.clanId);
    const role = r.author === by.handle ? 'author' : by.moderator && t.kind === 'group' ? 'host' : null;
    if (!role) throw new ChatError(403, 'forbidden', 'You can only remove your own messages.');
    if (!r.removed_at) tx(this.db, () => {
      this.db.prepare("UPDATE chat_messages SET body = '', attachment = NULL, removed_at = ?, removed_by = ? WHERE id = ?").run(this.now(), role, id);
      this.db.prepare('DELETE FROM chat_reactions WHERE message_id = ?').run(id);
      this.bus.publish(MessageRemoved, 'chat', { messageId: id, threadId: t.id, clanId: t.clanId, by: role });
    });
    return this.get(id)!;
  }

  /** Idempotent toggle: (message, person, reaction) exists at most once. Returns whether anything changed. */
  react(id: string, handle: string, reaction: string, on: boolean): { message: ChatMessageView; changed: boolean } {
    const r = this.row(id);
    if (!r || r.removed_at) throw new ChatError(404, 'not_found', 'No such message.');
    this.hostWrite(this.thread(r.thread_id)!.clanId);
    if (!(REACTIONS as readonly string[]).includes(reaction)) throw new ChatError(400, 'invalid', 'Unknown reaction.');
    const res = on
      ? this.db.prepare('INSERT OR IGNORE INTO chat_reactions (message_id, author, reaction, created_at) VALUES (?, ?, ?, ?)').run(id, handle, reaction, this.now())
      : this.db.prepare('DELETE FROM chat_reactions WHERE message_id = ? AND author = ? AND reaction = ?').run(id, handle, reaction);
    if (res.changes) this.bus.publish(ReactionChanged, 'chat', { messageId: id, threadId: r.thread_id, clanId: this.thread(r.thread_id)!.clanId, author: handle, reaction, on });
    return { message: this.get(id)!, changed: res.changes > 0 };
  }

  /** Cursors only move forward and never past the last message. */
  cursor(threadId: string, handle: string, c: { delivered?: number; read?: number }): ChatCursors {
    const last = (this.db.prepare('SELECT coalesce(max(seq), 0) s FROM chat_messages WHERE thread_id = ?').get(threadId) as { s: number }).s;
    const read = Math.min(c.read ?? 0, last), delivered = Math.min(Math.max(c.delivered ?? 0, read), last);
    this.db.prepare(`INSERT INTO chat_cursors (thread_id, handle, delivered, read) VALUES (?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET delivered = max(delivered, excluded.delivered), read = max(read, excluded.read)`).run(threadId, handle, delivered, read);
    return this.cursors(threadId);
  }
  cursors(threadId: string): ChatCursors {
    const rows = this.db.prepare('SELECT handle, delivered, read FROM chat_cursors WHERE thread_id = ?').all(threadId) as { handle: string; delivered: number; read: number }[];
    return Object.fromEntries(rows.map((r) => [r.handle, { delivered: r.delivered, read: r.read }]));
  }

  // ---- member device: cache of what the host delivered ----
  /** Idempotent: stores (or updates) messages by id. Returns the ids that were new on this device. */
  ingest(t: ChatThreadView, me: string, messages: ChatMessageView[]): string[] {
    this.assertAvailable(t.clanId); // delayed socket/history responses must not recreate a removed cache
    return tx(this.db, () => {
      this.setMe(t.clanId, me);
      if (t.with) this.setName(t.clanId, t.with.handle, t.with.name);
      const local = t.kind === 'group' ? this.groupThread(t.clanId, t.id) : this.directThread(t.clanId, me, t.with!.handle, t.id);
      if (local.id !== t.id) throw new ChatError(409, 'conflict', 'Conversation id mismatch.');
      const fresh: string[] = [];
      for (const m of messages) {
        if (m.threadId !== t.id) continue;
        const had = this.row(m.id);
        if (had) {
          this.db.prepare('UPDATE chat_messages SET body = ?, attachment = ?, edited_at = ?, removed_at = ?, removed_by = ? WHERE id = ?')
            .run(m.body, m.attachment ? JSON.stringify(m.attachment) : null, m.editedAt, m.removed?.at ?? null, m.removed?.by ?? null, m.id);
        } else {
          // A stale cached row at this seq (host database replaced) yields to the host's message.
          this.db.prepare('DELETE FROM chat_reactions WHERE message_id IN (SELECT id FROM chat_messages WHERE thread_id = ? AND seq = ?)').run(t.id, m.seq);
          this.db.prepare('DELETE FROM chat_messages WHERE thread_id = ? AND seq = ?').run(t.id, m.seq);
          this.db.prepare(`INSERT INTO chat_messages (id, thread_id, seq, author, author_name, body, reply_to, attachment, created_at, edited_at, removed_at, removed_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.id, t.id, m.seq, m.author, m.authorName.slice(0, 80), m.body, m.replyTo, m.attachment ? JSON.stringify(m.attachment) : null,
            m.createdAt, m.editedAt, m.removed?.at ?? null, m.removed?.by ?? null);
          this.setName(t.clanId, m.author, m.authorName);
          fresh.push(m.id);
          this.bus.publish(MessageCreated, 'chat', { messageId: m.id, threadId: t.id, clanId: t.clanId, kind: t.kind, author: m.author, seq: m.seq });
        }
        this.db.prepare('DELETE FROM chat_reactions WHERE message_id = ?').run(m.id);
        for (const r of m.reactions) for (const by of r.by) this.db.prepare('INSERT OR IGNORE INTO chat_reactions (message_id, author, reaction, created_at) VALUES (?, ?, ?, ?)').run(m.id, by, r.reaction, m.createdAt);
      }
      return fresh;
    });
  }
  markRead(threadId: string, me: string, seq: number) { this.cursor(threadId, me, { read: seq, delivered: seq }); }

  // ---- Outbox (sender device) ----
  queue(clanId: string, payload: { id: string } & Record<string, unknown>) {
    this.assertAvailable(clanId);
    this.db.prepare('INSERT OR IGNORE INTO chat_outbox (id, clan_id, payload, created_at) VALUES (?, ?, ?, ?)').run(payload.id, clanId, JSON.stringify(payload), this.now());
  }
  outbox(clanId: string): Record<string, unknown>[] {
    return (this.db.prepare('SELECT payload FROM chat_outbox WHERE clan_id = ? ORDER BY created_at LIMIT 500').all(clanId) as { payload: string }[]).map((r) => JSON.parse(r.payload));
  }
  sent(id: string) { this.db.prepare('DELETE FROM chat_outbox WHERE id = ?').run(id); }
  private assertAvailable(clanId: string) { if (!this.clanAvailable(clanId)) throw new ChatError(403, 'clan_removed', 'This CLAN copy is removed or awaiting cleanup.'); }

  // ---- local reading (this device's person) ----
  /** Conversations this device's person can read in a CLAN they belong to (offline view; host and member devices alike). */
  localThreads(p: Principal, clanId: string): ChatThreadView[] {
    const me = this.me(clanId);
    if (!me || !this.perms.canRead(p, { kind: 'clan', clanId }) || !this.perms.agentMay(p, 'chat')) return [];
    return this.threads(clanId, me);
  }
  localPage(p: Principal, threadId: string, o: { before?: number; limit?: number } = {}): ChatMessageView[] {
    const t = this.thread(threadId), me = t && this.me(t.clanId);
    if (!t || !me || !this.canRead(t, me) || !this.perms.canRead(p, { kind: 'clan', clanId: t.clanId }) || !this.perms.agentMay(p, 'chat')) return [];
    return this.page(threadId, o);
  }

  /** Files sent to this device's person in direct conversations (newest first) — the Backpack's "received". */
  receivedFiles(p: Principal, limit = 100): (ChatMessageView & { clanId: string })[] {
    const rows = this.db.prepare(`SELECT m.*, t.clan_id clan FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id JOIN chat_me me ON me.clan_id = t.clan_id
      WHERE t.kind = 'direct' AND m.attachment IS NOT NULL AND m.removed_at IS NULL AND m.author <> me.handle AND instr('|' || t.pair || '|', '|' || me.handle || '|') > 0
      ORDER BY m.created_at DESC LIMIT ?`).all(limit) as (MRow & { clan: string })[];
    return rows.filter((r) => this.perms.canRead(p, { kind: 'clan', clanId: r.clan }) && this.perms.agentMay(p, 'chat'))
      .map((r) => ({ ...this.full(r), clanId: r.clan })).filter((m) => m.attachment?.kind === 'file');
  }

  /** Who may find a message in search: the CLAN for group messages; only this device's person, if a participant, for direct ones. */
  searchProvider(): SearchProvider {
    const doc = (id: string) => {
      const r = this.row(id), t = r && this.thread(r.thread_id);
      if (!r || !t || r.removed_at || !r.body) return null;
      const me = this.me(t.clanId);
      const scopes: Scope[] = t.kind === 'group' ? [{ kind: 'clan', clanId: t.clanId }] : me && t.pair.includes(me) && this.localUser() ? [{ kind: 'personal', ownerId: this.localUser() }] : [];
      return scopes.length ? { entityId: r.id, title: r.author_name, body: r.body, updatedAt: r.edited_at ?? r.created_at, scopes } : null;
    };
    return {
      module: 'chat',
      events: [MessageCreated, MessageEdited, MessageRemoved].map((def) => ({ def: def as never, entityId: (e: never) => (e as { messageId: string }).messageId })),
      one: doc,
      all: () => (this.db.prepare('SELECT id FROM chat_messages WHERE removed_at IS NULL ORDER BY created_at DESC LIMIT 20000').all() as { id: string }[]).map((r) => doc(r.id)).filter((d) => !!d),
    };
  }

  /** Is `userId` this device's person and a participant of the message's conversation? (notifications, privacy) */
  concernsLocal(messageId: string): { message: ChatMessageView; thread: Thread; me: string } | null {
    const r = this.row(messageId), t = r && this.thread(r.thread_id), me = t && this.me(t.clanId);
    if (!r || !t || !me || !this.canRead(t, me) || !this.perms.canRead({ kind: 'user', userId: this.localUser() }, { kind: 'clan', clanId: t.clanId })) return null;
    return { message: this.full(r), thread: t, me };
  }

  private full(r: MRow): ChatMessageView {
    const rx = this.db.prepare('SELECT reaction, author FROM chat_reactions WHERE message_id = ? ORDER BY created_at').all(r.id) as { reaction: string; author: string }[];
    const reactions = REACTIONS.map((reaction) => ({ reaction, by: rx.filter((x) => x.reaction === reaction).map((x) => x.author) })).filter((x) => x.by.length);
    return {
      id: r.id, threadId: r.thread_id, seq: r.seq, author: r.author, authorName: r.author_name, body: r.body, replyTo: r.reply_to,
      attachment: r.attachment ? JSON.parse(r.attachment) as ChatAttachment : null, createdAt: r.created_at, editedAt: r.edited_at,
      removed: r.removed_at ? { by: r.removed_by ?? 'author', at: r.removed_at } : null, reactions,
    };
  }
}


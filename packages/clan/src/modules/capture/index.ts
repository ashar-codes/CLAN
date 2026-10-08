// Capture Inbox: everything quickly captured (note, link, text/idea, file) lands in Personal Space › Inbox first.
// The Inbox holds pointers only: each item IS a canonical note, saved link or file reference, created through its own
// module. Filing moves or shares that canonical item (no copies); nothing leaves Personal Space until filed into a CLAN.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Principal } from '../../core/permissions.ts';
import type { Clans } from '../clans/index.ts';
import type { Files } from '../files/index.ts';
import type { Notes } from '../notes/index.ts';
import { SavedItemChanged, type Saved } from '../saved/index.ts';
import type { Courses } from '../courses/index.ts';
import { rowProvider, type SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'capture', prefix: 'capture',
  migrations: [`
    CREATE TABLE capture_items (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('note','link','text','file')),
      module TEXT NOT NULL CHECK (module IN ('notes','saved','files')), entity_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      filed_at INTEGER, filed_to TEXT, UNIQUE (module, entity_id));
    CREATE INDEX capture_items_inbox ON capture_items(owner_id, filed_at, created_at);
  `],
};

export const CaptureItemCreated = defineEvent('CaptureItemCreated', 1, z.object({ itemId: z.string(), ownerId: z.string(), kind: z.enum(['note', 'link', 'text', 'file']) }));

export type CaptureInput =
  | { kind: 'note'; title?: string; body?: string }
  | { kind: 'link'; url: string; title?: string; note?: string; tags?: string[]; collectionId?: string }
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string; name: string; mime?: string };
/** `course`: filed into one of your Courses (optionally a topic) as a reference — still private. */
export type CaptureTarget = { kind: 'collection'; collectionId: string } | { kind: 'clan'; clanId: string } | { kind: 'course'; courseId: string; topicId?: string | null } | { kind: 'done' };
export type InboxItem = { id: string; kind: CaptureInput['kind']; title: string; detail: string; module: 'notes' | 'saved' | 'files'; entityId: string; createdAt: number };

type Row = { id: string; owner_id: string; kind: InboxItem['kind']; module: InboxItem['module']; entity_id: string; created_at: number };

export class Capture {
  private db: Db; private bus: EventBus; private m: { clans: Clans; files: Files; notes: Notes; saved: Saved; courses: Courses }; private now: () => number;
  constructor(db: Db, bus: EventBus, m: { clans: Clans; files: Files; notes: Notes; saved: Saved; courses: Courses }, now = () => Date.now()) {
    this.db = db; this.bus = bus; this.m = m; this.now = now;
    // Moving a captured link to a collection in Saved files it, wherever that happened.
    bus.subscribe('capture.saved', SavedItemChanged, (e) => {
      const it = this.db.prepare("SELECT owner_id FROM capture_items WHERE module = 'saved' AND entity_id = ? AND filed_at IS NULL").get(e.payload.itemId) as { owner_id: string } | undefined;
      if (!it) return;
      const s = this.m.saved.get({ kind: 'user', userId: it.owner_id }, e.payload.itemId);
      if (s && s.collectionId !== this.m.saved.inbox({ kind: 'user', userId: it.owner_id })) this.mark(e.payload.itemId, 'saved', { kind: 'collection', collectionId: s.collectionId });
    }, { persistent: true });
  }

  /** Personal sync: the inbox entries (what they point at syncs with its own module). */
  syncProviders(): SyncProvider[] { return [rowProvider(this.db, { kind: 'capture', policy: 'lww', table: 'capture_items', owner: 'owner_id' })]; }

  /** Captures straight into a course (and topic) when given; otherwise into the Inbox. */
  async capture(p: Principal, input: CaptureInput, into?: { courseId: string; topicId?: string | null }): Promise<InboxItem> {
    if (into) this.m.courses.mine(p, into.courseId); // fail before creating anything
    if (p.kind !== 'user') throw new Error('Only you can capture into your Inbox.');
    let module: InboxItem['module'], entityId: string;
    switch (input.kind) {
      case 'note': ({ id: entityId } = this.m.notes.create(p, { title: input.title?.trim() || 'Untitled', body: input.body })); module = 'notes'; break;
      case 'text': {
        const text = z.string().trim().min(1).max(20_000).parse(input.text);
        ({ id: entityId } = this.m.notes.create(p, { title: text.split('\n')[0]!.slice(0, 80), body: text })); module = 'notes'; break;
      }
      case 'link': ({ id: entityId } = this.m.saved.add(p, { url: input.url, title: input.title, note: input.note, tags: input.tags, collectionId: input.collectionId })); module = 'saved'; break;
      case 'file': ({ refId: entityId } = await this.m.files.add(p, input.path, input.name, { kind: 'personal', ownerId: p.userId }, input.mime)); module = 'files'; break;
    }
    const id = randomUUID();
    // The same canonical item captured twice stays one Inbox entry (e.g. a deduplicated file).
    this.db.prepare('INSERT OR IGNORE INTO capture_items (id, owner_id, kind, module, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, p.userId, input.kind, module, entityId, this.now());
    const row = this.db.prepare('SELECT * FROM capture_items WHERE module = ? AND entity_id = ?').get(module, entityId) as Row;
    if (row.id === id) this.bus.publish(CaptureItemCreated, 'capture', { itemId: id, ownerId: p.userId, kind: input.kind });
    if (input.kind === 'link' && input.collectionId && input.collectionId !== this.m.saved.inbox(p)) this.mark(entityId, 'saved', { kind: 'collection', collectionId: input.collectionId });
    if (into) this.file(p, row.id, { kind: 'course', ...into });
    return this.describe(row)!;
  }

  /** Unfiled captures, newest first. Items whose canonical object is gone drop out. */
  inbox(p: Principal, limit = 200): InboxItem[] {
    const rows = this.db.prepare('SELECT * FROM capture_items WHERE owner_id = ? AND filed_at IS NULL ORDER BY created_at DESC LIMIT ?').all(userOf(p), limit) as Row[];
    return rows.map((r) => this.describe(r)).filter((x): x is InboxItem => !!x);
  }

  /** Files an Inbox item: moves a link to a collection, or shares the canonical item into a CLAN (a reference, not a copy). */
  file(p: Principal, itemId: string, to: CaptureTarget) {
    if (p.kind !== 'user') throw new Error('Not allowed.');
    const r = this.db.prepare('SELECT * FROM capture_items WHERE id = ? AND owner_id = ?').get(itemId, p.userId) as Row | undefined;
    if (!r) throw new Error('Not found.');
    if (to.kind === 'collection') {
      if (r.module !== 'saved') throw new Error('Collections hold links. Share notes and files into a CLAN instead.');
      this.m.saved.move(p, r.entity_id, to.collectionId);
    } else if (to.kind === 'course') {
      this.m.courses.link(p, to.courseId, { module: r.module, entityId: r.entity_id, topicId: to.topicId ?? null });
    } else if (to.kind === 'clan') {
      const clan = this.m.clans.get(to.clanId);
      if (!clan || !this.m.clans.isActiveMember(clan.id, p.userId)) throw new Error('You can only file into your CLANs.');
      if (r.module === 'saved') this.m.saved.share(p, r.entity_id, clan.id);
      else if (r.module === 'notes') this.m.notes.share(p, r.entity_id, clan.id);
      else this.m.files.share(p, r.entity_id, { kind: 'clan', clanId: clan.id });
    }
    this.mark(r.entity_id, r.module, to);
  }

  private mark(entityId: string, module: string, to: CaptureTarget) {
    this.db.prepare('UPDATE capture_items SET filed_at = ?, filed_to = ? WHERE module = ? AND entity_id = ? AND filed_at IS NULL').run(this.now(), JSON.stringify(to), module, entityId);
  }

  private describe(r: Row): InboxItem | null {
    const p = { kind: 'user' as const, userId: r.owner_id };
    const base = { id: r.id, kind: r.kind, module: r.module, entityId: r.entity_id, createdAt: r.created_at };
    if (r.module === 'notes') { const n = this.m.notes.get(p, r.entity_id); return n && { ...base, title: n.title, detail: n.body.slice(0, 160) }; }
    if (r.module === 'saved') { const s = this.m.saved.get(p, r.entity_id); return s && { ...base, title: s.title, detail: s.url }; }
    const f = this.m.files.list(p, { kind: 'personal', ownerId: r.owner_id }).find((x) => x.refId === r.entity_id);
    return f ? { ...base, title: f.name, detail: `${f.size} bytes` } : null;
  }
}

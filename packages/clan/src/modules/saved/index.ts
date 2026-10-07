// Saved: links + metadata only (title, source, URL, preview URL, note, tags). Nothing is downloaded or copied.
// Private by default; sharing an item into a CLAN adds a reference.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Permissions, type Principal, type Scope } from '../../core/permissions.ts';
import type { SearchProvider } from '../../core/search.ts';
import type { ContextProvider } from '../../core/context.ts';

export const schema: ModuleSchema = {
  module: 'saved', prefix: 'saved',
  migrations: [`
    CREATE TABLE saved_collections (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('inbox','watch-later','custom')), created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX saved_collections_builtin ON saved_collections(owner_id, kind) WHERE kind <> 'custom';
    CREATE TABLE saved_items (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, collection_id TEXT NOT NULL REFERENCES saved_collections(id),
      url TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, preview_url TEXT, note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX saved_items_owner ON saved_items(owner_id, collection_id);
    CREATE TABLE saved_shares (item_id TEXT NOT NULL REFERENCES saved_items(id), clan_id TEXT NOT NULL, shared_by TEXT NOT NULL, shared_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, clan_id));
  `],
};

export const SavedItemAdded = defineEvent('SavedItemAdded', 1, z.object({ itemId: z.string(), ownerId: z.string(), collectionId: z.string() }));
export const SavedItemChanged = defineEvent('SavedItemChanged', 1, z.object({ itemId: z.string() }));
export const SavedItemShared = defineEvent('SavedItemShared', 1, z.object({ itemId: z.string(), clanId: z.string(), shared: z.boolean() }));

export type Collection = { id: string; name: string; kind: 'inbox' | 'watch-later' | 'custom'; count: number };
export type SavedItem = { id: string; ownerId: string; collectionId: string; url: string; title: string; source: string; previewUrl: string | null; note: string; tags: string[]; createdAt: number; sharedWith: string[] };

const Url = z.string().trim().max(2048).refine((u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } }, 'Only http(s) links can be saved.');
const Tags = z.array(z.string().trim().min(1).max(40).regex(/^[^\s#]+$/)).max(20);
type Raw = { id: string; owner_id: string; collection_id: string; url: string; title: string; source: string; preview_url: string | null; note: string; tags: string; created_at: number };

export class Saved {
  private db: Db; private bus: EventBus; private perms: Permissions; private now: () => number;
  constructor(db: Db, bus: EventBus, perms: Permissions, now = () => Date.now()) { this.db = db; this.bus = bus; this.perms = perms; this.now = now; }

  collections(p: Principal): Collection[] {
    const u = this.ensureDefaults(userOf(p));
    return this.db.prepare(`SELECT c.id, c.name, c.kind, (SELECT count(*) FROM saved_items i WHERE i.collection_id = c.id) count FROM saved_collections c
      WHERE c.owner_id = ? ORDER BY CASE c.kind WHEN 'inbox' THEN 0 WHEN 'watch-later' THEN 1 ELSE 2 END, c.created_at`).all(u) as Collection[];
  }
  createCollection(p: Principal, name: string) {
    const u = this.writer(p), id = randomUUID();
    this.db.prepare("INSERT INTO saved_collections (id, owner_id, name, kind, created_at) VALUES (?, ?, ?, 'custom', ?)").run(id, u, z.string().trim().min(1).max(60).parse(name), this.now());
    return id;
  }
  inbox(p: Principal) { this.ensureDefaults(userOf(p)); return (this.db.prepare("SELECT id FROM saved_collections WHERE owner_id = ? AND kind = 'inbox'").get(userOf(p)) as { id: string }).id; }

  add(p: Principal, o: { url: string; title?: string; note?: string; tags?: string[]; previewUrl?: string; collectionId?: string }): SavedItem {
    const u = this.writer(p);
    const url = Url.parse(o.url), host = new URL(url).hostname.replace(/^www\./, '');
    const col = o.collectionId ?? this.inbox(p);
    this.ownCollection(u, col);
    const id = randomUUID(), t = this.now();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO saved_items (id, owner_id, collection_id, url, title, source, preview_url, note, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, u, col, url, z.string().trim().max(300).parse(o.title ?? '') || host, host, o.previewUrl ? Url.parse(o.previewUrl) : null, z.string().max(5000).parse(o.note ?? ''), JSON.stringify(Tags.parse(o.tags ?? [])), t, t);
      this.bus.publish(SavedItemAdded, 'saved', { itemId: id, ownerId: u, collectionId: col });
    });
    return this.get(p, id)!;
  }
  move(p: Principal, itemId: string, collectionId: string) {
    const u = this.writer(p);
    this.ownCollection(u, collectionId);
    if (!this.db.prepare('UPDATE saved_items SET collection_id = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(collectionId, this.now(), itemId, u).changes) throw new Error('Not found.');
    this.bus.publish(SavedItemChanged, 'saved', { itemId });
  }
  share(p: Principal, itemId: string, clanId: string, shared = true) {
    const u = this.writer(p);
    if (!this.db.prepare('SELECT 1 FROM saved_items WHERE id = ? AND owner_id = ?').get(itemId, u)) throw new Error('Not found.');
    if (shared && !this.perms.canRead(p, { kind: 'clan', clanId })) throw new Error('You can only share into your CLANs.');
    tx(this.db, () => {
      if (shared) this.db.prepare('INSERT OR IGNORE INTO saved_shares (item_id, clan_id, shared_by, shared_at) VALUES (?, ?, ?, ?)').run(itemId, clanId, u, this.now());
      else this.db.prepare('DELETE FROM saved_shares WHERE item_id = ? AND clan_id = ?').run(itemId, clanId);
      this.bus.publish(SavedItemShared, 'saved', { itemId, clanId, shared });
    });
  }

  get(p: Principal, id: string): SavedItem | null {
    const r = this.db.prepare('SELECT * FROM saved_items WHERE id = ?').get(id) as Raw | undefined;
    if (!r || !this.perms.agentMay(p, 'saved')) return null;
    const it = this.full(r);
    return it.ownerId === userOf(p) || it.sharedWith.some((c) => this.perms.canRead(p, { kind: 'clan', clanId: c })) ? it : null;
  }
  items(p: Principal, collectionId?: string): SavedItem[] {
    if (!this.perms.agentMay(p, 'saved')) return [];
    return (this.db.prepare(`SELECT * FROM saved_items WHERE owner_id = ? ${collectionId ? 'AND collection_id = ?' : ''} ORDER BY created_at DESC LIMIT 500`)
      .all(...[userOf(p), ...(collectionId ? [collectionId] : [])]) as Raw[]).map((r) => this.full(r));
  }
  inClan(p: Principal, clanId: string): SavedItem[] {
    if (!this.perms.canRead(p, { kind: 'clan', clanId }) || !this.perms.agentMay(p, 'saved')) return [];
    return (this.db.prepare('SELECT i.* FROM saved_items i JOIN saved_shares s ON s.item_id = i.id WHERE s.clan_id = ? ORDER BY s.shared_at DESC').all(clanId) as Raw[]).map((r) => this.full(r));
  }

  searchProvider(): SearchProvider {
    const doc = (r: Raw) => { const i = this.full(r); return { entityId: i.id, title: i.title, body: `${i.source} ${i.url} ${i.note} ${i.tags.map((t) => `#${t}`).join(' ')}`, updatedAt: i.createdAt, scopes: [{ kind: 'personal', ownerId: i.ownerId } as Scope, ...i.sharedWith.map((clanId): Scope => ({ kind: 'clan', clanId }))] }; };
    return {
      module: 'saved',
      events: [SavedItemAdded, SavedItemChanged, SavedItemShared].map((def) => ({ def: def as never, entityId: (e: never) => (e as { itemId: string }).itemId })),
      one: (id) => { const r = this.db.prepare('SELECT * FROM saved_items WHERE id = ?').get(id) as Raw | undefined; return r ? doc(r) : null; },
      all: () => (this.db.prepare('SELECT * FROM saved_items').all() as Raw[]).map(doc),
    };
  }
  contextProvider(): ContextProvider {
    return {
      module: 'saved', sensitivity: 'normal',
      read: (userId, req) => {
        const q = req.query?.toLowerCase();
        return this.items({ kind: 'user', userId }).filter((i) => (!req.ids || req.ids.includes(i.id)) && (!q || `${i.title} ${i.note} ${i.tags.join(' ')}`.toLowerCase().includes(q)))
          .slice(0, req.limit ?? 20).map((i) => ({ module: 'saved', entityId: i.id, title: i.title, excerpt: `${i.url}${i.note ? ` — ${i.note.slice(0, 200)}` : ''}`, scope: { kind: 'personal', ownerId: userId } }));
      },
    };
  }

  private ensureDefaults(u: string) {
    const ins = this.db.prepare('INSERT OR IGNORE INTO saved_collections (id, owner_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)');
    ins.run(randomUUID(), u, 'Inbox', 'inbox', this.now());
    ins.run(randomUUID(), u, 'Watch Later', 'watch-later', this.now());
    return u;
  }
  private ownCollection(u: string, id: string) { if (!this.db.prepare('SELECT 1 FROM saved_collections WHERE id = ? AND owner_id = ?').get(id, u)) throw new Error('Not found.'); }
  private writer(p: Principal) { if (p.kind !== 'user') throw new Error('Agents cannot change Saved.'); return p.userId; }
  private full(r: Raw): SavedItem {
    const sharedWith = (this.db.prepare('SELECT clan_id c FROM saved_shares WHERE item_id = ?').all(r.id) as { c: string }[]).map((x) => x.c);
    return { id: r.id, ownerId: r.owner_id, collectionId: r.collection_id, url: r.url, title: r.title, source: r.source, previewUrl: r.preview_url, note: r.note, tags: JSON.parse(r.tags) as string[], createdAt: r.created_at, sharedWith };
  }
}

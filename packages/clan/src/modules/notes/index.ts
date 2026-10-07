// Notes. Private to their owner (Personal Space) until the owner shares them into a CLAN; a share is a reference
// (notes_shares), so the CLAN always sees the current note and unsharing removes access.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Permissions, type Principal, type Scope } from '../../core/permissions.ts';
import type { SearchProvider } from '../../core/search.ts';
import type { ContextProvider } from '../../core/context.ts';
import type { Clans } from '../clans/index.ts';

export const schema: ModuleSchema = {
  module: 'notes', prefix: 'notes',
  migrations: [`
    CREATE TABLE notes_notes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE INDEX notes_notes_owner ON notes_notes(owner_id, updated_at);
    CREATE TABLE notes_shares (note_id TEXT NOT NULL REFERENCES notes_notes(id), clan_id TEXT NOT NULL, shared_by TEXT NOT NULL, shared_at INTEGER NOT NULL,
      PRIMARY KEY (note_id, clan_id));
    CREATE INDEX notes_shares_clan ON notes_shares(clan_id);
  `],
};

const Id = z.object({ noteId: z.string() });
export const NoteCreated = defineEvent('NoteCreated', 1, Id.extend({ ownerId: z.string() }));
export const NoteUpdated = defineEvent('NoteUpdated', 1, Id);
export const NoteShared = defineEvent('NoteShared', 1, Id.extend({ clanId: z.string(), shared: z.boolean() }));

export type Note = { id: string; ownerId: string; title: string; body: string; createdAt: number; updatedAt: number; sharedWith: string[] };
type Raw = { id: string; owner_id: string; title: string; body: string; created_at: number; updated_at: number };
const Title = z.string().trim().max(200);
const Body = z.string().max(200_000);

export class Notes {
  private db: Db; private bus: EventBus; private perms: Permissions; private clans: Clans; private now: () => number;
  constructor(db: Db, bus: EventBus, perms: Permissions, clans: Clans, now = () => Date.now()) { this.db = db; this.bus = bus; this.perms = perms; this.clans = clans; this.now = now; }

  create(p: Principal, o: { title: string; body?: string }): Note {
    const owner = this.writer(p);
    const t = this.now(), id = randomUUID();
    tx(this.db, () => {
      this.db.prepare('INSERT INTO notes_notes (id, owner_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, owner, Title.parse(o.title) || 'Untitled', Body.parse(o.body ?? ''), t, t);
      this.bus.publish(NoteCreated, 'notes', { noteId: id, ownerId: owner });
    });
    return this.get(p, id)!;
  }

  update(p: Principal, id: string, o: { title?: string; body?: string }) {
    const n = this.own(p, id);
    tx(this.db, () => {
      this.db.prepare('UPDATE notes_notes SET title = ?, body = ?, updated_at = ? WHERE id = ?').run(o.title === undefined ? n.title : Title.parse(o.title) || 'Untitled', o.body === undefined ? n.body : Body.parse(o.body), this.now(), id);
      this.bus.publish(NoteUpdated, 'notes', { noteId: id });
    });
    return this.get(p, id)!;
  }

  remove(p: Principal, id: string) {
    this.own(p, id);
    tx(this.db, () => {
      this.db.prepare('UPDATE notes_notes SET deleted_at = ? WHERE id = ?').run(this.now(), id);
      this.db.prepare('DELETE FROM notes_shares WHERE note_id = ?').run(id);
      this.bus.publish(NoteUpdated, 'notes', { noteId: id });
    });
  }

  share(p: Principal, id: string, clanId: string, shared = true) {
    this.own(p, id);
    if (shared && (!this.perms.canRead(p, { kind: 'clan', clanId }) || !this.clans.has(clanId, 'notes'))) throw new Error('You can only share notes into your CLANs that use notes.');
    tx(this.db, () => {
      if (shared) this.db.prepare('INSERT OR IGNORE INTO notes_shares (note_id, clan_id, shared_by, shared_at) VALUES (?, ?, ?, ?)').run(id, clanId, userOf(p), this.now());
      else this.db.prepare('DELETE FROM notes_shares WHERE note_id = ? AND clan_id = ?').run(id, clanId);
      this.bus.publish(NoteShared, 'notes', { noteId: id, clanId, shared });
    });
  }

  /** A note is readable by its owner and by active members of a CLAN it is shared into. */
  get(p: Principal, id: string): Note | null {
    if (!this.perms.agentMay(p, 'notes')) return null;
    const r = this.db.prepare('SELECT * FROM notes_notes WHERE id = ? AND deleted_at IS NULL').get(id) as Raw | undefined;
    if (!r) return null;
    const n = this.full(r);
    return n.ownerId === userOf(p) || n.sharedWith.some((c) => this.perms.canRead(p, { kind: 'clan', clanId: c })) ? n : null;
  }
  mine(p: Principal, limit = 50): Note[] {
    if (!this.perms.agentMay(p, 'notes')) return [];
    return (this.db.prepare('SELECT * FROM notes_notes WHERE owner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?').all(userOf(p), limit) as Raw[]).map((r) => this.full(r));
  }
  inClan(p: Principal, clanId: string): Note[] {
    if (!this.perms.canRead(p, { kind: 'clan', clanId }) || !this.perms.agentMay(p, 'notes')) return [];
    return (this.db.prepare('SELECT n.* FROM notes_notes n JOIN notes_shares s ON s.note_id = n.id WHERE s.clan_id = ? AND n.deleted_at IS NULL ORDER BY n.updated_at DESC').all(clanId) as Raw[]).map((r) => this.full(r));
  }

  searchProvider(): SearchProvider {
    const doc = (r: Raw) => { const n = this.full(r); return { entityId: n.id, title: n.title, body: n.body, updatedAt: n.updatedAt, scopes: [{ kind: 'personal', ownerId: n.ownerId } as Scope, ...n.sharedWith.map((clanId): Scope => ({ kind: 'clan', clanId }))] }; };
    return {
      module: 'notes',
      events: [NoteCreated, NoteUpdated, NoteShared].map((def) => ({ def: def as never, entityId: (e: never) => (e as { noteId: string }).noteId })),
      one: (id) => { const r = this.db.prepare('SELECT * FROM notes_notes WHERE id = ? AND deleted_at IS NULL').get(id) as Raw | undefined; return r ? doc(r) : null; },
      all: () => (this.db.prepare('SELECT * FROM notes_notes WHERE deleted_at IS NULL').all() as Raw[]).map(doc),
    };
  }
  contextProvider(): ContextProvider {
    return {
      module: 'notes', sensitivity: 'normal',
      read: (userId, req) => {
        const p: Principal = { kind: 'user', userId };
        const pool = req.ids ? req.ids.map((id) => this.get(p, id)).filter((n): n is Note => !!n) : this.mine(p, 200);
        const q = req.query?.toLowerCase();
        return pool.filter((n) => !q || `${n.title}\n${n.body}`.toLowerCase().includes(q)).slice(0, req.limit ?? 20)
          .map((n) => ({ module: 'notes', entityId: n.id, title: n.title, excerpt: n.body.slice(0, 280), scope: n.ownerId === userId ? { kind: 'personal', ownerId: userId } as Scope : { kind: 'clan', clanId: n.sharedWith.find((c) => this.perms.canRead(p, { kind: 'clan', clanId: c }))! } }));
      },
    };
  }

  private full(r: Raw): Note {
    const sharedWith = (this.db.prepare('SELECT clan_id c FROM notes_shares WHERE note_id = ?').all(r.id) as { c: string }[]).map((x) => x.c);
    return { id: r.id, ownerId: r.owner_id, title: r.title, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at, sharedWith };
  }
  private writer(p: Principal) { if (p.kind !== 'user') throw new Error('Agents cannot write notes.'); return p.userId; }
  private own(p: Principal, id: string) {
    const r = this.db.prepare('SELECT * FROM notes_notes WHERE id = ? AND deleted_at IS NULL').get(id) as Raw | undefined;
    if (!r || r.owner_id !== this.writer(p)) throw new Error('Not found.');
    return r;
  }
}

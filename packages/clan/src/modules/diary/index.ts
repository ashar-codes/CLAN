// Diary: owner-only. No sharing, no search, no events carrying content. AI context is DENIED unless the owner grants
// it explicitly (core_grants 'ai' → 'diary'); even then only the owner's own entries are returned.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, ModuleSchema } from '../../core/db.ts';
import type { Principal } from '../../core/permissions.ts';
import type { ContextProvider } from '../../core/context.ts';

export const schema: ModuleSchema = {
  module: 'diary', prefix: 'diary',
  migrations: [`
    CREATE TABLE diary_entries (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, day TEXT NOT NULL, mood TEXT, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (owner_id, day));
  `],
};

export const MOODS = ['calm', 'tired', 'proud', 'anxious', 'low', 'happy'] as const;
export type Entry = { id: string; day: string; mood: (typeof MOODS)[number] | null; body: string; updatedAt: number };
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export class Diary {
  private db: Db; private now: () => number;
  constructor(db: Db, now = () => Date.now()) { this.db = db; this.now = now; }

  /** One entry per day; writing again replaces that day's text. */
  write(p: Principal, o: { day: string; body: string; mood?: Entry['mood'] }): Entry {
    const owner = this.owner(p);
    const t = this.now();
    this.db.prepare(`INSERT INTO diary_entries (id, owner_id, day, mood, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner_id, day) DO UPDATE SET mood = excluded.mood, body = excluded.body, updated_at = excluded.updated_at`)
      .run(randomUUID(), owner, Day.parse(o.day), o.mood ? z.enum(MOODS).parse(o.mood) : null, z.string().max(100_000).parse(o.body), t, t);
    return this.day(p, o.day)!;
  }
  day(p: Principal, day: string): Entry | null {
    return (this.db.prepare('SELECT id, day, mood, body, updated_at updatedAt FROM diary_entries WHERE owner_id = ? AND day = ?').get(this.owner(p), Day.parse(day)) as Entry | undefined) ?? null;
  }
  recent(p: Principal, limit = 14): Entry[] {
    return this.db.prepare('SELECT id, day, mood, body, updated_at updatedAt FROM diary_entries WHERE owner_id = ? ORDER BY day DESC LIMIT ?').all(this.owner(p), limit) as Entry[];
  }

  /** Registered with the broker as `private`: the broker denies before this runs unless a grant exists. */
  contextProvider(): ContextProvider {
    return {
      module: 'diary', sensitivity: 'private',
      read: (userId, req) => this.recent({ kind: 'user', userId }, req.limit ?? 7)
        .map((e) => ({ module: 'diary', entityId: e.id, title: e.day, excerpt: e.body.slice(0, 280), scope: { kind: 'personal', ownerId: userId } })),
    };
  }

  /** Users only — an agent principal is refused here even if a context grant exists. */
  private owner(p: Principal) { if (p.kind !== 'user') throw new Error('Diary is private.'); return p.userId; }
}

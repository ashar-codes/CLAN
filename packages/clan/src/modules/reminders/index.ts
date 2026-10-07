// Reminders point at things (any module's entity) by reference; they never copy what they remind about.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Principal } from '../../core/permissions.ts';

export const schema: ModuleSchema = {
  module: 'reminders', prefix: 'reminders',
  migrations: [`
    CREATE TABLE reminders_reminders (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, text TEXT NOT NULL, due_at INTEGER NOT NULL,
      target_module TEXT, target_id TEXT, done_at INTEGER, created_at INTEGER NOT NULL, CHECK ((target_module IS NULL) = (target_id IS NULL)));
    CREATE INDEX reminders_due ON reminders_reminders(owner_id, done_at, due_at);
  `],
};

export const ReminderCreated = defineEvent('ReminderCreated', 1, z.object({ reminderId: z.string(), ownerId: z.string(), dueAt: z.number().int() }));
export type Reminder = { id: string; text: string; dueAt: number; target: { module: string; id: string } | null; doneAt: number | null };
type Raw = { id: string; text: string; due_at: number; target_module: string | null; target_id: string | null; done_at: number | null };
const toR = (r: Raw): Reminder => ({ id: r.id, text: r.text, dueAt: r.due_at, target: r.target_module ? { module: r.target_module, id: r.target_id! } : null, doneAt: r.done_at });

export class Reminders {
  private db: Db; private bus: EventBus; private now: () => number;
  constructor(db: Db, bus: EventBus, now = () => Date.now()) { this.db = db; this.bus = bus; this.now = now; }

  create(p: Principal, o: { text: string; dueAt: number; target?: { module: string; id: string } }): Reminder {
    if (p.kind !== 'user') throw new Error('Agents cannot create reminders.');
    const id = randomUUID();
    const target = o.target && z.object({ module: z.string().regex(/^[a-z]{2,20}$/), id: z.string().min(1).max(100) }).parse(o.target);
    tx(this.db, () => {
      this.db.prepare('INSERT INTO reminders_reminders (id, owner_id, text, due_at, target_module, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.userId, z.string().trim().min(1).max(300).parse(o.text), z.number().int().positive().parse(o.dueAt), target?.module ?? null, target?.id ?? null, this.now());
      this.bus.publish(ReminderCreated, 'reminders', { reminderId: id, ownerId: p.userId, dueAt: o.dueAt });
    });
    return this.upcoming(p, Number.MAX_SAFE_INTEGER).find((r) => r.id === id)!;
  }
  done(p: Principal, id: string) { this.db.prepare('UPDATE reminders_reminders SET done_at = ? WHERE id = ? AND owner_id = ?').run(this.now(), id, userOf(p)); }
  /** Open reminders due before `until` (overdue first). */
  upcoming(p: Principal, until = this.now() + 14 * 86_400_000): Reminder[] {
    if (p.kind === 'agent' && !p.scopes.includes('reminders:read')) return [];
    return (this.db.prepare('SELECT * FROM reminders_reminders WHERE owner_id = ? AND done_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT 100').all(userOf(p), until) as Raw[]).map(toR);
  }
}

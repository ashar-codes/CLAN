// Reminders point at things (any module's entity) by reference; they never copy what they remind about.
// Recurrence is deliberately small (daily / weekly / monthly), computed from the first occurrence (`anchor_at`) so
// clamped months never drift. Completing a recurring reminder moves it to its next occurrence; snoozing only delays the
// current one. `fire()` emits ReminderDue once per occurrence.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { nextOccurrence, RECURRENCES, type Recurrence } from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Principal } from '../../core/permissions.ts';
import { rowProvider, type SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'reminders', prefix: 'reminders',
  migrations: [`
    CREATE TABLE reminders_reminders (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, text TEXT NOT NULL, due_at INTEGER NOT NULL,
      target_module TEXT, target_id TEXT, done_at INTEGER, created_at INTEGER NOT NULL, CHECK ((target_module IS NULL) = (target_id IS NULL)));
    CREATE INDEX reminders_due ON reminders_reminders(owner_id, done_at, due_at);
  `, `
    ALTER TABLE reminders_reminders ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly','monthly'));
    ALTER TABLE reminders_reminders ADD COLUMN anchor_at INTEGER;
    ALTER TABLE reminders_reminders ADD COLUMN snoozed_until INTEGER;
    ALTER TABLE reminders_reminders ADD COLUMN dismissed_at INTEGER;
    ALTER TABLE reminders_reminders ADD COLUMN fired_at INTEGER;
    UPDATE reminders_reminders SET anchor_at = due_at;
    CREATE INDEX reminders_fire ON reminders_reminders(done_at, due_at);
  `],
};

export const ReminderCreated = defineEvent('ReminderCreated', 1, z.object({ reminderId: z.string(), ownerId: z.string(), dueAt: z.number().int() }));
export const ReminderDue = defineEvent('ReminderDue', 1, z.object({ reminderId: z.string(), ownerId: z.string(), at: z.number().int() }));
export type Reminder = { id: string; text: string; dueAt: number; target: { module: string; id: string } | null; doneAt: number | null;
  recurrence: Recurrence; anchorAt: number; snoozedUntil: number | null; dismissedAt: number | null; /** when it actually rings next */ at: number };
type Raw = { id: string; owner_id: string; text: string; due_at: number; target_module: string | null; target_id: string | null; done_at: number | null;
  recurrence: Recurrence; anchor_at: number | null; snoozed_until: number | null; dismissed_at: number | null; fired_at: number | null };
const toR = (r: Raw): Reminder => ({ id: r.id, text: r.text, dueAt: r.due_at, target: r.target_module ? { module: r.target_module, id: r.target_id! } : null, doneAt: r.done_at,
  recurrence: r.recurrence, anchorAt: r.anchor_at ?? r.due_at, snoozedUntil: r.snoozed_until, dismissedAt: r.dismissed_at, at: r.snoozed_until ?? r.due_at });

export class Reminders {
  private db: Db; private bus: EventBus; private now: () => number;
  constructor(db: Db, bus: EventBus, now = () => Date.now()) { this.db = db; this.bus = bus; this.now = now; }

  /** Personal sync: newest edit wins (the other version is kept for review); whether it already rang is per device. */
  syncProviders(): SyncProvider[] { return [rowProvider(this.db, { kind: 'reminder', policy: 'lww', table: 'reminders_reminders', owner: 'owner_id', exclude: ['fired_at'] })]; }

  create(p: Principal, o: { text: string; dueAt: number; target?: { module: string; id: string }; recurrence?: Recurrence }): Reminder {
    if (p.kind !== 'user') throw new Error('Agents cannot create reminders.');
    const id = randomUUID();
    const target = o.target && z.object({ module: z.string().regex(/^[a-z]{2,20}$/), id: z.string().min(1).max(100) }).parse(o.target);
    const due = z.number().int().positive().parse(o.dueAt);
    tx(this.db, () => {
      this.db.prepare('INSERT INTO reminders_reminders (id, owner_id, text, due_at, anchor_at, recurrence, target_module, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.userId, z.string().trim().min(1).max(300).parse(o.text), due, due, z.enum(RECURRENCES).parse(o.recurrence ?? 'none'), target?.module ?? null, target?.id ?? null, this.now());
      this.bus.publish(ReminderCreated, 'reminders', { reminderId: id, ownerId: p.userId, dueAt: due });
    });
    return this.get(p, id)!;
  }
  get(p: Principal, id: string) { const r = this.db.prepare('SELECT * FROM reminders_reminders WHERE id = ? AND owner_id = ?').get(id, userOf(p)) as Raw | undefined; return r ? toR(r) : null; }
  private must(p: Principal, id: string) { const r = this.db.prepare('SELECT * FROM reminders_reminders WHERE id = ? AND owner_id = ?').get(id, userOf(p)) as Raw | undefined; if (!r) throw new Error('Reminder not found.'); return r; }

  /** Done: a one-off closes; a recurring one moves to its next occurrence after now (missed ones are not replayed). */
  done(p: Principal, id: string) { this.advance(this.must(p, id), 'done'); }
  /** Dismiss this occurrence (same as done, but recorded as dismissed). */
  dismiss(p: Principal, id: string) { this.advance(this.must(p, id), 'dismissed'); }
  private advance(r: Raw, how: 'done' | 'dismissed') {
    const t = this.now(), next = nextOccurrence(r.anchor_at ?? r.due_at, r.recurrence, Math.max(t, r.due_at));
    if (next) this.db.prepare('UPDATE reminders_reminders SET due_at = ?, snoozed_until = NULL, fired_at = NULL WHERE id = ?').run(next, r.id);
    else this.db.prepare(`UPDATE reminders_reminders SET done_at = ?, ${how === 'dismissed' ? 'dismissed_at = ?,' : ''} snoozed_until = NULL WHERE id = ?`).run(...(how === 'dismissed' ? [t, t, r.id] : [t, r.id]));
  }
  /** Delay the current occurrence; the schedule itself is unchanged. */
  snooze(p: Principal, id: string, until: number) {
    const r = this.must(p, id);
    if (r.done_at) throw new Error('That reminder is closed.');
    this.db.prepare('UPDATE reminders_reminders SET snoozed_until = ?, fired_at = NULL WHERE id = ?').run(z.number().int().min(this.now()).parse(until), r.id);
  }
  remove(p: Principal, id: string) { this.must(p, id); this.db.prepare('DELETE FROM reminders_reminders WHERE id = ?').run(id); }

  /** Open reminders ringing before `until` (overdue first). */
  upcoming(p: Principal, until = this.now() + 14 * 86_400_000): Reminder[] {
    if (p.kind === 'agent' && !p.scopes.includes('reminders:read')) return [];
    return (this.db.prepare('SELECT * FROM reminders_reminders WHERE owner_id = ? AND done_at IS NULL AND coalesce(snoozed_until, due_at) <= ? ORDER BY coalesce(snoozed_until, due_at) LIMIT 200').all(userOf(p), until) as Raw[]).map(toR);
  }
  /** Open reminders in [from, to] (calendar), recurring ones expanded within the window. */
  between(p: Principal, from: number, to: number): Reminder[] {
    const rows = (this.db.prepare('SELECT * FROM reminders_reminders WHERE owner_id = ? AND done_at IS NULL AND coalesce(snoozed_until, due_at) <= ? ORDER BY due_at LIMIT 200').all(userOf(p), to) as Raw[]).map(toR);
    const out: Reminder[] = [];
    for (const r of rows) {
      if (r.at >= from) out.push(r);
      let t = r.dueAt;
      for (let i = 0; i < 62 && r.recurrence !== 'none'; i++) { const n = nextOccurrence(r.anchorAt, r.recurrence, t); if (!n || n > to) break; t = n; if (n >= from) out.push({ ...r, at: n, snoozedUntil: null }); }
    }
    return out.sort((a, b) => a.at - b.at);
  }
  forTarget(p: Principal, module: string, id: string) { return (this.db.prepare('SELECT * FROM reminders_reminders WHERE owner_id = ? AND target_module = ? AND target_id = ? AND done_at IS NULL').all(userOf(p), module, id) as Raw[]).map(toR); }

  /** Emits ReminderDue once per occurrence for everything ringing by `now`. */
  fire(now = this.now()): { reminderId: string; ownerId: string; at: number }[] {
    const rows = this.db.prepare('SELECT * FROM reminders_reminders WHERE done_at IS NULL AND coalesce(snoozed_until, due_at) <= ? AND (fired_at IS NULL OR fired_at < coalesce(snoozed_until, due_at)) LIMIT 200').all(now) as Raw[];
    return rows.map((r) => {
      const at = r.snoozed_until ?? r.due_at;
      tx(this.db, () => {
        this.db.prepare('UPDATE reminders_reminders SET fired_at = ? WHERE id = ?').run(at, r.id);
        this.bus.publish(ReminderDue, 'reminders', { reminderId: r.id, ownerId: r.owner_id, at });
      });
      return { reminderId: r.id, ownerId: r.owner_id, at };
    });
  }
  text(id: string) { return (this.db.prepare('SELECT text, target_module m, target_id i FROM reminders_reminders WHERE id = ?').get(id) as { text: string; m: string | null; i: string | null } | undefined) ?? null; }
}

// Classroom assignments, projected — never turned into Tasks. The Assignment module (the classroom host) is the
// authority. On the host device this reads the classroom tables directly (classroom-read.ts). On a member device it
// keeps the last assignment list the host sent plus this member's own latest receipt, so Today/Course/Calendar can
// show them offline, clearly marked "Classroom assignment".
import { z } from 'zod';
import type { Db, ModuleSchema } from '../../core/db.ts';
import { userOf, type Principal } from '../../core/permissions.ts';
import type { Clans } from '../clans/index.ts';
import { hostAssignments } from './classroom-read.ts';

export const schema: ModuleSchema = {
  module: 'assignments', prefix: 'assign',
  migrations: [`
    CREATE TABLE assign_seen (clan_id TEXT NOT NULL, assignment_id TEXT NOT NULL, title TEXT NOT NULL, due_at INTEGER, closed INTEGER NOT NULL,
      submitted_at INTEGER, late INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL, PRIMARY KEY (clan_id, assignment_id));
    CREATE INDEX assign_seen_due ON assign_seen(due_at);
  `],
};

export type AssignmentItem = { id: string; clanId: string; title: string; dueAt: number | null; closed: boolean; role: 'host' | 'member';
  /** member: own state from the signed receipt; host: how many submitted */
  status: 'submitted' | 'late' | 'missing' | 'open'; submitted?: number };
const Seen = z.array(z.object({ id: z.string().max(64), title: z.string().max(200), dueAt: z.number().int().nullable(), closed: z.boolean(),
  latest: z.object({ payload: z.object({ submittedAt: z.number().int(), late: z.boolean() }) }).nullable() })).max(500);

export class Assignments {
  private db: Db; private clans: Clans; private now: () => number;
  constructor(db: Db, clans: Clans, now = () => Date.now()) { this.db = db; this.clans = clans; this.now = now; }

  /** Member device: replace this CLAN's projection with what the host just sent (its StudentAssignmentView list). */
  seen(p: Principal, clanId: string, list: unknown) {
    if (!this.clans.isActiveMember(clanId, userOf(p))) return;
    const items = Seen.parse(list), t = this.now();
    this.db.exec('SAVEPOINT assign_seen');
    try {
      this.db.prepare('DELETE FROM assign_seen WHERE clan_id = ?').run(clanId);
      for (const a of items) this.db.prepare('INSERT INTO assign_seen (clan_id, assignment_id, title, due_at, closed, submitted_at, late, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(clanId, a.id, a.title, a.dueAt, a.closed ? 1 : 0, a.latest?.payload.submittedAt ?? null, a.latest?.payload.late ? 1 : 0, t);
      this.db.exec('RELEASE assign_seen');
    } catch (e) { this.db.exec('ROLLBACK TO assign_seen'); this.db.exec('RELEASE assign_seen'); throw e; }
  }

  /** Lifecycle coordinator: discard only this CLAN's received projection. */
  forgetClan(clanId: string) { this.db.prepare('DELETE FROM assign_seen WHERE clan_id = ?').run(clanId); }

  /** Assignments of the Classroom CLANs this person belongs to (or one of them). */
  list(p: Principal, o: { clanId?: string; dueBefore?: number } = {}): AssignmentItem[] {
    const u = userOf(p);
    const clans = this.clans.list(u, { includeArchived: true }).filter((c) => c.type === 'CLASSROOM' && (!o.clanId || c.id === o.clanId));
    const out: AssignmentItem[] = [];
    for (const c of clans) {
      const host = this.clans.members(c.id).some((m) => m.userId === u && m.role === 'owner');
      if (host) for (const a of hostAssignments(this.db, this.clans.sessionsOf(c.id))) out.push({ ...a, clanId: c.id, role: 'host', status: a.closed ? 'submitted' : 'open' });
      else for (const r of this.db.prepare('SELECT * FROM assign_seen WHERE clan_id = ?').all(c.id) as { assignment_id: string; title: string; due_at: number | null; closed: number; submitted_at: number | null; late: number }[]) {
        out.push({ id: r.assignment_id, clanId: c.id, title: r.title, dueAt: r.due_at, closed: !!r.closed, role: 'member', status: r.submitted_at ? (r.late ? 'late' : 'submitted') : 'missing' });
      }
    }
    return out.filter((a) => o.dueBefore === undefined || (a.dueAt !== null && a.dueAt <= o.dueBefore)).sort((a, b) => (a.dueAt ?? 9e15) - (b.dueAt ?? 9e15));
  }
}

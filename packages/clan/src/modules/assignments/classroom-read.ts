// Read-only reader of the classroom `assignments` / `submissions` tables (the classroom host's authority). Host device only.
import { tableExists, type Db } from '../../core/db.ts';

export function hostAssignments(db: Db, sessionIds: string[]) {
  if (!sessionIds.length || !tableExists(db, 'assignments')) return [];
  return (db.prepare(`SELECT a.id, a.title, a.due_at dueAt, a.closed_at closedAt, (SELECT count(DISTINCT s.member_id) FROM submissions s WHERE s.assignment_id = a.id) submitted
    FROM assignments a WHERE a.session_id IN (SELECT value FROM json_each(?)) ORDER BY a.due_at LIMIT 200`).all(JSON.stringify(sessionIds)) as { id: string; title: string; dueAt: number | null; closedAt: number | null; submitted: number }[])
    .map((a) => ({ id: a.id, title: a.title, dueAt: a.dueAt, closed: a.closedAt !== null, submitted: a.submitted }));
}

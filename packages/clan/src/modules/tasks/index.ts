// Tasks: student task tracking (not project management). A task may belong to a course (and topic) or a CLAN, carry a
// small checklist and references to resources/notes/saved items. Classroom assignments are NOT tasks — they stay in the
// classroom and are projected (modules/assignments).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TASK_STATUSES, type TaskStatus } from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Principal, type Scope } from '../../core/permissions.ts';
import type { SearchProvider } from '../../core/search.ts';
import type { Courses } from '../courses/index.ts';
import { rowProvider, type SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'tasks', prefix: 'tasks',
  migrations: [`
    CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      course_id TEXT, topic_id TEXT, clan_id TEXT, due_at INTEGER, priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')), done_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX tasks_tasks_owner ON tasks_tasks(owner_id, status, due_at);
    CREATE INDEX tasks_tasks_course ON tasks_tasks(course_id, status);
    CREATE TABLE tasks_checklist (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks_tasks(id), text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL);
    CREATE TABLE tasks_refs (task_id TEXT NOT NULL REFERENCES tasks_tasks(id), module TEXT NOT NULL CHECK (module IN ('notes','files','saved')), entity_id TEXT NOT NULL, PRIMARY KEY (task_id, module, entity_id));
  `],
};

export const TaskChanged = defineEvent('TaskChanged', 1, z.object({ taskId: z.string(), ownerId: z.string(), status: z.enum(TASK_STATUSES) }));
export type Task = { id: string; title: string; description: string; courseId: string | null; topicId: string | null; clanId: string | null; dueAt: number | null;
  priority: 'low' | 'normal' | 'high'; status: TaskStatus; doneAt: number | null; checklist: { id: string; text: string; done: boolean }[]; refs: { module: string; entityId: string }[]; updatedAt: number };
type Raw = { id: string; owner_id: string; title: string; description: string; course_id: string | null; topic_id: string | null; clan_id: string | null; due_at: number | null; priority: Task['priority']; status: TaskStatus; done_at: number | null; updated_at: number };

export class Tasks {
  private db: Db; private bus: EventBus; private courses: Courses; private isMember: (clanId: string, userId: string) => boolean; private now: () => number;
  constructor(db: Db, bus: EventBus, courses: Courses, isMember: (clanId: string, userId: string) => boolean, now = () => Date.now()) { this.db = db; this.bus = bus; this.courses = courses; this.isMember = isMember; this.now = now; }

  /** Personal sync: newest edit wins (the other version is kept for review), with checklist and references. */
  syncProviders(): SyncProvider[] {
    return [rowProvider(this.db, { kind: 'task', policy: 'lww', table: 'tasks_tasks', owner: 'owner_id',
      children: [{ table: 'tasks_checklist', fk: 'task_id', key: 'id', order: 'position, id' }, { table: 'tasks_refs', fk: 'task_id', order: 'module, entity_id' }] })];
  }

  private owner(p: Principal) { if (p.kind !== 'user') throw new Error('Only you can change your tasks.'); return p.userId; }
  get(p: Principal, id: string): Task | null { const r = this.db.prepare('SELECT * FROM tasks_tasks WHERE id = ? AND owner_id = ?').get(id, userOf(p)) as Raw | undefined; return r ? this.full(r) : null; }
  private must(p: Principal, id: string) { const t = this.get(p, id); if (!t) throw new Error('Task not found.'); return t; }

  create(p: Principal, o: { title: string; description?: string; courseId?: string | null; topicId?: string | null; clanId?: string | null; dueAt?: number | null; priority?: Task['priority']; checklist?: string[] }): Task {
    const u = this.owner(p), id = randomUUID(), t = this.now();
    if (o.courseId) this.courses.mine(p, o.courseId);
    if (o.topicId && this.courses.topic(p, o.topicId).courseId !== o.courseId) throw new Error('Topic of another course.');
    if (o.clanId && !this.isMember(o.clanId, u)) throw new Error('Not a member of that CLAN.');
    tx(this.db, () => {
      this.db.prepare('INSERT INTO tasks_tasks (id, owner_id, title, description, course_id, topic_id, clan_id, due_at, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, u, z.string().trim().min(1).max(200).parse(o.title), z.string().max(5000).parse(o.description ?? ''), o.courseId ?? null, o.topicId ?? null, o.clanId ?? null, o.dueAt ?? null, z.enum(['low', 'normal', 'high']).parse(o.priority ?? 'normal'), t, t);
      (o.checklist ?? []).slice(0, 50).forEach((text, i) => this.db.prepare('INSERT INTO tasks_checklist (id, task_id, text, position) VALUES (?, ?, ?, ?)').run(randomUUID(), id, z.string().trim().min(1).max(200).parse(text), i));
      this.bus.publish(TaskChanged, 'tasks', { taskId: id, ownerId: u, status: 'todo' });
    });
    return this.must(p, id);
  }
  update(p: Principal, id: string, o: Partial<Pick<Task, 'title' | 'description' | 'dueAt' | 'priority'>>) {
    this.owner(p);
    const t = this.must(p, id);
    this.db.prepare('UPDATE tasks_tasks SET title = ?, description = ?, due_at = ?, priority = ?, updated_at = ? WHERE id = ?')
      .run(z.string().trim().min(1).max(200).parse(o.title ?? t.title), z.string().max(5000).parse(o.description ?? t.description), o.dueAt === undefined ? t.dueAt : o.dueAt, z.enum(['low', 'normal', 'high']).parse(o.priority ?? t.priority), this.now(), id);
    this.bus.publish(TaskChanged, 'tasks', { taskId: id, ownerId: userOf(p), status: t.status });
    return this.must(p, id);
  }
  /** TODO → IN_PROGRESS → DONE, or CANCELLED; DONE/CANCELLED can be reopened. */
  setStatus(p: Principal, id: string, status: TaskStatus) {
    this.owner(p);
    this.must(p, id);
    this.db.prepare('UPDATE tasks_tasks SET status = ?, done_at = ?, updated_at = ? WHERE id = ?').run(z.enum(TASK_STATUSES).parse(status), status === 'done' ? this.now() : null, this.now(), id);
    this.bus.publish(TaskChanged, 'tasks', { taskId: id, ownerId: userOf(p), status });
    return this.must(p, id);
  }
  check(p: Principal, taskId: string, itemId: string, done: boolean) { this.owner(p); this.must(p, taskId); this.db.prepare('UPDATE tasks_checklist SET done = ? WHERE id = ? AND task_id = ?').run(done ? 1 : 0, itemId, taskId); }
  addItem(p: Principal, taskId: string, text: string) {
    this.owner(p);
    this.must(p, taskId);
    const pos = (this.db.prepare('SELECT coalesce(max(position), -1) + 1 n FROM tasks_checklist WHERE task_id = ?').get(taskId) as { n: number }).n;
    this.db.prepare('INSERT INTO tasks_checklist (id, task_id, text, position) VALUES (?, ?, ?, ?)').run(randomUUID(), taskId, z.string().trim().min(1).max(200).parse(text), pos);
  }
  attach(p: Principal, taskId: string, module: 'notes' | 'files' | 'saved', entityId: string) { this.owner(p); this.must(p, taskId); if(!this.courses.canReference(p,module,entityId))throw new Error('Attachment not found or not allowed.'); this.db.prepare('INSERT OR IGNORE INTO tasks_refs (task_id, module, entity_id) VALUES (?, ?, ?)').run(taskId, module, entityId); }

  fileReferences(owner: string): string[] { return (this.db.prepare("SELECT r.entity_id id FROM tasks_refs r JOIN tasks_tasks e ON e.id=r.task_id WHERE e.owner_id=? AND r.module='files'").all(owner) as {id:string}[]).map(r=>r.id); }
  hasFileReference(id: string) { return !!this.db.prepare("SELECT 1 FROM tasks_refs WHERE module='files' AND entity_id=? LIMIT 1").get(id); }
  remove(p: Principal, id: string) { const owner=this.owner(p); this.must(p,id); tx(this.db,()=>{this.db.prepare('DELETE FROM tasks_refs WHERE task_id = ?').run(id);this.db.prepare('DELETE FROM tasks_checklist WHERE task_id = ?').run(id);this.db.prepare('DELETE FROM tasks_tasks WHERE id = ? AND owner_id = ?').run(id,owner);}); }

  /** Open tasks (or all) — by course, or due before a time. Indexed, bounded. */
  list(p: Principal, o: { courseId?: string; open?: boolean; dueBefore?: number; limit?: number } = {}): Task[] {
    if (p.kind === 'agent' && !p.scopes.includes('tasks:read')) return [];
    const rows = this.db.prepare(`SELECT * FROM tasks_tasks WHERE owner_id = ? ${o.courseId ? 'AND course_id = ?' : ''} ${o.open ? "AND status IN ('todo','in_progress')" : ''} ${o.dueBefore !== undefined ? 'AND due_at IS NOT NULL AND due_at <= ?' : ''}
      ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END, coalesce(due_at, 9e15), updated_at DESC LIMIT ?`)
      .all(...[userOf(p), ...(o.courseId ? [o.courseId] : []), ...(o.dueBefore !== undefined ? [o.dueBefore] : []), o.limit ?? 200]) as Raw[];
    return rows.map((r) => this.full(r));
  }
  /** Due between `from` and `to`, still open, for every owner (notification tick). */
  dueSoon(from: number, to: number) { return this.db.prepare("SELECT id, owner_id ownerId, title, due_at dueAt FROM tasks_tasks WHERE status IN ('todo','in_progress') AND due_at > ? AND due_at <= ? LIMIT 200").all(from, to) as { id: string; ownerId: string; title: string; dueAt: number }[]; }

  private full(r: Raw): Task {
    const checklist = (this.db.prepare('SELECT id, text, done FROM tasks_checklist WHERE task_id = ? ORDER BY position').all(r.id) as { id: string; text: string; done: number }[]).map((c) => ({ ...c, done: !!c.done }));
    const refs = (this.db.prepare('SELECT module, entity_id entityId FROM tasks_refs WHERE task_id = ?').all(r.id) as { module: string; entityId: string }[]);
    return { id: r.id, title: r.title, description: r.description, courseId: r.course_id, topicId: r.topic_id, clanId: r.clan_id, dueAt: r.due_at, priority: r.priority, status: r.status, doneAt: r.done_at, checklist, refs, updatedAt: r.updated_at };
  }
  searchProvider(): SearchProvider {
    const doc = (id: string) => { const r = this.db.prepare('SELECT * FROM tasks_tasks WHERE id = ?').get(id) as Raw | undefined; return r ? { entityId: r.id, title: r.title, body: r.description, updatedAt: r.updated_at, scopes: [{ kind: 'personal', ownerId: r.owner_id } as Scope] } : null; };
    return { module: 'tasks', events: [{ def: TaskChanged as never, entityId: (e: never) => (e as { taskId: string }).taskId }], one: doc, all: () => (this.db.prepare('SELECT id FROM tasks_tasks').all() as { id: string }[]).map((r) => doc(r.id)).filter((d) => !!d) };
  }
}

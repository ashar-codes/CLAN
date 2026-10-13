// Exams: date, place, the topics in scope, references to materials. Results (grade, reflection) exist only when the
// student enters them. Readiness is never estimated: see `prep()` — counts of the student's own topic marks.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EXAM_STATUSES, countdown, readiness, type ExamStatus } from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Principal, type Scope } from '../../core/permissions.ts';
import type { SearchProvider } from '../../core/search.ts';
import type { Courses, Topic } from '../courses/index.ts';
import { rowProvider, type SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'exams', prefix: 'exams',
  migrations: [`
    CREATE TABLE exams_exams (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, course_id TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL, location TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','completed','cancelled')), notes TEXT NOT NULL DEFAULT '',
      grade TEXT, total TEXT, reflection TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX exams_exams_owner ON exams_exams(owner_id, status, at);
    CREATE TABLE exams_topics (exam_id TEXT NOT NULL REFERENCES exams_exams(id), topic_id TEXT NOT NULL, PRIMARY KEY (exam_id, topic_id));
    CREATE TABLE exams_refs (exam_id TEXT NOT NULL REFERENCES exams_exams(id), module TEXT NOT NULL CHECK (module IN ('notes','files','saved')), entity_id TEXT NOT NULL, PRIMARY KEY (exam_id, module, entity_id));
  `],
};

export const ExamCreated = defineEvent('ExamCreated', 2, z.object({ examId: z.string(), ownerId: z.string(), courseId: z.string(), at: z.number().int() }),
  { from: 1, up: (o) => ({ courseId: '', ...(o as { examId: string; ownerId: string; at: number }) }) });
export const ExamChanged = defineEvent('ExamChanged', 1, z.object({ examId: z.string(), ownerId: z.string(), status: z.enum(EXAM_STATUSES) }));
export type Exam = { id: string; courseId: string; name: string; at: number; location: string; status: ExamStatus; notes: string; grade: string | null; total: string | null; reflection: string | null; topicIds: string[]; refs: { module: string; entityId: string }[] };
type Raw = { id: string; owner_id: string; course_id: string; name: string; at: number; location: string; status: ExamStatus; notes: string; grade: string | null; total: string | null; reflection: string | null; updated_at: number };

export class Exams {
  private db: Db; private bus: EventBus; private courses: Courses; private now: () => number;
  constructor(db: Db, bus: EventBus, courses: Courses, now = () => Date.now()) { this.db = db; this.bus = bus; this.courses = courses; this.now = now; }

  /** Personal sync: newest edit wins (the other version is kept for review), with topics in scope and references. */
  syncProviders(): SyncProvider[] {
    return [rowProvider(this.db, { kind: 'exam', policy: 'lww', table: 'exams_exams', owner: 'owner_id',
      children: [{ table: 'exams_topics', fk: 'exam_id', order: 'topic_id' }, { table: 'exams_refs', fk: 'exam_id', order: 'module, entity_id' }] })];
  }
  private owner(p: Principal) { if (p.kind !== 'user') throw new Error('Only you can change your exams.'); return p.userId; }
  get(p: Principal, id: string): Exam | null { const r = this.db.prepare('SELECT * FROM exams_exams WHERE id = ? AND owner_id = ?').get(id, userOf(p)) as Raw | undefined; return r ? this.full(r) : null; }
  private must(p: Principal, id: string) { const e = this.get(p, id); if (!e) throw new Error('Exam not found.'); return e; }

  create(p: Principal, o: { courseId: string; name: string; at: number; location?: string; topicIds?: string[]; notes?: string }): Exam {
    const u = this.owner(p), id = randomUUID(), t = this.now();
    this.courses.mine(p, o.courseId);
    tx(this.db, () => {
      this.db.prepare('INSERT INTO exams_exams (id, owner_id, course_id, name, at, location, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, u, o.courseId, z.string().trim().min(1).max(160).parse(o.name), z.number().int().positive().parse(o.at), z.string().trim().max(160).parse(o.location ?? ''), z.string().max(10_000).parse(o.notes ?? ''), t, t);
      this.setScope(p, id, o.topicIds ?? [], o.courseId);
      this.bus.publish(ExamCreated, 'exams', { examId: id, ownerId: u, courseId: o.courseId, at: o.at });
    });
    return this.must(p, id);
  }
  update(p: Principal, id: string, o: { name?: string; at?: number; location?: string; notes?: string; topicIds?: string[] }) {
    this.owner(p);
    const e = this.must(p, id);
    tx(this.db, () => {
      this.db.prepare('UPDATE exams_exams SET name = ?, at = ?, location = ?, notes = ?, updated_at = ? WHERE id = ?')
        .run(z.string().trim().min(1).max(160).parse(o.name ?? e.name), z.number().int().positive().parse(o.at ?? e.at), z.string().trim().max(160).parse(o.location ?? e.location), z.string().max(10_000).parse(o.notes ?? e.notes), this.now(), id);
      if (o.topicIds) this.setScope(p, id, o.topicIds, e.courseId);
      this.bus.publish(ExamChanged, 'exams', { examId: id, ownerId: userOf(p), status: e.status });
    });
    return this.must(p, id);
  }
  private setScope(p: Principal, examId: string, topicIds: string[], courseId: string) {
    this.db.prepare('DELETE FROM exams_topics WHERE exam_id = ?').run(examId);
    for (const t of topicIds) { if (this.courses.topic(p, t).courseId !== courseId) throw new Error('Topic of another course.'); this.db.prepare('INSERT OR IGNORE INTO exams_topics (exam_id, topic_id) VALUES (?, ?)').run(examId, t); }
  }
  /**
   * Changes status. A recorded result (grade, total, reflection) is kept across every status change; a field changes only
   * when the student passes it (an empty string clears it explicitly). Nothing is ever computed or guessed.
   */
  setStatus(p: Principal, id: string, status: ExamStatus, result?: { grade?: string; total?: string; reflection?: string }) {
    this.owner(p);
    const e = this.must(p, id), r = result ?? {};
    const pick = (v: string | undefined, cur: string | null, max: number) => (v === undefined ? cur : z.string().trim().max(max).parse(v) || null);
    this.db.prepare('UPDATE exams_exams SET status = ?, grade = ?, total = ?, reflection = ?, updated_at = ? WHERE id = ?')
      .run(z.enum(EXAM_STATUSES).parse(status), pick(r.grade, e.grade, 40), pick(r.total, e.total, 40), pick(r.reflection, e.reflection, 5000), this.now(), id);
    this.bus.publish(ExamChanged, 'exams', { examId: id, ownerId: userOf(p), status });
    return this.must(p, id);
  }
  attach(p: Principal, examId: string, module: 'notes' | 'files' | 'saved', entityId: string) { this.owner(p); this.must(p, examId); if(!this.courses.canReference(p,module,entityId))throw new Error('Attachment not found or not allowed.'); this.db.prepare('INSERT OR IGNORE INTO exams_refs (exam_id, module, entity_id) VALUES (?, ?, ?)').run(examId, module, entityId); }

  fileReferences(owner: string): string[] { return (this.db.prepare("SELECT r.entity_id id FROM exams_refs r JOIN exams_exams e ON e.id=r.exam_id WHERE e.owner_id=? AND r.module='files'").all(owner) as {id:string}[]).map(r=>r.id); }
  hasFileReference(id: string) { return !!this.db.prepare("SELECT 1 FROM exams_refs WHERE module='files' AND entity_id=? LIMIT 1").get(id); }
  remove(p: Principal, id: string) { const owner=this.owner(p); const item=this.must(p,id); tx(this.db,()=>{this.db.prepare('DELETE FROM exams_refs WHERE exam_id = ?').run(id);this.db.prepare('DELETE FROM exams_topics WHERE exam_id = ?').run(id);this.db.prepare('DELETE FROM exams_exams WHERE id = ? AND owner_id = ?').run(id,owner);this.bus.publish(ExamChanged,'exams',{examId:id,ownerId:owner,status:item.status});}); }

  list(p: Principal, o: { courseId?: string; upcoming?: boolean; from?: number; to?: number } = {}): Exam[] {
    if (p.kind === 'agent' && !p.scopes.includes('exams:read')) return [];
    const rows = this.db.prepare(`SELECT * FROM exams_exams WHERE owner_id = ? ${o.courseId ? 'AND course_id = ?' : ''} ${o.upcoming ? "AND status = 'upcoming'" : ''} ${o.from !== undefined ? 'AND at >= ?' : ''} ${o.to !== undefined ? 'AND at <= ?' : ''} ORDER BY at LIMIT 200`)
      .all(...[userOf(p), ...(o.courseId ? [o.courseId] : []), ...(o.from !== undefined ? [o.from] : []), ...(o.to !== undefined ? [o.to] : [])]) as Raw[];
    return rows.map((r) => this.full(r));
  }

  /** Exam Command Center basis: countdown + topics in scope split by the student's own marks. No other "readiness". */
  prep(p: Principal, id: string) {
    const e = this.must(p, id);
    const all = this.courses.topics(p, e.courseId);
    const scope: Topic[] = e.topicIds.length ? all.filter((t) => e.topicIds.includes(t.id)) : [];
    return { exam: e, countdown: countdown(e.at, this.now()), topics: scope, readiness: readiness(scope.map((t) => t.state)),
      covered: scope.filter((t) => t.state === 'confident'), remaining: scope.filter((t) => t.state !== 'confident') };
  }

  /** Upcoming exams in (from, to] for every owner (notification tick). */
  soon(from: number, to: number) { return this.db.prepare("SELECT id, owner_id ownerId, name, at FROM exams_exams WHERE status = 'upcoming' AND at > ? AND at <= ? LIMIT 200").all(from, to) as { id: string; ownerId: string; name: string; at: number }[]; }

  private full(r: Raw): Exam {
    return { id: r.id, courseId: r.course_id, name: r.name, at: r.at, location: r.location, status: r.status, notes: r.notes, grade: r.grade, total: r.total, reflection: r.reflection,
      topicIds: (this.db.prepare('SELECT topic_id t FROM exams_topics WHERE exam_id = ?').all(r.id) as { t: string }[]).map((x) => x.t),
      refs: this.db.prepare('SELECT module, entity_id entityId FROM exams_refs WHERE exam_id = ?').all(r.id) as { module: string; entityId: string }[] };
  }
  searchProvider(): SearchProvider {
    const doc = (id: string) => { const r = this.db.prepare('SELECT * FROM exams_exams WHERE id = ?').get(id) as Raw | undefined; return r ? { entityId: r.id, title: r.name, body: `${r.location} ${r.notes}`, updatedAt: r.updated_at, scopes: [{ kind: 'personal', ownerId: r.owner_id } as Scope] } : null; };
    return { module: 'exams', events: [ExamCreated, ExamChanged].map((def) => ({ def: def as never, entityId: (e: never) => (e as { examId: string }).examId })), one: doc, all: () => (this.db.prepare('SELECT id FROM exams_exams').all() as { id: string }[]).map((r) => doc(r.id)).filter((d) => !!d) };
  }
}

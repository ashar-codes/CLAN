// Courses: a student's own course structure — ordered topics (with their own confidence marks), lectures, and
// references to notes, files (canonical resources) and saved links. A Course may point at a CLASSROOM CLAN, but it is
// not that CLAN: it stays usable when the CLAN is offline or gone. Nothing here copies another module's content.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RESOURCE_KINDS, TOPIC_STATES, type ResourceKind, type TopicState } from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Principal, type Scope } from '../../core/permissions.ts';
import type { SearchProvider } from '../../core/search.ts';
import type { Clans } from '../clans/index.ts';
import type { Files } from '../files/index.ts';
import type { Notes } from '../notes/index.ts';
import type { Saved } from '../saved/index.ts';
import type { Identity } from '../../core/identity.ts';
import { rowProvider, type SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'courses', prefix: 'courses',
  migrations: [`
    CREATE TABLE courses_courses (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', instructor TEXT NOT NULL DEFAULT '',
      term TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL DEFAULT '', clan_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
      UNIQUE (owner_id, clan_id));
    CREATE INDEX courses_courses_owner ON courses_courses(owner_id, archived_at);
    CREATE TABLE courses_topics (id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses_courses(id), title TEXT NOT NULL, position INTEGER NOT NULL,
      confidence TEXT NOT NULL DEFAULT 'not_started' CHECK (confidence IN ('not_started','learning','review','confident')), confidence_at INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX courses_topics_course ON courses_topics(course_id, position);
    CREATE TABLE courses_lectures (id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses_courses(id), title TEXT NOT NULL, at INTEGER, position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','held','cancelled')), session_id TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX courses_lectures_course ON courses_lectures(course_id, position);
    CREATE TABLE courses_lecture_topics (lecture_id TEXT NOT NULL REFERENCES courses_lectures(id), topic_id TEXT NOT NULL REFERENCES courses_topics(id), PRIMARY KEY (lecture_id, topic_id));
    -- References into other modules (notes / files = a Resource Store ref / saved). Never their content.
    CREATE TABLE courses_links (id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses_courses(id), topic_id TEXT, lecture_id TEXT,
      module TEXT NOT NULL CHECK (module IN ('notes','files','saved')), entity_id TEXT NOT NULL,
      kind TEXT CHECK (kind IN ('lecture_material','past_paper','assignment','book','reference','other')), created_at INTEGER NOT NULL);
    -- one reference per placement; coalesce because SQLite treats NULLs as distinct in UNIQUE
    CREATE UNIQUE INDEX courses_links_place ON courses_links(course_id, module, entity_id, coalesce(topic_id, ''), coalesce(lecture_id, ''));
    CREATE INDEX courses_links_course ON courses_links(course_id, module);
    CREATE INDEX courses_links_entity ON courses_links(module, entity_id);
  `],
};

const ids = { courseId: z.string(), ownerId: z.string() };
export const CourseCreated = defineEvent('CourseCreated', 1, z.object({ ...ids, linkedClan: z.boolean() }));
export const TopicCreated = defineEvent('TopicCreated', 1, z.object({ ...ids, topicId: z.string() }));
export const CourseChanged = defineEvent('CourseChanged', 1, z.object(ids));
export const TopicConfidenceChanged = defineEvent('TopicConfidenceChanged', 1, z.object({ ...ids, topicId: z.string(), state: z.enum(TOPIC_STATES) }));

export type Course = { id: string; name: string; code: string; instructor: string; term: string; schedule: string; clanId: string | null; createdAt: number; updatedAt: number };
export type Topic = { id: string; courseId: string; title: string; position: number; state: TopicState; stateAt: number | null };
export type Lecture = { id: string; courseId: string; title: string; at: number | null; position: number; status: 'planned' | 'held' | 'cancelled'; sessionId: string | null; topicIds: string[] };
/** A resolved reference: the item as its own module shows it to this person, or `missing` (deleted / no longer visible). */
export type CourseLink = {
  id: string; module: 'notes' | 'files' | 'saved'; entityId: string; topicId: string | null; lectureId: string | null; kind: ResourceKind | null;
  title: string; detail: string; missing: boolean;
  /** Where it came from when it is not the student's own (e.g. a teacher's file in a Classroom CLAN). */
  provenance: { clan: string; sharedBy: string | null } | null;
};

const Text = (max: number) => z.string().trim().max(max);
type CRow = { id: string; owner_id: string; name: string; code: string; instructor: string; term: string; schedule: string; clan_id: string | null; created_at: number; updated_at: number };
const toCourse = (r: CRow): Course => ({ id: r.id, name: r.name, code: r.code, instructor: r.instructor, term: r.term, schedule: r.schedule, clanId: r.clan_id, createdAt: r.created_at, updatedAt: r.updated_at });

export class Courses {
  private db: Db; private bus: EventBus; private m: { clans: Clans; notes: Notes; files: Files; saved: Saved; identity: Identity }; private now: () => number;
  constructor(db: Db, bus: EventBus, m: { clans: Clans; notes: Notes; files: Files; saved: Saved; identity: Identity }, now = () => Date.now()) { this.db = db; this.bus = bus; this.m = m; this.now = now; }

  /** Personal sync: a course with its topics, lectures and references; newest edit wins (the other is kept for review).
   *  Which CLAN a course is linked to is device-local (linking a device never grants CLAN membership). */
  syncProviders(): SyncProvider[] {
    return [rowProvider(this.db, { kind: 'course', policy: 'lww', table: 'courses_courses', owner: 'owner_id', exclude: ['clan_id'],
      children: [
        { table: 'courses_topics', fk: 'course_id', key: 'id', order: 'position, id', dependents: [{ table: 'courses_lecture_topics', fk: 'topic_id' }] },
        { table: 'courses_lectures', fk: 'course_id', key: 'id', order: 'position, id', dependents: [{ table: 'courses_lecture_topics', fk: 'lecture_id' }] },
        { table: 'courses_lecture_topics', fk: 'lecture_id', via: { table: 'courses_lectures', fk: 'course_id' }, order: 'lecture_id, topic_id' },
        { table: 'courses_links', fk: 'course_id', order: 'id' },
      ] })];
  }

  private owner(p: Principal) { if (p.kind !== 'user') throw new Error('Only you can change your courses.'); return p.userId; }
  /** The course, if it is this person's. Every operation goes through here (cross-course / cross-user isolation). */
  mine(p: Principal, courseId: string): Course {
    const r = this.db.prepare('SELECT * FROM courses_courses WHERE id = ? AND owner_id = ? AND archived_at IS NULL').get(courseId, userOf(p)) as CRow | undefined;
    if (!r) throw new Error('Course not found.');
    return toCourse(r);
  }
  /** Owner of a course (for modules that attach their own data to it, e.g. a Course board). */
  ownerOf(courseId: string) { return (this.db.prepare('SELECT owner_id o FROM courses_courses WHERE id = ? AND archived_at IS NULL').get(courseId) as { o: string } | undefined)?.o ?? null; }
  /** Lifecycle retention includes archived personal courses; their file links must keep working. */
  fileReferences(ownerId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT l.entity_id id FROM courses_links l JOIN courses_courses c ON c.id = l.course_id WHERE c.owner_id = ? AND l.module = 'files'").all(ownerId) as { id: string }[]).map((r) => r.id);
  }
  list(p: Principal): Course[] {
    return (this.db.prepare('SELECT * FROM courses_courses WHERE owner_id = ? AND archived_at IS NULL ORDER BY name LIMIT 200').all(userOf(p)) as CRow[]).map(toCourse);
  }

  create(p: Principal, o: { name: string; code?: string; instructor?: string; term?: string; schedule?: string; clanId?: string | null }): Course {
    const u = this.owner(p), id = randomUUID(), t = this.now();
    if (o.clanId) this.assertClassroom(u, o.clanId);
    tx(this.db, () => {
      this.db.prepare('INSERT INTO courses_courses (id, owner_id, name, code, instructor, term, schedule, clan_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, u, Text(120).min(1).parse(o.name), Text(30).parse(o.code ?? ''), Text(120).parse(o.instructor ?? ''), Text(60).parse(o.term ?? ''), Text(500).parse(o.schedule ?? ''), o.clanId ?? null, t, t);
      this.bus.publish(CourseCreated, 'courses', { courseId: id, ownerId: u, linkedClan: !!o.clanId });
    });
    return this.mine(p, id);
  }
  update(p: Principal, id: string, o: Partial<Pick<Course, 'name' | 'code' | 'instructor' | 'term' | 'schedule'>> & { clanId?: string | null }) {
    const c = this.mine(p, id), u = this.owner(p);
    if (o.clanId) this.assertClassroom(u, o.clanId);
    this.db.prepare('UPDATE courses_courses SET name = ?, code = ?, instructor = ?, term = ?, schedule = ?, clan_id = ?, updated_at = ? WHERE id = ?')
      .run(Text(120).min(1).parse(o.name ?? c.name), Text(30).parse(o.code ?? c.code), Text(120).parse(o.instructor ?? c.instructor), Text(60).parse(o.term ?? c.term), Text(500).parse(o.schedule ?? c.schedule),
        o.clanId === undefined ? c.clanId : o.clanId, this.now(), id);
    this.bus.publish(CourseChanged, 'courses', { courseId: id, ownerId: u });
    return this.mine(p, id);
  }
  archive(p: Principal, id: string) { this.mine(p, id); this.db.prepare('UPDATE courses_courses SET archived_at = ? WHERE id = ?').run(this.now(), id); this.bus.publish(CourseChanged, 'courses', { courseId: id, ownerId: userOf(p) }); }

  private assertClassroom(userId: string, clanId: string) {
    const c = this.m.clans.get(clanId);
    if (!c || c.type !== 'CLASSROOM' || !this.m.clans.isActiveMember(clanId, userId)) throw new Error('Only a Classroom you belong to can be linked to a course.');
  }
  /** The person's course linked to a Classroom CLAN, if any. */
  forClan(p: Principal, clanId: string) { const r = this.db.prepare('SELECT * FROM courses_courses WHERE owner_id = ? AND clan_id = ? AND archived_at IS NULL').get(userOf(p), clanId) as CRow | undefined; return r ? toCourse(r) : null; }

  /**
   * Every CLASSROOM CLAN the person belongs to gets one linked Course (named like the CLAN). Idempotent: the
   * (owner, clan) pair is unique, and an archived course is not recreated. Nothing of the CLAN is copied.
   */
  linkClassrooms(p: Principal): number {
    const u = this.owner(p);
    let n = 0;
    for (const c of this.m.clans.list(u, { includeArchived: true }).filter((x) => x.type === 'CLASSROOM')) {
      if (this.db.prepare('SELECT 1 FROM courses_courses WHERE owner_id = ? AND clan_id = ?').get(u, c.id)) continue;
      this.create(p, { name: c.name, clanId: c.id }); n++;
    }
    return n;
  }

  // ---- topics (explicit order) ----
  topics(p: Principal, courseId: string): Topic[] {
    this.mine(p, courseId);
    return (this.db.prepare('SELECT id, course_id courseId, title, position, confidence state, confidence_at stateAt FROM courses_topics WHERE course_id = ? ORDER BY position, created_at').all(courseId) as Topic[]);
  }
  addTopic(p: Principal, courseId: string, title: string): Topic {
    const u = this.owner(p); this.mine(p, courseId);
    const id = randomUUID();
    tx(this.db, () => {
      const pos = (this.db.prepare('SELECT coalesce(max(position), -1) + 1 n FROM courses_topics WHERE course_id = ?').get(courseId) as { n: number }).n;
      this.db.prepare('INSERT INTO courses_topics (id, course_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)').run(id, courseId, Text(160).min(1).parse(title), pos, this.now());
      this.bus.publish(TopicCreated, 'courses', { courseId, ownerId: u, topicId: id });
    });
    return this.topics(p, courseId).find((t) => t.id === id)!;
  }
  renameTopic(p: Principal, topicId: string, title: string) { const t = this.topic(p, topicId); this.db.prepare('UPDATE courses_topics SET title = ? WHERE id = ?').run(Text(160).min(1).parse(title), t.id); this.bus.publish(CourseChanged, 'courses', { courseId: t.courseId, ownerId: userOf(p) }); }
  /** Moves a topic to `index` (0-based) and renumbers the rest — order is exactly what the student set. */
  moveTopic(p: Principal, topicId: string, index: number) {
    const t = this.topic(p, topicId);
    const order = this.topics(p, t.courseId).filter((x) => x.id !== t.id);
    order.splice(Math.max(0, Math.min(index, order.length)), 0, t);
    tx(this.db, () => order.forEach((x, i) => this.db.prepare('UPDATE courses_topics SET position = ? WHERE id = ?').run(i, x.id)));
  }
  removeTopic(p: Principal, topicId: string) {
    const t = this.topic(p, topicId);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM courses_lecture_topics WHERE topic_id = ?').run(t.id);
      this.db.prepare('UPDATE courses_links SET topic_id = NULL WHERE topic_id = ? AND NOT EXISTS (SELECT 1 FROM courses_links x WHERE x.course_id = courses_links.course_id AND x.module = courses_links.module AND x.entity_id = courses_links.entity_id AND x.topic_id IS NULL AND x.lecture_id IS courses_links.lecture_id)').run(t.id);
      this.db.prepare('DELETE FROM courses_links WHERE topic_id = ?').run(t.id);
      this.db.prepare('DELETE FROM courses_topics WHERE id = ?').run(t.id);
    });
  }
  /** The student's own mark. Nothing else ever changes it. */
  setConfidence(p: Principal, topicId: string, state: TopicState) {
    const t = this.topic(p, topicId), u = this.owner(p);
    this.db.prepare('UPDATE courses_topics SET confidence = ?, confidence_at = ? WHERE id = ?').run(z.enum(TOPIC_STATES).parse(state), this.now(), t.id);
    this.bus.publish(TopicConfidenceChanged, 'courses', { courseId: t.courseId, ownerId: u, topicId: t.id, state });
  }
  topic(p: Principal, topicId: string): Topic {
    const t = this.db.prepare('SELECT t.id, t.course_id courseId, t.title, t.position, t.confidence state, t.confidence_at stateAt FROM courses_topics t JOIN courses_courses c ON c.id = t.course_id WHERE t.id = ? AND c.owner_id = ?').get(topicId, userOf(p)) as Topic | undefined;
    if (!t) throw new Error('Topic not found.');
    return t;
  }

  // ---- lectures ----
  lectures(p: Principal, courseId: string): Lecture[] {
    this.mine(p, courseId);
    const rows = this.db.prepare('SELECT id, course_id courseId, title, at, position, status, session_id sessionId FROM courses_lectures WHERE course_id = ? ORDER BY position, created_at').all(courseId) as Omit<Lecture, 'topicIds'>[];
    return rows.map((l) => ({ ...l, topicIds: (this.db.prepare('SELECT topic_id t FROM courses_lecture_topics WHERE lecture_id = ?').all(l.id) as { t: string }[]).map((x) => x.t) }));
  }
  addLecture(p: Principal, courseId: string, o: { title: string; at?: number | null; topicIds?: string[]; sessionId?: string | null }): Lecture {
    this.owner(p); this.mine(p, courseId);
    const id = randomUUID();
    tx(this.db, () => {
      const pos = (this.db.prepare('SELECT coalesce(max(position), -1) + 1 n FROM courses_lectures WHERE course_id = ?').get(courseId) as { n: number }).n;
      this.db.prepare('INSERT INTO courses_lectures (id, course_id, title, at, position, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, courseId, Text(160).min(1).parse(o.title), o.at ?? null, pos, o.sessionId ?? null, this.now());
      for (const t of o.topicIds ?? []) { if (this.topic(p, t).courseId !== courseId) throw new Error('Topic of another course.'); this.db.prepare('INSERT OR IGNORE INTO courses_lecture_topics (lecture_id, topic_id) VALUES (?, ?)').run(id, t); }
      this.bus.publish(CourseChanged, 'courses', { courseId, ownerId: userOf(p) });
    });
    return this.lectures(p, courseId).find((l) => l.id === id)!;
  }
  setLecture(p: Principal, lectureId: string, o: { status?: Lecture['status']; title?: string; at?: number | null }) {
    const l = this.db.prepare('SELECT l.* FROM courses_lectures l JOIN courses_courses c ON c.id = l.course_id WHERE l.id = ? AND c.owner_id = ?').get(lectureId, userOf(p)) as { id: string; title: string; at: number | null; status: string } | undefined;
    if (!l) throw new Error('Lecture not found.');
    this.db.prepare('UPDATE courses_lectures SET status = ?, title = ?, at = ? WHERE id = ?').run(z.enum(['planned', 'held', 'cancelled']).parse(o.status ?? l.status), Text(160).min(1).parse(o.title ?? l.title), o.at === undefined ? l.at : o.at, l.id);
  }

  // ---- references into other modules ----
  /** Links an existing note / file (Resource Store ref) / saved item the person can read. Idempotent per placement. */
  link(p: Principal, courseId: string, o: { module: CourseLink['module']; entityId: string; topicId?: string | null; lectureId?: string | null; kind?: ResourceKind | null }): CourseLink {
    const u = this.owner(p); this.mine(p, courseId);
    if (o.topicId && this.topic(p, o.topicId).courseId !== courseId) throw new Error('Topic of another course.');
    if (o.lectureId && !this.lectures(p, courseId).some((l) => l.id === o.lectureId)) throw new Error('Lecture of another course.');
    if (!this.resolve(p, o.module, o.entityId)) throw new Error('Not found.'); // can't link what you can't read
    const kind = o.module === 'files' ? (o.kind ? z.enum(RESOURCE_KINDS).parse(o.kind) : 'other') : null;
    this.db.prepare('INSERT OR IGNORE INTO courses_links (id, course_id, topic_id, lecture_id, module, entity_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), courseId, o.topicId ?? null, o.lectureId ?? null, o.module, o.entityId, kind, this.now());
    this.bus.publish(CourseChanged, 'courses', { courseId, ownerId: u });
    const row = this.db.prepare('SELECT id FROM courses_links WHERE course_id = ? AND module = ? AND entity_id = ? AND topic_id IS ? AND lecture_id IS ?').get(courseId, o.module, o.entityId, o.topicId ?? null, o.lectureId ?? null) as { id: string };
    return this.links(p, courseId).find((l) => l.id === row.id)!;
  }
  classify(p: Principal, linkId: string, kind: ResourceKind) { const l = this.linkRow(p, linkId); this.db.prepare("UPDATE courses_links SET kind = ? WHERE id = ? AND module = 'files'").run(z.enum(RESOURCE_KINDS).parse(kind), l.id); }
  /** Removes the reference only — the note, file or saved item itself is untouched. */
  unlink(p: Principal, linkId: string) { const l = this.linkRow(p, linkId); this.db.prepare('DELETE FROM courses_links WHERE id = ?').run(l.id); }
  private linkRow(p: Principal, id: string) {
    const l = this.db.prepare('SELECT l.id FROM courses_links l JOIN courses_courses c ON c.id = l.course_id WHERE l.id = ? AND c.owner_id = ?').get(id, userOf(p)) as { id: string } | undefined;
    if (!l) throw new Error('Not found.');
    return l;
  }
  links(p: Principal, courseId: string, o: { module?: CourseLink['module']; topicId?: string; lectureId?: string; limit?: number } = {}): CourseLink[] {
    this.mine(p, courseId);
    const rows = this.db.prepare(`SELECT * FROM courses_links WHERE course_id = ? ${o.module ? 'AND module = ?' : ''} ${o.topicId ? 'AND topic_id = ?' : ''} ${o.lectureId ? 'AND lecture_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...[courseId, ...(o.module ? [o.module] : []), ...(o.topicId ? [o.topicId] : []), ...(o.lectureId ? [o.lectureId] : []), o.limit ?? 200]) as { id: string; module: CourseLink['module']; entity_id: string; topic_id: string | null; lecture_id: string | null; kind: ResourceKind | null }[];
    return rows.map((r) => {
      const it = this.resolve(p, r.module, r.entity_id);
      return { id: r.id, module: r.module, entityId: r.entity_id, topicId: r.topic_id, lectureId: r.lecture_id, kind: r.kind, title: it?.title ?? 'No longer available', detail: it?.detail ?? '', missing: !it, provenance: it?.provenance ?? null };
    });
  }
  /** Through the owning module, with its own permission rules. */
  private resolve(p: Principal, module: CourseLink['module'], id: string): { title: string; detail: string; provenance: CourseLink['provenance'] } | null {
    if (module === 'notes') { const n = this.m.notes.get(p, id); return n && { title: n.title, detail: n.body.slice(0, 120), provenance: n.ownerId === userOf(p) ? null : { clan: n.sharedWith.map((c) => this.m.clans.get(c)?.name).find(Boolean) ?? 'a CLAN', sharedBy: this.m.identity.displayName(n.ownerId) } }; }
    if (module === 'saved') { const s = this.m.saved.get(p, id); return s && { title: s.title, detail: s.url, provenance: null }; }
    const f = this.m.files.get(p, id);
    return f && { title: f.name, detail: `${f.size} bytes · SHA-256 ${f.sha256.slice(0, 12)}…`, provenance: f.scope.kind === 'clan' ? { clan: this.m.clans.get(f.scope.clanId)?.name ?? 'a CLAN', sharedBy: f.source === 'classroom' || f.createdBy !== userOf(p) ? this.m.identity.displayName(f.createdBy) : null } : null };
  }
  /** Course ids that reference an entity (e.g. which courses a note belongs to). */
  coursesOf(p: Principal, module: CourseLink['module'], entityId: string) {
    return (this.db.prepare('SELECT DISTINCT l.course_id c FROM courses_links l JOIN courses_courses k ON k.id = l.course_id WHERE l.module = ? AND l.entity_id = ? AND k.owner_id = ?').all(module, entityId, userOf(p)) as { c: string }[]).map((r) => r.c);
  }
  /** Recently active content per course (lit windows): links created or notes/saved updated in the window. */
  recentActivity(p: Principal, courseId: string, since: number) {
    return (this.db.prepare('SELECT count(*) n FROM courses_links WHERE course_id = ? AND created_at >= ?').get(courseId, since) as { n: number }).n
      + this.links(p, courseId, { module: 'notes' }).filter((l) => (this.m.notes.get(p, l.entityId)?.updatedAt ?? 0) >= since).length;
  }

  searchProvider(): SearchProvider {
    const doc = (id: string) => {
      const c = this.db.prepare('SELECT * FROM courses_courses WHERE id = ? AND archived_at IS NULL').get(id) as CRow | undefined;
      if (!c) return null;
      const topics = (this.db.prepare('SELECT title FROM courses_topics WHERE course_id = ?').all(id) as { title: string }[]).map((t) => t.title);
      const lectures = (this.db.prepare('SELECT title FROM courses_lectures WHERE course_id = ?').all(id) as { title: string }[]).map((t) => t.title);
      return { entityId: c.id, title: c.code ? `${c.code} ${c.name}` : c.name, body: [c.instructor, c.term, ...topics, ...lectures].join(' · '), updatedAt: c.updated_at, scopes: [{ kind: 'personal', ownerId: c.owner_id } as Scope] };
    };
    return {
      module: 'courses',
      events: [CourseCreated, CourseChanged, TopicCreated].map((def) => ({ def: def as never, entityId: (e: never) => (e as { courseId: string }).courseId })),
      one: doc, all: () => (this.db.prepare('SELECT id FROM courses_courses').all() as { id: string }[]).map((r) => doc(r.id)).filter((d) => !!d),
    };
  }
}

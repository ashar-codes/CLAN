// Study Sessions: planned or live personal study time for a course/topic, with an optional goal and reflection.
// Only what the student does on purpose is recorded (start, end, duration, reflection) — no activity tracking.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Principal } from '../../core/permissions.ts';
import type { Courses } from '../courses/index.ts';
import { rowProvider, type SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'study', prefix: 'study',
  migrations: [`
    CREATE TABLE study_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, course_id TEXT, topic_id TEXT, goal TEXT NOT NULL DEFAULT '',
      planned_at INTEGER, planned_minutes INTEGER, status TEXT NOT NULL CHECK (status IN ('planned','active','ended','cancelled')),
      focus INTEGER NOT NULL DEFAULT 0, started_at INTEGER, ended_at INTEGER, reflection TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX study_sessions_owner ON study_sessions(owner_id, status, planned_at);
    CREATE INDEX study_sessions_course ON study_sessions(owner_id, course_id, started_at);
  `],
};

export const StudySessionStarted = defineEvent('StudySessionStarted', 1, z.object({ sessionId: z.string(), ownerId: z.string(), courseId: z.string().nullable(), focus: z.boolean() }));
export const StudySessionEnded = defineEvent('StudySessionEnded', 1, z.object({ sessionId: z.string(), ownerId: z.string(), minutes: z.number() }));
export type StudySession = { id: string; courseId: string | null; topicId: string | null; goal: string; plannedAt: number | null; plannedMinutes: number | null;
  status: 'planned' | 'active' | 'ended' | 'cancelled'; focus: boolean; startedAt: number | null; endedAt: number | null; reflection: string | null };
const COLS = 'id, course_id courseId, topic_id topicId, goal, planned_at plannedAt, planned_minutes plannedMinutes, status, focus, started_at startedAt, ended_at endedAt, reflection';
const fix = (r: StudySession & { focus: unknown }): StudySession => ({ ...r, focus: !!r.focus });

export class Study {
  private db: Db; private bus: EventBus; private courses: Courses; private now: () => number;
  constructor(db: Db, bus: EventBus, courses: Courses, now = () => Date.now()) { this.db = db; this.bus = bus; this.courses = courses; this.now = now; }

  /** Personal sync: planned and finished sessions (a running one stays on its device until it ends). Each session is
   *  its own record, so sessions from two devices never merge. */
  syncProviders(): SyncProvider[] { return [rowProvider(this.db, { kind: 'study-session', policy: 'lww', table: 'study_sessions', owner: 'owner_id', where: "status <> 'active'" })]; }
  private owner(p: Principal) { if (p.kind !== 'user') throw new Error('Only you can study.'); return p.userId; }
  get(p: Principal, id: string) { const r = this.db.prepare(`SELECT ${COLS} FROM study_sessions WHERE id = ? AND owner_id = ?`).get(id, userOf(p)) as StudySession | undefined; return r ? fix(r) : null; }
  ownerOf(sessionId: string) { return (this.db.prepare('SELECT owner_id o FROM study_sessions WHERE id = ?').get(sessionId) as { o: string } | undefined)?.o ?? null; }
  active(p: Principal) { const r = this.db.prepare(`SELECT ${COLS} FROM study_sessions WHERE owner_id = ? AND status = 'active' LIMIT 1`).get(userOf(p)) as StudySession | undefined; return r ? fix(r) : null; }

  private target(p: Principal, o: { courseId?: string | null; topicId?: string | null }) {
    if (o.courseId) this.courses.mine(p, o.courseId);
    if (o.topicId && this.courses.topic(p, o.topicId).courseId !== o.courseId) throw new Error('Topic of another course.');
  }
  plan(p: Principal, o: { courseId?: string | null; topicId?: string | null; goal?: string; at: number; minutes?: number | null }): StudySession {
    const u = this.owner(p), id = randomUUID(); this.target(p, o);
    this.db.prepare("INSERT INTO study_sessions (id, owner_id, course_id, topic_id, goal, planned_at, planned_minutes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)")
      .run(id, u, o.courseId ?? null, o.topicId ?? null, z.string().trim().max(300).parse(o.goal ?? ''), z.number().int().positive().parse(o.at), o.minutes ?? null, this.now());
    return this.get(p, id)!;
  }
  /** Starts a session now (or a planned one). Only one runs at a time: starting another ends the current one. */
  start(p: Principal, o: { sessionId?: string; courseId?: string | null; topicId?: string | null; goal?: string; minutes?: number | null; focus?: boolean }): StudySession {
    const u = this.owner(p);
    const cur = this.active(p);
    if (cur) this.end(p, cur.id);
    const t = this.now();
    let id = o.sessionId;
    tx(this.db, () => {
      if (id) {
        if (this.get(p, id)?.status !== 'planned') throw new Error('That session is not planned.');
        this.db.prepare("UPDATE study_sessions SET status = 'active', started_at = ?, focus = ? WHERE id = ?").run(t, o.focus ? 1 : 0, id);
      } else {
        this.target(p, o); id = randomUUID();
        this.db.prepare("INSERT INTO study_sessions (id, owner_id, course_id, topic_id, goal, planned_minutes, status, focus, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)")
          .run(id, u, o.courseId ?? null, o.topicId ?? null, z.string().trim().max(300).parse(o.goal ?? ''), o.minutes ?? null, o.focus ? 1 : 0, t, t);
      }
      const s = this.get(p, id!)!;
      this.bus.publish(StudySessionStarted, 'study', { sessionId: id!, ownerId: u, courseId: s.courseId, focus: s.focus });
    });
    return this.get(p, id!)!;
  }
  end(p: Principal, id: string, reflection?: string): StudySession {
    this.owner(p);
    const s = this.get(p, id);
    if (!s || s.status !== 'active') throw new Error('No running session.');
    const t = this.now();
    tx(this.db, () => {
      this.db.prepare("UPDATE study_sessions SET status = 'ended', ended_at = ?, reflection = ? WHERE id = ?").run(t, z.string().max(5000).parse(reflection ?? '') || null, id);
      this.bus.publish(StudySessionEnded, 'study', { sessionId: id, ownerId: userOf(p), minutes: Math.round((t - s.startedAt!) / 60_000) });
    });
    return this.get(p, id)!;
  }
  cancel(p: Principal, id: string) { this.owner(p); const s = this.get(p, id); if (s?.status === 'planned') this.db.prepare("UPDATE study_sessions SET status = 'cancelled' WHERE id = ?").run(id); }
  update(p: Principal,id:string,o:{goal?:string;reflection?:string}) { this.owner(p);const s=this.get(p,id);if(!s||s.status==='active')throw Error('End the session before editing its saved record.');this.db.prepare('UPDATE study_sessions SET goal = ?, reflection = ? WHERE id = ?').run(z.string().trim().max(300).parse(o.goal??s.goal),z.string().max(5000).parse(o.reflection??s.reflection??''),id);return this.get(p,id)!; }
  remove(p: Principal,id:string) { const owner=this.owner(p),s=this.get(p,id);if(!s)throw Error('Study record not found.');if(s.status==='active')throw Error('End the session before deleting its saved record.');this.db.prepare('DELETE FROM study_sessions WHERE id = ? AND owner_id = ?').run(id,owner); }
  planned(p: Principal, from: number, to: number) { return (this.db.prepare(`SELECT ${COLS} FROM study_sessions WHERE owner_id = ? AND status = 'planned' AND planned_at BETWEEN ? AND ? ORDER BY planned_at LIMIT 200`).all(userOf(p), from, to) as unknown as StudySession[]).map(fix); }
  recent(p: Principal, o: { courseId?: string; limit?: number } = {}) {
    return (this.db.prepare(`SELECT ${COLS} FROM study_sessions WHERE owner_id = ? AND status = 'ended' ${o.courseId ? 'AND course_id = ?' : ''} ORDER BY ended_at DESC LIMIT ?`).all(...[userOf(p), ...(o.courseId ? [o.courseId] : []), o.limit ?? 20]) as unknown as StudySession[]).map(fix);
  }
  /** Personal history: minutes and sessions per course since `since`, and the topics studied. Never compared with anyone. */
  history(p: Principal, since: number) {
    return this.db.prepare(`SELECT course_id courseId, count(*) sessions, sum(ended_at - started_at) / 60000 minutes, count(DISTINCT topic_id) topics FROM study_sessions
      WHERE owner_id = ? AND status = 'ended' AND ended_at >= ? GROUP BY course_id ORDER BY minutes DESC`).all(userOf(p), since) as { courseId: string | null; sessions: number; minutes: number; topics: number }[];
  }
  /** Planned sessions starting in (from, to] for every owner (notification tick). */
  startingSoon(from: number, to: number) { return this.db.prepare("SELECT id, owner_id ownerId, goal, course_id courseId, planned_at plannedAt FROM study_sessions WHERE status = 'planned' AND planned_at > ? AND planned_at <= ? LIMIT 200").all(from, to) as { id: string; ownerId: string; goal: string; courseId: string | null; plannedAt: number }[]; }
}

// Agenda: Today and the Semester Board (calendar) as a read projection over the owning modules — no tables, no copies.
// Every item says where it lives (`open`), so clicking it opens the source. Also the AI-ready context boundary
// (CourseContext / LectureContext / ExamContext / StudyContext): permission-aware references only, nothing generated.
import type { TopicState } from '@classroom/protocol';
import type { Principal } from '../../core/permissions.ts';
import type { Assignments } from '../assignments/index.ts';
import type { Courses } from '../courses/index.ts';
import type { Exams } from '../exams/index.ts';
import type { Flashcards } from '../flashcards/index.ts';
import type { Reminders } from '../reminders/index.ts';
import type { Study } from '../study/index.ts';
import type { Tasks } from '../tasks/index.ts';

export type AgendaItem = {
  kind: 'task' | 'reminder' | 'assignment' | 'exam' | 'session';
  id: string; title: string; at: number | null; courseId: string | null;
  /** Shown as the item's origin, e.g. "Task", "Classroom assignment". */
  source: string; status: string; overdue: boolean;
  open: { module: 'tasks' | 'reminders' | 'assignments' | 'exams' | 'study'; id: string; clanId?: string };
};
type M = { tasks: Tasks; reminders: Reminders; assignments: Assignments; exams: Exams; study: Study; courses: Courses; flashcards: Flashcards };
const endOfDay = (t: number) => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

export class Agenda {
  private m: M; private now: () => number;
  constructor(m: M, now = () => Date.now()) { this.m = m; this.now = now; }

  private courseOfClan(p: Principal) { const map = new Map<string, string>(); for (const c of this.m.courses.list(p)) if (c.clanId) map.set(c.clanId, c.id); return map; }

  /** Today: overdue + due today (tasks, reminders), assignments due within a week, exams within two weeks, sessions planned today. */
  today(p: Principal): AgendaItem[] {
    const now = this.now(), end = endOfDay(now), clanCourse = this.courseOfClan(p);
    const items: AgendaItem[] = [
      ...this.m.tasks.list(p, { open: true, dueBefore: end, limit: 50 }).map((t) => this.task(t, now)),
      ...this.m.reminders.upcoming(p, end).map((r) => ({ kind: 'reminder' as const, id: r.id, title: r.text, at: r.at, courseId: r.target?.module === 'courses' ? r.target.id : null, source: 'Reminder', status: r.recurrence === 'none' ? 'once' : r.recurrence, overdue: r.at < now, open: { module: 'reminders' as const, id: r.id } })),
      ...this.m.assignments.list(p, { dueBefore: now + 7 * 86_400_000 }).filter((a) => !a.closed && (a.role === 'host' || a.status === 'missing')).map((a) => this.assignment(a, now, clanCourse)),
      ...this.m.exams.list(p, { upcoming: true, from: startOfDay(now), to: now + 14 * 86_400_000 }).map((e) => this.exam(e, now)),
      ...this.m.study.planned(p, startOfDay(now), end).map((s) => this.session(s, now)),
    ];
    return items.sort((a, b) => (a.at ?? 9e15) - (b.at ?? 9e15));
  }

  /** Everything with a date in [from, to] for the Semester Board. */
  range(p: Principal, from: number, to: number): AgendaItem[] {
    const now = this.now(), clanCourse = this.courseOfClan(p);
    return [
      ...this.m.tasks.list(p, { dueBefore: to, limit: 500 }).filter((t) => t.dueAt! >= from && t.status !== 'cancelled').map((t) => this.task(t, now)),
      ...this.m.reminders.between(p, from, to).map((r) => ({ kind: 'reminder' as const, id: r.id, title: r.text, at: r.at, courseId: r.target?.module === 'courses' ? r.target.id : null, source: 'Reminder', status: r.recurrence, overdue: r.at < now, open: { module: 'reminders' as const, id: r.id } })),
      ...this.m.assignments.list(p, { dueBefore: to }).filter((a) => a.dueAt! >= from).map((a) => this.assignment(a, now, clanCourse)),
      ...this.m.exams.list(p, { from, to }).filter((e) => e.status !== 'cancelled').map((e) => this.exam(e, now)),
      ...this.m.study.planned(p, from, to).map((s) => this.session(s, now)),
    ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  }

  private task(t: ReturnType<Tasks['list']>[number], now: number): AgendaItem {
    return { kind: 'task', id: t.id, title: t.title, at: t.dueAt, courseId: t.courseId, source: 'Task', status: t.status, overdue: !!t.dueAt && t.dueAt < now && t.status !== 'done', open: { module: 'tasks', id: t.id } };
  }
  private assignment(a: ReturnType<Assignments['list']>[number], now: number, clanCourse: Map<string, string>): AgendaItem {
    return { kind: 'assignment', id: a.id, title: a.title, at: a.dueAt, courseId: clanCourse.get(a.clanId) ?? null, source: 'Classroom assignment',
      status: a.role === 'host' ? `${a.submitted ?? 0} submitted` : a.status, overdue: !!a.dueAt && a.dueAt < now && a.status === 'missing', open: { module: 'assignments', id: a.id, clanId: a.clanId } };
  }
  private exam(e: ReturnType<Exams['list']>[number], _now: number): AgendaItem {
    return { kind: 'exam', id: e.id, title: e.name, at: e.at, courseId: e.courseId, source: 'Exam', status: e.status, overdue: false, open: { module: 'exams', id: e.id } };
  }
  private session(s: ReturnType<Study['planned']>[number], now: number): AgendaItem {
    return { kind: 'session', id: s.id, title: s.goal || 'Study session', at: s.plannedAt, courseId: s.courseId, source: 'Planned study', status: s.status, overdue: !!s.plannedAt && s.plannedAt < now, open: { module: 'study', id: s.id } };
  }

  // ---- context boundary for a later AI phase: references the person can already read; no content generated ----
  courseContext(p: Principal, courseId: string): CourseContext {
    const c = this.m.courses.mine(p, courseId);
    return { course: { id: c.id, name: c.name, code: c.code }, topics: this.m.courses.topics(p, courseId).map((t) => ({ id: t.id, title: t.title, state: t.state })),
      references: this.m.courses.links(p, courseId).filter((l) => !l.missing).map((l) => ({ module: l.module, id: l.entityId, title: l.title, kind: l.kind, topicId: l.topicId })) };
  }
  lectureContext(p: Principal, courseId: string, lectureId: string): LectureContext {
    const l = this.m.courses.lectures(p, courseId).find((x) => x.id === lectureId);
    if (!l) throw new Error('Lecture not found.');
    const topics = this.m.courses.topics(p, courseId).filter((t) => l.topicIds.includes(t.id));
    return { lecture: { id: l.id, title: l.title, at: l.at }, topics: topics.map((t) => ({ id: t.id, title: t.title, state: t.state })),
      references: this.m.courses.links(p, courseId, { lectureId }).filter((x) => !x.missing).map((x) => ({ module: x.module, id: x.entityId, title: x.title, kind: x.kind, topicId: x.topicId })) };
  }
  examContext(p: Principal, examId: string): ExamContext {
    const prep = this.m.exams.prep(p, examId);
    return { exam: { id: prep.exam.id, name: prep.exam.name, at: prep.exam.at, courseId: prep.exam.courseId }, topics: prep.topics.map((t) => ({ id: t.id, title: t.title, state: t.state })),
      references: [...prep.exam.refs.map((r) => ({ module: r.module, id: r.entityId, title: '', kind: null, topicId: null })),
        ...this.m.courses.links(p, prep.exam.courseId, { module: 'files' }).filter((l) => l.kind === 'past_paper' && !l.missing).map((l) => ({ module: l.module, id: l.entityId, title: l.title, kind: l.kind, topicId: l.topicId }))],
      dueCards: this.m.flashcards.dueCount(p, { examId }) };
  }
  studyContext(p: Principal): StudyContext {
    const s = this.m.study.active(p);
    return { activeSession: s && { id: s.id, courseId: s.courseId, topicId: s.topicId, goal: s.goal }, upcomingExams: this.m.exams.list(p, { upcoming: true, from: this.now() }).slice(0, 5).map((e) => ({ id: e.id, name: e.name, at: e.at })), dueCards: this.m.flashcards.dueCount(p) };
  }
}

type Ref = { module: string; id: string; title: string; kind: string | null; topicId: string | null };
type TopicRef = { id: string; title: string; state: TopicState };
export type CourseContext = { course: { id: string; name: string; code: string }; topics: TopicRef[]; references: Ref[] };
export type LectureContext = { lecture: { id: string; title: string; at: number | null }; topics: TopicRef[]; references: Ref[] };
export type ExamContext = { exam: { id: string; name: string; at: number; courseId: string }; topics: TopicRef[]; references: Ref[]; dueCards: number };
export type StudyContext = { activeSession: { id: string; courseId: string | null; topicId: string | null; goal: string } | null; upcomingExams: { id: string; name: string; at: number }[]; dueCards: number };

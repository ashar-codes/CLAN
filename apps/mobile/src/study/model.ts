// Phone Study model: the same vocabulary and the same shared algorithms as desktop (@classroom/protocol: SM-2,
// reminder recurrence, countdown, readiness) over one small local document. Pure functions — persistence is store.ts.
// Phone-only: nothing here syncs to a desktop (no cross-device sync exists yet).
import { countdown, nextOccurrence, NEW_CARD, readiness, sm2, type ExamStatus, type Grade, type Recurrence, type TaskStatus, type TopicState } from '@classroom/protocol';

export type MCourse = { id: string; name: string; code: string; term: string; clanId: string | null; createdAt: number };
export type MTopic = { id: string; courseId: string; title: string; position: number; state: TopicState };
export type MTask = { id: string; title: string; courseId: string | null; topicId: string | null; dueAt: number | null; priority: 'low' | 'normal' | 'high'; status: TaskStatus; checklist: { id: string; text: string; done: boolean }[] };
export type MExam = { id: string; courseId: string; name: string; at: number; location: string; topicIds: string[]; status: ExamStatus; grade: string | null; total: string | null; reflection: string | null };
export type MReminder = { id: string; text: string; dueAt: number; anchorAt: number; recurrence: Recurrence; snoozedUntil: number | null; doneAt: number | null; target: { module: string; id: string } | null };
export type MDeck = { id: string; name: string; courseId: string | null; examId: string | null };
export type MCard = { id: string; deckId: string; front: string; back: string; dueAt: number; interval: number; ease: number; reps: number; lapses: number };
export type MReview = { cardId: string; at: number; grade: Grade; intervalAfter: number };
export type MSession = { id: string; courseId: string | null; goal: string; plannedMinutes: number | null; focus: boolean; startedAt: number; endedAt: number | null; reflection: string | null };
/** A reference to something on this phone (an Inbox capture or a downloaded class file) — never a copy. */
export type MLink = { id: string; courseId: string; topicId: string | null; module: 'inbox' | 'file'; entityId: string; title: string };
/** Classroom assignments as last delivered by the host; the Classroom stays authoritative. */
export type MAssignment = { clanId: string; id: string; title: string; dueAt: number | null; closed: boolean; status: 'submitted' | 'late' | 'missing' };
export type StudyState = { v: 1; courses: MCourse[]; topics: MTopic[]; tasks: MTask[]; exams: MExam[]; reminders: MReminder[]; decks: MDeck[]; cards: MCard[]; reviews: MReview[]; sessions: MSession[]; links: MLink[]; assignments: MAssignment[] };
export const EMPTY: StudyState = { v: 1, courses: [], topics: [], tasks: [], exams: [], reminders: [], decks: [], cards: [], reviews: [], sessions: [], links: [], assignments: [] };

type Ctx = { now: number; id(): string };
const DAY = 86_400_000;
const text = (v: string, max: number) => { const t = v.trim(); if (!t || t.length > max) throw new Error(`Enter 1–${max} characters.`); return t; };
const has = <T extends { id: string }>(xs: T[], id: string | null | undefined, what: string) => { if (id && !xs.some((x) => x.id === id)) throw new Error(`${what} not found.`); };

export const S = {
  addCourse(s: StudyState, c: Ctx, o: { name: string; code?: string; term?: string; clanId?: string | null }): StudyState {
    return { ...s, courses: [...s.courses, { id: c.id(), name: text(o.name, 120), code: (o.code ?? '').trim().slice(0, 30), term: (o.term ?? '').trim().slice(0, 60), clanId: o.clanId ?? null, createdAt: c.now }] };
  },
  addTopic(s: StudyState, c: Ctx, courseId: string, title: string): StudyState {
    has(s.courses, courseId, 'Course');
    const pos = s.topics.filter((t) => t.courseId === courseId).length;
    return { ...s, topics: [...s.topics, { id: c.id(), courseId, title: text(title, 160), position: pos, state: 'not_started' }] };
  },
  topics: (s: StudyState, courseId: string) => s.topics.filter((t) => t.courseId === courseId).sort((a, b) => a.position - b.position),
  moveTopic(s: StudyState, topicId: string, index: number): StudyState {
    const t = s.topics.find((x) => x.id === topicId); if (!t) throw new Error('Topic not found.');
    const order = S.topics(s, t.courseId).filter((x) => x.id !== topicId);
    order.splice(Math.max(0, Math.min(index, order.length)), 0, t);
    const pos = new Map(order.map((x, i) => [x.id, i]));
    return { ...s, topics: s.topics.map((x) => (pos.has(x.id) ? { ...x, position: pos.get(x.id)! } : x)) };
  },
  /** The student's own mark; nothing else changes it. */
  setConfidence: (s: StudyState, topicId: string, state: TopicState): StudyState => ({ ...s, topics: s.topics.map((t) => (t.id === topicId ? { ...t, state } : t)) }),
  link(s: StudyState, c: Ctx, o: Omit<MLink, 'id'>): StudyState {
    has(s.courses, o.courseId, 'Course');
    if (s.links.some((l) => l.courseId === o.courseId && l.module === o.module && l.entityId === o.entityId && l.topicId === o.topicId)) return s;
    return { ...s, links: [...s.links, { ...o, id: c.id() }] };
  },
  unlink: (s: StudyState, id: string): StudyState => ({ ...s, links: s.links.filter((l) => l.id !== id) }),

  addTask(s: StudyState, c: Ctx, o: { title: string; courseId?: string | null; topicId?: string | null; dueAt?: number | null; priority?: MTask['priority'] }): StudyState {
    has(s.courses, o.courseId, 'Course');
    if (o.topicId && s.topics.find((t) => t.id === o.topicId)?.courseId !== o.courseId) throw new Error('Topic of another course.');
    return { ...s, tasks: [...s.tasks, { id: c.id(), title: text(o.title, 200), courseId: o.courseId ?? null, topicId: o.topicId ?? null, dueAt: o.dueAt ?? null, priority: o.priority ?? 'normal', status: 'todo', checklist: [] }] };
  },
  setTaskStatus: (s: StudyState, id: string, status: TaskStatus): StudyState => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)) }),

  addExam(s: StudyState, c: Ctx, o: { courseId: string; name: string; at: number; location?: string; topicIds?: string[] }): StudyState {
    has(s.courses, o.courseId, 'Course');
    for (const t of o.topicIds ?? []) if (s.topics.find((x) => x.id === t)?.courseId !== o.courseId) throw new Error('Topic of another course.');
    return { ...s, exams: [...s.exams, { id: c.id(), courseId: o.courseId, name: text(o.name, 160), at: o.at, location: (o.location ?? '').slice(0, 160), topicIds: o.topicIds ?? [], status: 'upcoming', grade: null, total: null, reflection: null }] };
  },
  /** A result exists only when the student types one. */
  setExamStatus: (s: StudyState, id: string, status: ExamStatus, r: { grade?: string; total?: string; reflection?: string } = {}): StudyState =>
    ({ ...s, exams: s.exams.map((e) => (e.id === id ? { ...e, status, grade: status === 'completed' ? r.grade?.trim() || null : null, total: status === 'completed' ? r.total?.trim() || null : null, reflection: status === 'completed' ? r.reflection?.trim() || null : null } : e)) }),
  prep(s: StudyState, examId: string, now: number) {
    const e = s.exams.find((x) => x.id === examId); if (!e) throw new Error('Exam not found.');
    const scope = S.topics(s, e.courseId).filter((t) => e.topicIds.includes(t.id));
    return { exam: e, countdown: countdown(e.at, now), topics: scope, readiness: readiness(scope.map((t) => t.state)), remaining: scope.filter((t) => t.state !== 'confident'),
      links: s.links.filter((l) => l.courseId === e.courseId), dueCards: S.dueCards(s, now, { courseId: e.courseId }), tasks: s.tasks.filter((t) => t.courseId === e.courseId && (t.status === 'todo' || t.status === 'in_progress')) };
  },

  addReminder(s: StudyState, c: Ctx, o: { text: string; dueAt: number; recurrence?: Recurrence; target?: MReminder['target'] }): StudyState {
    return { ...s, reminders: [...s.reminders, { id: c.id(), text: text(o.text, 300), dueAt: o.dueAt, anchorAt: o.dueAt, recurrence: o.recurrence ?? 'none', snoozedUntil: null, doneAt: null, target: o.target ?? null }] };
  },
  /** One-off: closes. Recurring: moves to the next occurrence after now (missed ones are not replayed). */
  reminderDone: (s: StudyState, id: string, now: number): StudyState => ({ ...s, reminders: s.reminders.map((r) => {
    if (r.id !== id) return r;
    const next = nextOccurrence(r.anchorAt, r.recurrence, Math.max(now, r.dueAt));
    return next ? { ...r, dueAt: next, snoozedUntil: null } : { ...r, doneAt: now, snoozedUntil: null };
  }) }),
  snooze: (s: StudyState, id: string, until: number): StudyState => ({ ...s, reminders: s.reminders.map((r) => (r.id === id && !r.doneAt ? { ...r, snoozedUntil: until } : r)) }),

  addDeck(s: StudyState, c: Ctx, o: { name: string; courseId?: string | null; examId?: string | null }): StudyState {
    has(s.courses, o.courseId, 'Course');
    return { ...s, decks: [...s.decks, { id: c.id(), name: text(o.name, 120), courseId: o.courseId ?? null, examId: o.examId ?? null }] };
  },
  addCard(s: StudyState, c: Ctx, deckId: string, front: string, back: string): StudyState {
    has(s.decks, deckId, 'Deck');
    return { ...s, cards: [...s.cards, { id: c.id(), deckId, front: text(front, 2000), back: text(back, 4000), dueAt: c.now, ...NEW_CARD, interval: 0 }] };
  },
  /** Only the cards due now, oldest first, bounded. */
  queue: (s: StudyState, deckId: string, now: number) => s.cards.filter((x) => x.deckId === deckId && x.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt).slice(0, 50),
  review(s: StudyState, cardId: string, grade: Grade, now: number): StudyState {
    const card = s.cards.find((x) => x.id === cardId); if (!card) throw new Error('Card not found.');
    const n = sm2(card, grade, now);
    return { ...s, cards: s.cards.map((x) => (x.id === cardId ? { ...x, ...n } : x)), reviews: [...s.reviews, { cardId, at: now, grade, intervalAfter: n.interval }].slice(-5000) };
  },
  dueCards: (s: StudyState, now: number, o: { courseId?: string } = {}) => {
    const decks = new Set(s.decks.filter((d) => !o.courseId || d.courseId === o.courseId).map((d) => d.id));
    return s.cards.filter((x) => decks.has(x.deckId) && x.dueAt <= now).length;
  },

  active: (s: StudyState) => s.sessions.find((x) => x.endedAt === null) ?? null,
  /** One session at a time: starting another ends the current one. */
  startSession(s: StudyState, c: Ctx, o: { courseId?: string | null; goal?: string; minutes?: number | null; focus?: boolean }): StudyState {
    has(s.courses, o.courseId, 'Course');
    const cur = S.active(s), base = cur ? S.endSession(s, cur.id, c.now) : s;
    return { ...base, sessions: [...base.sessions, { id: c.id(), courseId: o.courseId ?? null, goal: (o.goal ?? '').slice(0, 300), plannedMinutes: o.minutes ?? null, focus: !!o.focus, startedAt: c.now, endedAt: null, reflection: null }] };
  },
  endSession: (s: StudyState, id: string, now: number, reflection?: string): StudyState => ({ ...s, sessions: s.sessions.map((x) => (x.id === id && x.endedAt === null ? { ...x, endedAt: now, reflection: reflection?.trim() || null } : x)) }),
  /** Personal history: minutes and sessions per course since `since`. Never compared with anyone. */
  history(s: StudyState, since: number) {
    const rows = new Map<string | null, { courseId: string | null; sessions: number; minutes: number; reviews: number }>();
    const row = (k: string | null) => rows.get(k) ?? rows.set(k, { courseId: k, sessions: 0, minutes: 0, reviews: 0 }).get(k)!;
    for (const x of s.sessions) if (x.endedAt && x.endedAt >= since) { const r = row(x.courseId); r.sessions++; r.minutes += Math.round((x.endedAt - x.startedAt) / 60_000); }
    const deckCourse = new Map(s.decks.map((d) => [d.id, d.courseId])), cardDeck = new Map(s.cards.map((x) => [x.id, x.deckId]));
    for (const r of s.reviews) if (r.at >= since) row(deckCourse.get(cardDeck.get(r.cardId) ?? '') ?? null).reviews++;
    return [...rows.values()];
  },

  /** Phone joined a Classroom: keep the host's latest list; give the Classroom one linked course (once). */
  seenAssignments(s: StudyState, c: Ctx, clanId: string, clanName: string, list: { id: string; title: string; dueAt: number | null; closed: boolean; latest: { payload: { submittedAt: number; late: boolean } } | null }[]): StudyState {
    const withCourse = s.courses.some((x) => x.clanId === clanId) ? s : S.addCourse(s, c, { name: clanName, clanId });
    return { ...withCourse, assignments: [...withCourse.assignments.filter((a) => a.clanId !== clanId),
      ...list.slice(0, 500).map((a) => ({ clanId, id: a.id, title: a.title.slice(0, 200), dueAt: a.dueAt, closed: a.closed, status: a.latest ? (a.latest.payload.late ? 'late' as const : 'submitted' as const) : 'missing' as const }))] };
  },

  /** Today: overdue + due today (tasks, reminders), missing assignments within a week, exams within two weeks. Projection only. */
  today(s: StudyState, now: number) {
    const end = new Date(now); end.setHours(23, 59, 59, 999); const e = end.getTime();
    const courseOfClan = new Map(s.courses.filter((x) => x.clanId).map((x) => [x.clanId!, x.id]));
    type Item = { kind: 'task' | 'reminder' | 'assignment' | 'exam'; id: string; title: string; at: number | null; source: string; overdue: boolean; courseId: string | null };
    const items: Item[] = [
      ...s.tasks.filter((t) => (t.status === 'todo' || t.status === 'in_progress') && t.dueAt !== null && t.dueAt <= e).map((t) => ({ kind: 'task' as const, id: t.id, title: t.title, at: t.dueAt, source: 'Task', overdue: t.dueAt! < now, courseId: t.courseId })),
      ...s.reminders.filter((r) => !r.doneAt && (r.snoozedUntil ?? r.dueAt) <= e).map((r) => ({ kind: 'reminder' as const, id: r.id, title: r.text, at: r.snoozedUntil ?? r.dueAt, source: 'Reminder', overdue: (r.snoozedUntil ?? r.dueAt) < now, courseId: null })),
      ...s.assignments.filter((a) => !a.closed && a.status === 'missing' && a.dueAt !== null && a.dueAt <= now + 7 * DAY).map((a) => ({ kind: 'assignment' as const, id: a.id, title: a.title, at: a.dueAt, source: 'Classroom assignment', overdue: a.dueAt! < now, courseId: courseOfClan.get(a.clanId) ?? null })),
      ...s.exams.filter((x) => x.status === 'upcoming' && x.at >= now - DAY && x.at <= now + 14 * DAY).map((x) => ({ kind: 'exam' as const, id: x.id, title: x.name, at: x.at, source: 'Exam', overdue: false, courseId: x.courseId })),
    ];
    return items.sort((a, b) => (a.at ?? 9e15) - (b.at ?? 9e15));
  },
};

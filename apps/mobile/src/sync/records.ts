// Phone study data as personal-sync change records: the same wire shapes the desktop modules apply (see docs/SYNC.md).
// Since the phone runs @clan/core itself, this is used once: to move the phone's pre-core study.json into core
// (`sync.importLocal`). Owner columns never travel; each device applies records as its own local user.
import { contentHash, hlc, type SyncRecord } from '@classroom/protocol';
import type { StudyState } from '../study/model';

type Wire = { kind: string; id: string; payload: Record<string, unknown> };
const b = (v: boolean) => (v ? 1 : 0);

export function phoneWire(s: StudyState): Wire[] {
  return [
    ...s.courses.map((c) => ({ kind: 'course', id: c.id, payload: { name: c.name, code: c.code, instructor: '', term: c.term, schedule: '', created_at: c.createdAt, updated_at: c.createdAt, archived_at: null,
      '~courses_topics': s.topics.filter((t) => t.courseId === c.id).map((t) => ({ id: t.id, course_id: c.id, title: t.title, position: t.position, confidence: t.state, confidence_at: null, created_at: c.createdAt })),
      '~courses_lectures': [], '~courses_lecture_topics': [], '~courses_links': [] } })),
    ...s.tasks.map((t) => ({ kind: 'task', id: t.id, payload: { title: t.title, description: '', course_id: t.courseId, topic_id: t.topicId, clan_id: null, due_at: t.dueAt, priority: t.priority, status: t.status,
      done_at: null, created_at: 0, updated_at: 0, '~tasks_checklist': t.checklist.map((x, i) => ({ id: x.id, task_id: t.id, text: x.text, done: b(x.done), position: i })), '~tasks_refs': [] } })),
    ...s.exams.map((e) => ({ kind: 'exam', id: e.id, payload: { course_id: e.courseId, name: e.name, at: e.at, location: e.location, status: e.status, notes: '', grade: e.grade, total: e.total, reflection: e.reflection,
      created_at: 0, updated_at: 0, '~exams_topics': e.topicIds.map((topic_id) => ({ exam_id: e.id, topic_id })), '~exams_refs': [] } })),
    ...s.reminders.map((r) => ({ kind: 'reminder', id: r.id, payload: { text: r.text, due_at: r.dueAt, target_module: r.target?.module ?? null, target_id: r.target?.id ?? null, done_at: r.doneAt, created_at: 0,
      recurrence: r.recurrence, anchor_at: r.anchorAt, snoozed_until: r.snoozedUntil, dismissed_at: null } })),
    ...s.sessions.filter((x) => x.endedAt !== null).map((x) => ({ kind: 'study-session', id: x.id, payload: { course_id: x.courseId, topic_id: null, goal: x.goal, planned_at: null, planned_minutes: x.plannedMinutes,
      status: 'ended', focus: b(x.focus), started_at: x.startedAt, ended_at: x.endedAt, reflection: x.reflection, created_at: x.startedAt } })),
    ...s.decks.map((d) => ({ kind: 'deck', id: d.id, payload: { name: d.name, course_id: d.courseId, topic_id: null, exam_id: d.examId, created_at: 0,
      '~flashcards_cards': s.cards.filter((k) => k.deckId === d.id).map((k) => ({ id: k.id, deck_id: d.id, front: k.front, back: k.back, note: '', ref_module: null, ref_id: null, created_at: 0 })) } })),
    // phone reviews had no ids: card + time identifies one. The schedule is recomputed from reviews on arrival.
    ...s.reviews.map((r) => ({ kind: 'review', id: `${r.cardId}:${r.at}`, payload: { card_id: r.cardId, at: r.at, grade: r.grade, interval_before: 0, interval_after: r.intervalAfter, ease_after: 2.5, due_after: r.at } })),
  ];
}

/** New change records for what differs from `known` (id → hash already sent). Pure; the caller keeps `known`. */
export function phoneChanges(s: StudyState, known: Map<string, string>, o: { now: number; device: string }): SyncRecord[] {
  let n = 0;
  return phoneWire(s).flatMap((w) => {
    const hash = contentHash(w.payload), prev = known.get(`${w.kind}:${w.id}`);
    return prev === hash ? [] : [{ kind: w.kind, id: w.id, version: hlc(o.now, n++, o.device), hash, history: prev ? [prev] : [], deleted: false, payload: w.payload }];
  });
}

// Study Engine vocabulary and the few pure algorithms every platform must compute identically (desktop and mobile):
// SM-2 flashcard scheduling, reminder recurrence, exam countdown and the one transparent readiness measure.
// No inference: confidence is what the student marked; readiness is a count of their own marks.

export const TOPIC_STATES = ['not_started', 'learning', 'review', 'confident'] as const;
export type TopicState = (typeof TOPIC_STATES)[number];
export const TOPIC_STATE_LABEL: Record<TopicState, string> = { not_started: 'Not started', learning: 'Learning', review: 'Needs review', confident: 'Confident' };
export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const EXAM_STATUSES = ['upcoming', 'completed', 'cancelled'] as const;
export type ExamStatus = (typeof EXAM_STATUSES)[number];
export const RESOURCE_KINDS = ['lecture_material', 'past_paper', 'assignment', 'book', 'reference', 'other'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const RESOURCE_KIND_LABEL: Record<ResourceKind, string> = { lecture_material: 'Lecture material', past_paper: 'Past paper', assignment: 'Assignment', book: 'Book', reference: 'Reference', other: 'Other' };
export const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'] as const;
export type Recurrence = (typeof RECURRENCES)[number];
export const GRADES = ['again', 'hard', 'good', 'easy'] as const;
export type Grade = (typeof GRADES)[number];

// ---- SM-2 (SuperMemo 2, Woźniak 1990) ----
/** Card memory state: interval in days, easiness factor (≥ 1.3), successful repetitions in a row, lapses. */
export type CardState = { interval: number; ease: number; reps: number; lapses: number };
export const NEW_CARD: CardState = { interval: 0, ease: 2.5, reps: 0, lapses: 0 };
/** Button → SM-2 quality (0–5): Again 2 (fail), Hard 3, Good 4, Easy 5. */
export const QUALITY: Record<Grade, number> = { again: 2, hard: 3, good: 4, easy: 5 };
const DAY = 86_400_000;

/**
 * One review. Exactly SM-2: q < 3 → repetitions restart (interval 1 day); otherwise interval 1, then 6, then
 * round(previous × EF). EF' = EF + (0.1 − (5 − q)(0.08 + (5 − q)·0.02)), never below 1.3.
 * Again also shows the card once more in 10 minutes (same day), which SM-2 leaves to the application.
 */
export function sm2(s: CardState, g: Grade, now: number): CardState & { dueAt: number } {
  const q = QUALITY[g];
  const ease = Math.max(1.3, s.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  if (q < 3) return { interval: 1, ease, reps: 0, lapses: s.lapses + 1, dueAt: now + 10 * 60_000 };
  const reps = s.reps + 1;
  const interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(s.interval * ease);
  return { interval, ease, reps, lapses: s.lapses, dueAt: now + interval * DAY };
}

// ---- reminders ----
/** Wall-clock arithmetic in local time (so "every Monday 09:00" stays 09:00 across DST). Monthly clamps to month end. */
function addPeriods(anchor: number, r: Exclude<Recurrence, 'none'>, k: number): number {
  const d = new Date(anchor);
  if (r === 'daily') d.setDate(d.getDate() + k);
  else if (r === 'weekly') d.setDate(d.getDate() + 7 * k);
  else {
    const day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + k);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return d.getTime();
}
/** The first occurrence strictly after `after`, counted from the original `anchor` (no drift from clamped months). */
export function nextOccurrence(anchor: number, r: Recurrence, after: number): number | null {
  if (r === 'none') return null;
  const per = r === 'daily' ? DAY : r === 'weekly' ? 7 * DAY : 28 * DAY;
  let k = Math.max(1, Math.floor((after - anchor) / per) - 1);
  while (addPeriods(anchor, r, k) <= after) k++;
  while (k > 1 && addPeriods(anchor, r, k - 1) > after) k--;
  return addPeriods(anchor, r, k);
}

// ---- exams ----
export function countdown(at: number, now: number): { past: boolean; days: number; hours: number; label: string } {
  const ms = at - now, past = ms < 0, abs = Math.abs(ms);
  const days = Math.floor(abs / DAY), hours = Math.floor((abs % DAY) / 3_600_000);
  const label = past ? 'Started' : days >= 2 ? `${days} days` : days === 1 ? `1 day ${hours} h` : hours >= 1 ? `${hours} h` : `${Math.max(1, Math.round(abs / 60_000))} min`;
  return { past, days, hours, label };
}
/**
 * The only readiness CLAN shows: how many topics in the exam's scope the student has marked Confident, out of all
 * topics in scope — plus the full breakdown by their own marks. Null when there is no scope (nothing to count).
 */
export function readiness(states: TopicState[]): { confident: number; total: number; byState: Record<TopicState, number>; label: string } | null {
  if (!states.length) return null;
  const byState = Object.fromEntries(TOPIC_STATES.map((s) => [s, states.filter((x) => x === s).length])) as Record<TopicState, number>;
  return { confident: byState.confident, total: states.length, byState, label: `${byState.confident} of ${states.length} topics marked Confident` };
}

// Phone Study model (pure): same algorithms as desktop, persisted by store.ts. Runtime on devices is UNVERIFIED.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { EMPTY, S } from '../src/study/model.ts';

it('phone study model: course → topics → exam prep, tasks, SM-2 cards, recurring reminder, session, assignment projection', () => {
  let now = new Date(2027, 2, 10, 8).getTime();
  const k = () => ({ now, id: randomUUID });
  let s = S.addCourse(EMPTY, k(), { name: 'OS', code: 'CS-330' });
  const os = s.courses[0]!.id;
  s = S.addTopic(s, k(), os, 'Processes'); s = S.addTopic(s, k(), os, 'Deadlocks');
  const [a, b] = S.topics(s, os);
  s = S.moveTopic(s, b!.id, 0);
  expect(S.topics(s, os).map((t) => t.title)).toEqual(['Deadlocks', 'Processes']);
  s = S.setConfidence(s, a!.id, 'confident');
  s = S.addExam(s, k(), { courseId: os, name: 'Midterm', at: now + 5 * 86_400_000, topicIds: [a!.id, b!.id] });
  expect(S.prep(s, s.exams[0]!.id, now)).toMatchObject({ readiness: { label: '1 of 2 topics marked Confident' }, countdown: { label: '5 days' } });
  expect(() => S.addExam(s, k(), { courseId: 'nope', name: 'x', at: now })).toThrow(/Course not found/);
  expect(S.setExamStatus(s, s.exams[0]!.id, 'completed').exams[0]).toMatchObject({ grade: null, total: null }); // nothing invented
  const graded = S.setExamStatus(s, s.exams[0]!.id, 'completed', { grade: 'B+' });
  expect(S.setExamStatus(graded, s.exams[0]!.id, 'upcoming').exams[0]!.grade).toBe('B+'); // reopening keeps it

  s = S.addTask(s, k(), { title: 'PS3', courseId: os, dueAt: now + 3_600_000 });
  s = S.addReminder(s, k(), { text: 'Gym', dueAt: now + 60_000, recurrence: 'weekly' });
  s = S.addDeck(s, k(), { name: 'Terms', courseId: os });
  s = S.addCard(s, k(), s.decks[0]!.id, 'TLB', 'Translation lookaside buffer');
  expect(S.dueCards(s, now, { courseId: os })).toBe(1);
  s = S.review(s, s.cards[0]!.id, 'good', now);
  expect(s.cards[0]).toMatchObject({ interval: 1, reps: 1 });
  expect(S.queue(s, s.decks[0]!.id, now)).toEqual([]);

  s = S.seenAssignments(s, k(), 'clan-1', 'CS402', [{ id: 'x', title: 'Lab 2', dueAt: now + 86_400_000, closed: false, latest: null }]);
  s = S.seenAssignments(s, k(), 'clan-1', 'CS402', [{ id: 'x', title: 'Lab 2', dueAt: now + 86_400_000, closed: false, latest: null }]);
  expect(s.courses.filter((c) => c.clanId === 'clan-1')).toHaveLength(1); // linked once
  expect(S.today(s, now).map((i) => [i.kind, i.title])).toEqual([['reminder', 'Gym'], ['task', 'PS3'], ['assignment', 'Lab 2'], ['exam', 'Midterm']]);
  expect(s.tasks).toHaveLength(1); // the assignment is not a task

  const rem = s.reminders[0]!;
  now += 120_000;
  s = S.reminderDone(s, rem.id, now);
  expect(s.reminders[0]!.dueAt).toBe(rem.dueAt + 7 * 86_400_000);

  s = S.startSession(s, k(), { courseId: os, goal: 'Paging', focus: true });
  now += 25 * 60_000;
  s = S.startSession(s, k(), { goal: 'Other' }); // starting another ends the first
  expect(s.sessions.filter((x) => x.endedAt === null)).toHaveLength(1);
  expect(S.history(s, 0).find((r) => r.courseId === os)).toMatchObject({ sessions: 1, minutes: 25, reviews: 1 });
});

it('phone Guide: grounded answer cites only phone study data; drafted cards are drafts', async () => {
  const { deterministicProvider } = await import('@classroom/protocol');
  const { ask, draftCards } = await import('../src/study/ai.ts');
  const now = Date.now(), k = () => ({ now, id: randomUUID });
  let s = S.addCourse(EMPTY, k(), { name: 'OS' }); const os = s.courses[0]!.id;
  s = S.addTopic(s, k(), os, 'Deadlocks');
  s = S.addDeck(s, k(), { name: 'Terms', courseId: os });
  s = S.addCard(s, k(), s.decks[0]!.id, 'Coffman conditions', 'Mutual exclusion is a Coffman condition.');
  const r = await ask(deterministicProvider(), s, { kind: 'course', courseId: os }, 'Coffman conditions mutual exclusion');
  expect(r.citations.map((c) => c.label)).toEqual(['Card: Terms']);
  expect((await ask(deterministicProvider(), s, { kind: 'course', courseId: os }, 'photosynthesis chlorophyll')).answer.notFound).toBe(true);
  const before = s.cards.length;
  await draftCards(deterministicProvider(), s, os);
  expect(s.cards.length).toBe(before); // nothing added by drafting
});

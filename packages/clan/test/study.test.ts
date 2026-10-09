import { describe, expect, it } from 'vitest';
import { nextOccurrence, readiness, sm2, MAX_INTERVAL_DAYS, NEW_CARD } from '@classroom/protocol';
import type { DeliveredNotice } from '../src/index.ts';
import { file, setup, tmp, user } from './helpers.ts';

const DAY = 86_400_000;

describe('study algorithms', () => {
  it('SM-2 intervals stay bounded under many Easy reviews (no overflow, a real date)', () => {
    let s = { ...NEW_CARD, dueAt: 0 };
    for (let i = 0; i < 500; i++) s = sm2(s, 'easy', Date.UTC(2026, 0, 1));
    expect(s.interval).toBe(MAX_INTERVAL_DAYS);
    expect(Number.isSafeInteger(s.dueAt)).toBe(true);
    expect(new Date(s.dueAt).getUTCFullYear()).toBe(2125);
  });
  it('SM-2: 1, 6, then ×EF; Again restarts and shows again in 10 min; EF floor 1.3', () => {
    let s = sm2(NEW_CARD, 'good', 0);
    expect(s.interval).toBe(1);
    s = sm2(s, 'good', 0);
    expect(s.interval).toBe(6);
    s = sm2(s, 'good', 0);
    expect(s.interval).toBe(15); // round(6 × 2.5)
    const lapse = sm2(s, 'again', 0);
    expect(lapse).toMatchObject({ reps: 0, interval: 1, lapses: 1, dueAt: 10 * 60_000 });
    let e = NEW_CARD;
    for (let i = 0; i < 20; i++) e = sm2(e, 'again', 0);
    expect(e.ease).toBe(1.3);
  });

  it('recurrence counts from the anchor: monthly clamps to month end without drifting', () => {
    const jan31 = new Date(2027, 0, 31, 9).getTime();
    const feb = nextOccurrence(jan31, 'monthly', jan31)!;
    expect(new Date(feb).getDate()).toBe(28);
    expect(new Date(nextOccurrence(jan31, 'monthly', feb)!).getDate()).toBe(31); // March 31, not 28
    expect(new Date(nextOccurrence(jan31, 'weekly', jan31 + 10 * DAY)!).getHours()).toBe(9);
    expect(nextOccurrence(jan31, 'none', jan31)).toBeNull();
    expect(nextOccurrence(jan31, 'daily', jan31 + 1000 * DAY)).toBe(new Date(2029, 9, 28, 9).getTime());
  });

  it('readiness is only a count of the student\'s own marks', () => {
    expect(readiness([])).toBeNull();
    expect(readiness(['confident', 'learning', 'confident'])).toMatchObject({ confident: 2, total: 3, label: '2 of 3 topics marked Confident' });
  });
});

describe('study engine', () => {
  it('course → exam prep, tasks, cards, reminders, sessions; Today projects them; notices fire once; nothing leaks', () => {
    let t = new Date(2027, 2, 10, 8).getTime();
    const { app } = setup({ now: () => t });
    const me = user(app.me), bob = user(app.identity.createUser('Bob'));
    const notices: DeliveredNotice[] = [];
    app.notifications.onNotice = (n) => notices.push(n);

    const os = app.courses.create(me, { name: 'Operating Systems', code: 'CS-330' });
    const [sched, mem] = ['Scheduling', 'Memory'].map((x) => app.courses.addTopic(me, os.id, x));
    app.courses.setConfidence(me, sched!.id, 'confident');

    const exam = app.exams.create(me, { courseId: os.id, name: 'Midterm', at: t + 5 * DAY, topicIds: [sched!.id, mem!.id] });
    const prep = app.exams.prep(me, exam.id);
    expect(prep.readiness?.label).toBe('1 of 2 topics marked Confident');
    expect(prep.remaining.map((x) => x.title)).toEqual(['Memory']);
    expect(prep.countdown.label).toBe('5 days');

    const task = app.tasks.create(me, { title: 'Problem set 3', courseId: os.id, topicId: mem!.id, dueAt: t + 4 * 3_600_000, checklist: ['Q1', 'Q2'] });
    expect(task.checklist).toHaveLength(2);
    expect(() => app.tasks.create(me, { title: 'x', courseId: os.id, topicId: app.courses.addTopic(me, app.courses.create(me, { name: 'Other' }).id, 'T').id })).toThrow(/another course/);

    const deck = app.flashcards.createDeck(me, { name: 'OS terms', courseId: os.id, examId: exam.id });
    const card = app.flashcards.addCard(me, deck.id, { front: 'TLB', back: 'Translation lookaside buffer' });
    expect(app.flashcards.queue(me, deck.id).map((c) => c.id)).toEqual([card.id]);
    app.flashcards.review(me, card.id, 'good');
    expect(app.flashcards.queue(me, deck.id)).toEqual([]);
    expect(app.flashcards.history(me, card.id)).toHaveLength(1);

    const rem = app.reminders.create(me, { text: 'Lab report', dueAt: t + 3_600_000, recurrence: 'weekly', target: { module: 'courses', id: os.id } });
    app.study.plan(me, { courseId: os.id, goal: 'Paging', at: t + 2 * 3_600_000 });

    const today = app.agenda.today(me);
    expect(today.map((i) => i.kind)).toEqual(['reminder', 'session', 'task', 'exam']);
    expect(today.every((i) => i.courseId === os.id)).toBe(true);

    // reminder rings once per occurrence; done moves a weekly one forward a week
    t += 3_600_000;
    app.tick();
    app.tick();
    expect(notices.filter((n) => n.kind === 'reminder')).toHaveLength(1);
    expect(notices.filter((n) => n.kind === 'task')).toHaveLength(1);
    app.reminders.done(me, rem.id);
    expect(app.reminders.get(me, rem.id)!.dueAt).toBe(rem.dueAt + 7 * DAY);

    // focus session: non-critical notices are kept but don't alert; ending reports minutes
    const s = app.study.start(me, { courseId: os.id, focus: true });
    t += 50 * 60_000;
    app.tick(); // planned "Paging" session is now ≤ 10 min away
    expect(notices.find((n) => n.kind === 'study')).toMatchObject({ alert: false });
    expect(app.study.end(me, s.id, 'ok').status).toBe('ended');
    expect(app.study.history(me, 0)).toEqual([{ courseId: os.id, sessions: 1, minutes: 50, topics: 0 }]);

    // another person sees none of it and can't touch it
    expect(app.courses.list(bob)).toEqual([]);
    expect(app.tasks.list(bob)).toEqual([]);
    expect(app.agenda.today(bob)).toEqual([]);
    expect(() => app.exams.prep(bob, exam.id)).toThrow(/not found/);
    expect(() => app.flashcards.review(bob, card.id, 'easy')).toThrow(/not found/);
    expect(() => app.tasks.create(bob, { title: 'x', courseId: os.id })).toThrow(/Course not found/);
    expect(app.search.query(me, 'TLB').length).toBeGreaterThan(0);
    expect(app.search.query(bob, 'TLB')).toEqual([]);
  });
});

describe('course references, ordering, projection, lifecycles', () => {
  it('links notes / one canonical resource / saved by reference; ordering is explicit; another person can\'t link or see', async () => {
    let t = new Date(2027, 2, 10, 8).getTime();
    const { app } = setup({ now: () => t });
    const me = user(app.me), bob = user(app.identity.createUser('Bob'));
    const os = app.courses.create(me, { name: 'OS' }), db = app.courses.create(me, { name: 'Databases' });
    const [a, b, c] = ['Processes', 'Scheduling', 'Deadlocks'].map((x) => app.courses.addTopic(me, os.id, x));
    app.courses.moveTopic(me, c!.id, 0);
    expect(app.courses.topics(me, os.id).map((x) => x.title)).toEqual(['Deadlocks', 'Processes', 'Scheduling']);
    const l2 = app.courses.addLecture(me, os.id, { title: 'L2', topicIds: [b!.id] });
    app.courses.addLecture(me, os.id, { title: 'L3' });
    expect(app.courses.lectures(me, os.id).map((l) => [l.title, l.topicIds])).toEqual([['L2', [b!.id]], ['L3', []]]);
    expect(() => app.courses.addLecture(me, db.id, { title: 'x', topicIds: [a!.id] })).toThrow(/another course/);

    // one PDF in two places = one stored object; the course keeps references, typed as a past paper
    const dir = tmp();
    const f1 = await app.files.add(me, file(dir, 'mid.pdf', 'same bytes'), 'mid.pdf', { kind: 'personal', ownerId: app.me });
    const f2 = await app.files.add(me, file(dir, 'mid-copy.pdf', 'same bytes'), 'mid-copy.pdf', { kind: 'personal', ownerId: app.me });
    expect(f2.objectId).toBe(f1.objectId);
    const note = app.notes.create(me, { title: 'Banker\'s algorithm', body: 'safe state' });
    const link = app.saved.add(me, { url: 'https://example.com/deadlocks' });
    app.courses.link(me, os.id, { module: 'files', entityId: f1.refId, kind: 'past_paper' });
    app.courses.link(me, os.id, { module: 'notes', entityId: note.id, topicId: c!.id, lectureId: l2.id });
    const sl = app.courses.link(me, os.id, { module: 'saved', entityId: link.id, topicId: c!.id });
    app.courses.link(me, os.id, { module: 'saved', entityId: link.id, topicId: c!.id }); // idempotent
    expect(app.courses.links(me, os.id).map((l) => [l.module, l.title, l.kind])).toEqual(expect.arrayContaining([['files', 'mid.pdf', 'past_paper'], ['notes', 'Banker\'s algorithm', null], ['saved', expect.any(String), null]]));
    expect(app.courses.links(me, os.id)).toHaveLength(3);
    expect(app.courses.links(me, os.id, { lectureId: l2.id }).map((l) => l.entityId)).toEqual([note.id]);
    // the note stays a note: editing it shows in the course; removing the reference keeps the saved item
    app.notes.update(me, note.id, { title: 'Banker' });
    expect(app.courses.links(me, os.id, { module: 'notes' })[0]!.title).toBe('Banker');
    app.courses.unlink(me, sl.id);
    expect(app.saved.get(me, link.id)).not.toBeNull();
    expect(app.notes.get(bob, note.id)).toBeNull(); // still private
    // deleted source → reference shows as missing, never resurrected
    app.notes.remove(me, note.id);
    expect(app.courses.links(me, os.id, { module: 'notes' })[0]).toMatchObject({ missing: true, title: 'No longer available' });
    // isolation: Bob can't read my course, can't link my items into his own course, and courses don't mix
    const bobs = app.courses.create(bob, { name: 'Bob OS' });
    expect(() => app.courses.link(bob, bobs.id, { module: 'files', entityId: f1.refId })).toThrow(/Not found/);
    expect(() => app.courses.links(bob, os.id)).toThrow(/Course not found/);
    expect(() => app.courses.link(me, db.id, { module: 'saved', entityId: link.id, topicId: a!.id })).toThrow(/another course/);
    expect(app.courses.links(me, db.id)).toEqual([]);
    t += 1;
  });

  it('member device: a Classroom assignment is a projection with the receipt\'s status, shown in Today, never a Task', () => {
    const t = new Date(2027, 2, 10, 8).getTime();
    const { app } = setup({ now: () => t });
    const me = user(app.me);
    const clan = app.clans.recordJoined({ id: crypto.randomUUID(), type: 'CLASSROOM', name: 'CS402', hostDeviceId: 'host-dev', hostName: 'Dr. Rana', me: app.me });
    app.courses.linkClassrooms(me);
    const course = app.courses.forClan(me, clan.id)!;
    const due = t + 2 * DAY;
    app.assignments.seen(me, clan.id, [
      { id: 'a1', title: 'Lab 2', dueAt: due, closed: false, latest: null, instructions: 'ignored extra fields' },
      { id: 'a2', title: 'Lab 1', dueAt: t - DAY, closed: false, latest: { payload: { submittedAt: t - 2 * DAY, late: false } } },
    ]);
    expect(app.assignments.list(me).map((a) => [a.title, a.status])).toEqual([['Lab 1', 'submitted'], ['Lab 2', 'missing']]);
    expect(app.agenda.today(me).filter((i) => i.kind === 'assignment')).toMatchObject([{ title: 'Lab 2', source: 'Classroom assignment', courseId: course.id, open: { module: 'assignments', clanId: clan.id } }]);
    expect(app.tasks.list(me)).toEqual([]);
    // a newer list from the host replaces the projection (the Classroom stays authoritative)
    app.assignments.seen(me, clan.id, [{ id: 'a1', title: 'Lab 2', dueAt: due, closed: false, latest: { payload: { submittedAt: t, late: true } } }]);
    expect(app.assignments.list(me).map((a) => [a.title, a.status])).toEqual([['Lab 2', 'late']]);
    // not a member → ignored
    app.assignments.seen(user(app.identity.createUser('Eve')), clan.id, []);
    expect(app.assignments.list(me)).toHaveLength(1);
  });

  it('exam lifecycle stores only what the student enters; reminders snooze / dismiss / recur in the calendar', () => {
    let t = new Date(2027, 2, 10, 8).getTime();
    const { app } = setup({ now: () => t });
    const me = user(app.me);
    const os = app.courses.create(me, { name: 'OS' });
    const e = app.exams.create(me, { courseId: os.id, name: 'Final', at: t + 3 * DAY });
    expect(app.exams.prep(me, e.id).readiness).toBeNull(); // no scope → nothing to count, no invented number
    expect(app.exams.setStatus(me, e.id, 'completed')).toMatchObject({ status: 'completed', grade: null, total: null, reflection: null });
    expect(app.exams.setStatus(me, e.id, 'completed', { grade: 'A-', total: '87%', reflection: 'fine' })).toMatchObject({ grade: 'A-', total: '87%' });
    // regression: reopening / cancelling / editing never erases the recorded result; only an explicit clear does
    expect(app.exams.setStatus(me, e.id, 'upcoming')).toMatchObject({ status: 'upcoming', grade: 'A-', total: '87%', reflection: 'fine' });
    expect(app.exams.update(me, e.id, { name: 'Final exam' })).toMatchObject({ grade: 'A-', reflection: 'fine' });
    expect(app.exams.setStatus(me, e.id, 'completed', { reflection: 'better than I thought' })).toMatchObject({ grade: 'A-', reflection: 'better than I thought' });
    expect(app.exams.setStatus(me, e.id, 'completed', { grade: '' })).toMatchObject({ grade: null, total: '87%' });
    expect(app.exams.setStatus(me, e.id, 'cancelled').total).toBe('87%');
    expect(app.agenda.range(me, t, t + 7 * DAY).filter((i) => i.kind === 'exam')).toEqual([]); // cancelled leaves the board

    const r = app.reminders.create(me, { text: 'Gym', dueAt: t + 3_600_000, recurrence: 'daily' });
    expect(app.reminders.between(me, t, t + 3 * DAY).map((x) => x.at)).toEqual([0, 1, 2].map((k) => r.dueAt + k * DAY));
    t += 3_600_000;
    expect(app.reminders.fire().map((x) => x.reminderId)).toEqual([r.id]);
    app.reminders.snooze(me, r.id, t + 600_000);
    expect(app.reminders.fire()).toEqual([]);
    t += 600_000;
    expect(app.reminders.fire()).toHaveLength(1); // the snoozed occurrence rings once more
    app.reminders.dismiss(me, r.id);
    expect(app.reminders.get(me, r.id)).toMatchObject({ dueAt: r.dueAt + DAY, doneAt: null, snoozedUntil: null }); // recurring: next occurrence
    const once = app.reminders.create(me, { text: 'Pay fee', dueAt: t + 1000 });
    app.reminders.dismiss(me, once.id);
    expect(app.reminders.get(me, once.id)).toMatchObject({ doneAt: t, dismissedAt: t });
    expect(() => app.reminders.snooze(me, once.id, t + 1)).toThrow(/closed/);
  });

  it('works with networking disabled (everything is local)', () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('network used'); }) as typeof fetch;
    try {
      const { app } = setup();
      const me = user(app.me);
      const c = app.courses.create(me, { name: 'Offline' });
      const tp = app.courses.addTopic(me, c.id, 'T');
      app.tasks.create(me, { title: 'x', courseId: c.id, dueAt: Date.now() + 1000 });
      app.exams.create(me, { courseId: c.id, name: 'E', at: Date.now() + DAY, topicIds: [tp.id] });
      const d = app.flashcards.createDeck(me, { name: 'D', courseId: c.id });
      app.flashcards.review(me, app.flashcards.addCard(me, d.id, { front: 'q', back: 'a' }).id, 'easy');
      app.study.end(me, app.study.start(me, { courseId: c.id }).id);
      app.reminders.create(me, { text: 'r', dueAt: Date.now() + 1000 });
      app.tick();
      expect(app.agenda.today(me).length).toBeGreaterThan(0);
    } finally { globalThis.fetch = real; }
  });
});

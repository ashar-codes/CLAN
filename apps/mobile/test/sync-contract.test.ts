// The phone's study data as personal-sync records, applied by a real desktop CLAN database (the shared contract;
// the phone has no sync transport yet).
import { describe, expect, it } from 'vitest';
import { phoneChanges } from '../src/sync/records.ts';
import { EMPTY } from '../src/study/model.ts';
import { clock, device, link } from '../../../packages/clan/test/sync-helpers.ts';

describe('phone contract', () => {
  it('the phone\'s study records are the shapes desktop modules apply (and unchanged data produces no records)', async () => {
    const a = device('MacBook'), phone = device('Phone'); link(a, phone);
    const st = { ...EMPTY, courses: [{ id: 'c-1', name: 'Physics', code: 'PH1', term: 'F26', clanId: null, createdAt: clock.t }], topics: [{ id: 't-1', courseId: 'c-1', title: 'Optics', position: 0, state: 'learning' as const }],
      tasks: [{ id: 'k-1', title: 'Lab report', courseId: 'c-1', topicId: null, dueAt: clock.t + 1e6, priority: 'high' as const, status: 'todo' as const, checklist: [{ id: 'i-1', text: 'Graphs', done: true }] }],
      exams: [{ id: 'e-1', courseId: 'c-1', name: 'Midterm', at: clock.t + 2e6, location: 'Hall', topicIds: ['t-1'], status: 'upcoming' as const, grade: null, total: null, reflection: null }],
      reminders: [{ id: 'r-1', text: 'Revise', dueAt: clock.t + 5e5, anchorAt: clock.t + 5e5, recurrence: 'none' as const, snoozedUntil: null, doneAt: null, target: null }],
      sessions: [{ id: 's-1', courseId: 'c-1', goal: 'optics', plannedMinutes: 30, focus: true, startedAt: clock.t - 3e6, endedAt: clock.t - 1e6, reflection: 'ok' }] };
    const recs = phoneChanges(st, new Map(), { now: clock.t, device: phone.fp });
    expect((await a.app.sync.applyBatch(phone.fp, recs)).accepted).toBe(5);
    expect(a.app.courses.topics(a.me, 'c-1').map((x) => [x.title, x.state])).toEqual([['Optics', 'learning']]);
    expect(a.app.tasks.get(a.me, 'k-1')).toMatchObject({ title: 'Lab report', priority: 'high', checklist: [{ text: 'Graphs', done: true }] });
    expect(a.app.exams.get(a.me, 'e-1')?.topicIds).toEqual(['t-1']);
    expect(a.app.reminders.get(a.me, 'r-1')?.text).toBe('Revise');
    expect(a.app.study.recent(a.me).map((x) => x.goal)).toEqual(['optics']);
    expect(phoneChanges(st, new Map(recs.map((r) => [`${r.kind}:${r.id}`, r.hash])), { now: clock.t, device: phone.fp })).toEqual([]);
  });
  it('importLocal moves the old phone study.json (incl. decks, cards and reviews) into core on the phone', () => {
    const phone = device('Phone');
    const st = { ...EMPTY, decks: [{ id: 'd-1', name: 'Optics', courseId: null, examId: null }], cards: [{ id: 'k-9', deckId: 'd-1', front: 'f', back: 'b', dueAt: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0 }],
      reviews: [{ cardId: 'k-9', at: clock.t, grade: 'good' as const, intervalAfter: 1 }, { cardId: 'k-9', at: clock.t + 1, grade: 'good' as const, intervalAfter: 6 }] };
    expect(phone.app.sync.importLocal(phoneChanges(st, new Map(), { now: clock.t, device: phone.fp }))).toBe(3);
    expect(phone.app.flashcards.card(phone.me, 'k-9')).toMatchObject({ reps: 2, interval: 6 });
    expect(phone.app.sync.importLocal(phoneChanges(st, new Map(), { now: clock.t, device: phone.fp }))).toBe(3); // idempotent
    expect(phone.app.flashcards.history(phone.me, 'k-9')).toHaveLength(2);
  });
});

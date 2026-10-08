// Study Tapes: lifecycle, timestamped timeline, media as one canonical Resource (moved, not copied), Course/Lecture
// references, personal-by-default privacy, search to a timestamp, and AI context only on explicit inclusion.
import { describe, expect, it } from 'vitest';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deterministicProvider } from '@classroom/protocol';
import { setup, tmp, user } from './helpers.ts';

function world() {
  let t = new Date(2027, 2, 10, 10).getTime();
  const { app } = setup({ now: () => t, aiProvider: () => deterministicProvider() });
  const me = user(app.me), bob = user(app.identity.createUser('Bob'));
  app.ai.setSettings(me, { provider: { kind: 'local', label: 'T', baseUrl: '', model: 'd', embeddingModel: null } });
  const os = app.courses.create(me, { name: 'Operating Systems' });
  const lec = app.courses.addLecture(me, os.id, { title: 'Lecture 7' });
  return { app, me, bob, os, lec, dir: tmp(), tick: (ms: number) => { t += ms; }, now: () => t };
}

describe('Study Tapes', () => {
  it('record → timeline → finish: one personal Resource, moved into the store; markers stay useful without AI', async () => {
    const w = world();
    const part = join(w.dir, 'tape.webm.part');
    const tape = w.app.recordings.start(w.me, { title: 'OS lecture 7', source: 'screen', mic: true, partPath: part, courseId: w.os.id, lectureId: w.lec.id });
    expect(() => w.app.recordings.start(w.me, { title: 'second', source: 'screen', partPath: part })).toThrow(/already running/);
    w.tick(12 * 60_000 + 20_000);
    w.app.recordings.mark(w.me, tape.id, { kind: 'important', atMs: 740_000 });
    w.tick(9 * 60_000); // now 21:20 into the recording
    w.app.recordings.mark(w.me, tape.id, { kind: 'note', atMs: 1_122_000, text: 'Banker algorithm = avoidance, not prevention' });
    const shot = await w.app.files.ingest(w.me, (writeFileSync(join(w.dir, 'f.png'), 'png-bytes'), join(w.dir, 'f.png')), 'Frame 18-50.png', { kind: 'personal', ownerId: w.app.me }, 'image/png');
    w.app.recordings.mark(w.me, tape.id, { kind: 'screenshot', atMs: 1_130_000, refId: shot.refId });
    w.app.recordings.mark(w.me, tape.id, { kind: 'bookmark', atMs: 1_200_000, text: 'Exam hint' });
    expect(() => w.app.recordings.mark(w.me, tape.id, { kind: 'note', atMs: 99 * 60_000 })).toThrow(); // not in the future
    expect(() => w.app.recordings.mark(w.bob, tape.id, { kind: 'note', atMs: 1000 })).toThrow(/not found/);
    // stream "written" by the host app; finishing moves (not copies) it into the Resource Store
    writeFileSync(part, Buffer.alloc(256 * 1024, 3));
    const done = await w.app.recordings.finish(w.me, tape.id, { path: part, mime: 'video/webm;codecs=vp9,opus', durationMs: 1_260_000, endReason: 'stopped' });
    expect(existsSync(part)).toBe(false);
    expect(done).toMatchObject({ status: 'ready', durationMs: 1_260_000, bytes: 256 * 1024, courseId: w.os.id, lectureId: w.lec.id, hasTranscript: false });
    const f = w.app.files.get(w.me, done.refId!)!;
    expect(f.scope).toEqual({ kind: 'personal', ownerId: w.app.me }); // personal by default
    expect(statSync(w.app.store.object(f.objectId)!.location).size).toBe(256 * 1024);
    expect(w.app.recordings.events(w.me, tape.id).map((e) => [e.atMs, e.kind])).toEqual([[740_000, 'important'], [1_122_000, 'note'], [1_130_000, 'screenshot'], [1_200_000, 'bookmark']]);
    // explicit "Create full Note" — a real note referencing the tape + timestamp, linked to the lecture
    const n = w.app.recordings.toNote(w.me, w.app.recordings.events(w.me, tape.id)[1]!.id);
    expect(n.body).toContain(`clan://tape/${tape.id}?t=1122000`);
    expect(w.app.courses.links(w.me, w.os.id, { lectureId: w.lec.id }).map((l) => l.entityId)).toContain(n.id);
    // the Course/Lecture see the tape by reference
    expect(w.app.recordings.list(w.me, { lectureId: w.lec.id }).map((x) => x.id)).toEqual([tape.id]);
    // privacy: nobody else sees it; search finds the moment
    expect(w.app.recordings.get(w.bob, tape.id)).toBeNull();
    expect(w.app.recordings.list(w.bob)).toEqual([]);
    const hits = w.app.search.query(w.me, 'Banker');
    expect(hits.map((h) => [h.module, h.entityId])).toContainEqual(['recordings', `${tape.id}:1122000`]);
    expect(w.app.search.query(w.bob, 'Banker').filter((h) => h.module === 'recordings')).toEqual([]);
    w.app.recordings.removeEvent(w.me, w.app.recordings.events(w.me, tape.id)[1]!.id);
    expect(w.app.search.query(w.me, 'Banker').filter((h) => h.module === 'recordings')).toEqual([]);
  });

  it('interrupted recordings are found for recovery; failure keeps the timeline; links are validated', async () => {
    const w = world();
    const t = w.app.recordings.start(w.me, { title: 'Crashed', source: 'window', partPath: join(w.dir, 'x.part') });
    w.app.recordings.mark(w.me, t.id, { kind: 'bookmark', atMs: 0, text: 'start' });
    expect(w.app.recordings.interrupted(w.me).map((x) => [x.id, x.partPath])).toEqual([[t.id, join(w.dir, 'x.part')]]);
    writeFileSync(join(w.dir, 'x.part'), Buffer.alloc(1000));
    expect((await w.app.recordings.finish(w.me, t.id, { path: join(w.dir, 'x.part'), mime: 'video/webm', durationMs: 5000, endReason: 'app closed unexpectedly', recovered: true })).status).toBe('recovered');
    const f = w.app.recordings.start(w.me, { title: 'No source', source: 'screen', partPath: join(w.dir, 'y.part') });
    w.app.recordings.fail(w.me, f.id, 'capture_failed');
    expect(w.app.recordings.get(w.me, f.id)).toMatchObject({ status: 'failed', endReason: 'capture_failed' });
    const other = w.app.courses.create(w.me, { name: 'Other' });
    expect(() => w.app.recordings.link(w.me, f.id, { courseId: other.id, lectureId: w.lec.id })).toThrow(/another course/);
    expect(() => w.app.recordings.link(w.me, f.id, { courseId: w.app.courses.create(w.bob, { name: 'Bob' }).id })).toThrow(/Course not found/);
  });

  it('AI: tapes are never context by default; included, only the timeline is used and it says there is no transcript', async () => {
    const w = world();
    const t = w.app.recordings.start(w.me, { title: 'Paging lecture', source: 'screen', partPath: join(w.dir, 'p.part'), courseId: w.os.id });
    w.tick(60_000);
    w.app.recordings.mark(w.me, t.id, { kind: 'note', atMs: 30_000, text: 'Paging uses fixed-size frames and a page table.' });
    const scope = { kind: 'course' as const, courseId: w.os.id };
    const off = await w.app.ai.run(w.me, { action: 'ask', scope, question: 'paging page table frames' });
    expect(off.used.some((u) => u.label.startsWith('Study Tape'))).toBe(false);
    const on = await w.app.ai.run(w.me, { action: 'ask', scope, question: 'paging page table frames', include: { recordings: true } });
    expect(on.citations.map((c) => c.label)).toEqual(['Study Tape: Paging lecture']);
    expect(on.citations[0]!.excerpt).toMatch(/No transcript exists/);
    expect(w.app.ai.settings(w.me).include.course?.recordings).toBe(true); // remembered for this place, like other choices
    expect(w.app.recordings.get({ kind: 'agent', agentId: 'guide', onBehalfOf: w.app.me, scopes: ['notes:read'] }, t.id)).toBeNull();
  });
});

// Study Engine for the desktop shell (main process): courses, topics, lectures, references, tasks, exams, reminders,
// flashcards, study sessions, Today and the Semester Board. View models are composed here so the renderer stays thin;
// every call acts as this device's local user, and every input is parsed.
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { basename } from 'node:path';
import { z } from 'zod';
import { GRADES, RECURRENCES, RESOURCE_KINDS, TASK_STATUSES, EXAM_STATUSES, TOPIC_STATES, countdown } from '@classroom/protocol';
import type { ClanApp } from '@clan/core';

const Id = z.uuid();
const Ts = z.number().int().positive();
const Mod = z.enum(['notes', 'files', 'saved']);
const DAY = 86_400_000;

export function registerStudy(c: ClanApp) {
  const me = { kind: 'user' as const, userId: c.me };
  const handle = (ch: string, f: (...a: unknown[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => f(...a));
  const pickFiles = async () => {
    const w = BrowserWindow.getFocusedWindow() ?? undefined;
    const r = w ? await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'] }) : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths.slice(0, 20);
  };

  // Reminders ring and due-soon notices go out about once a minute (idempotent per occurrence).
  setInterval(() => c.tick(), 60_000).unref();
  c.tick();

  // ---- Campus / courses ----
  /** Small campus view models: floors = topics (solid = marked Confident), lit windows = real activity this week, exam flag = upcoming exam within 14 days. */
  handle('study:courses', () => {
    const now = Date.now();
    return c.courses.list(me).map((x) => {
      const topics = c.courses.topics(me, x.id);
      const next = c.exams.list(me, { courseId: x.id, upcoming: true, from: now })[0] ?? null;
      return { id: x.id, name: x.name, code: x.code, term: x.term, clanId: x.clanId, clanName: x.clanId ? c.clans.get(x.clanId)?.name ?? null : null,
        topics: topics.map((t) => ({ id: t.id, title: t.title, state: t.state })), recent: c.courses.recentActivity(me, x.id, now - 7 * DAY),
        files: c.courses.links(me, x.id, { module: 'files', limit: 50 }).length, openTasks: c.tasks.list(me, { courseId: x.id, open: true, limit: 50 }).length,
        nextExam: next && { id: next.id, name: next.name, at: next.at, soon: next.at - now < 14 * DAY }, dueCards: c.flashcards.dueCount(me, { courseId: x.id }) };
    });
  });
  const CourseIn = z.object({ name: z.string(), code: z.string().optional(), instructor: z.string().optional(), term: z.string().optional(), schedule: z.string().optional(), clanId: Id.nullable().optional() });
  handle('study:createCourse', (raw) => c.courses.create(me, CourseIn.parse(raw)));
  handle('study:updateCourse', (id, raw) => c.courses.update(me, Id.parse(id), CourseIn.partial().parse(raw)));
  handle('study:archiveCourse', (id) => c.courses.archive(me, Id.parse(id)));
  handle('study:linkClassrooms', () => c.courses.linkClassrooms(me));
  /** Course interior: one call, references resolved through their own modules; nothing copied. */
  handle('study:course', (id) => {
    const course = c.courses.mine(me, Id.parse(id));
    const links = c.courses.links(me, course.id);
    return {
      course, clanName: course.clanId ? c.clans.get(course.clanId)?.name ?? null : null,
      topics: c.courses.topics(me, course.id), lectures: c.courses.lectures(me, course.id), links,
      tasks: c.tasks.list(me, { courseId: course.id, limit: 100 }), exams: c.exams.list(me, { courseId: course.id }),
      decks: c.flashcards.decks(me, { courseId: course.id }), sessions: c.study.recent(me, { courseId: course.id, limit: 10 }),
      assignments: course.clanId ? c.assignments.list(me, { clanId: course.clanId }) : [],
      reminders: c.reminders.forTarget(me, 'courses', course.id),
      tapes: c.recordings.list(me, { courseId: course.id, limit: 50 }),
    };
  });
  handle('study:addTopic', (courseId, title) => c.courses.addTopic(me, Id.parse(courseId), z.string().parse(title)));
  handle('study:renameTopic', (id, title) => c.courses.renameTopic(me, Id.parse(id), z.string().parse(title)));
  handle('study:moveTopic', (id, index) => c.courses.moveTopic(me, Id.parse(id), z.number().int().min(0).parse(index)));
  handle('study:removeTopic', (id) => c.courses.removeTopic(me, Id.parse(id)));
  handle('study:confidence', (id, state) => c.courses.setConfidence(me, Id.parse(id), z.enum(TOPIC_STATES).parse(state)));
  handle('study:addLecture', (courseId, raw) => c.courses.addLecture(me, Id.parse(courseId), z.object({ title: z.string(), at: Ts.nullable().optional(), topicIds: z.array(Id).max(50).optional() }).parse(raw)));
  handle('study:setLecture', (id, raw) => c.courses.setLecture(me, Id.parse(id), z.object({ status: z.enum(['planned', 'held', 'cancelled']).optional(), title: z.string().optional(), at: Ts.nullable().optional() }).parse(raw)));
  const LinkIn = z.object({ module: Mod, entityId: Id, topicId: Id.nullable().optional(), lectureId: Id.nullable().optional(), kind: z.enum(RESOURCE_KINDS).nullable().optional() });
  handle('study:link', (courseId, raw) => c.courses.link(me, Id.parse(courseId), LinkIn.parse(raw)));
  handle('study:unlink', (id) => c.courses.unlink(me, Id.parse(id)));
  handle('study:classify', (id, kind) => c.courses.classify(me, Id.parse(id), z.enum(RESOURCE_KINDS).parse(kind)));
  /** New files go through the canonical Resource Store (deduplicated by hash), then are referenced from the course. */
  handle('study:importFiles', async (courseId, raw) => {
    const o = z.object({ topicId: Id.nullable().optional(), lectureId: Id.nullable().optional(), kind: z.enum(RESOURCE_KINDS).optional() }).parse(raw ?? {});
    const cid = Id.parse(courseId); c.courses.mine(me, cid);
    let n = 0;
    for (const p of await pickFiles()) {
      const f = await c.files.add(me, p, basename(p), { kind: 'personal', ownerId: c.me });
      c.courses.link(me, cid, { module: 'files', entityId: f.refId, ...o }); n++;
    }
    return n;
  });
  /** What can be linked: your notes, saved links, personal files, and files of CLANs you belong to. */
  handle('study:linkable', () => ({
    notes: c.notes.mine(me, 200).map((n) => ({ id: n.id, title: n.title })),
    saved: c.saved.items(me).slice(0, 200).map((s) => ({ id: s.id, title: s.title })),
    files: [...c.files.list(me, { kind: 'personal', ownerId: c.me }), ...c.clans.list(c.me).flatMap((k) => c.files.list(me, { kind: 'clan', clanId: k.id }).map((f) => ({ ...f, name: `${f.name} · ${k.name}` })))]
      .slice(0, 300).map((f) => ({ id: f.refId, title: f.name })),
  }));

  // ---- tasks ----
  const TaskIn = z.object({ title: z.string(), description: z.string().optional(), courseId: Id.nullable().optional(), topicId: Id.nullable().optional(), clanId: Id.nullable().optional(), dueAt: Ts.nullable().optional(), priority: z.enum(['low', 'normal', 'high']).optional(), checklist: z.array(z.string()).max(50).optional() });
  handle('tasks:list', (raw) => c.tasks.list(me, z.object({ courseId: Id.optional(), open: z.boolean().optional() }).parse(raw ?? {})));
  handle('tasks:create', (raw) => c.tasks.create(me, TaskIn.parse(raw)));
  handle('tasks:update', (id, raw) => c.tasks.update(me, Id.parse(id), TaskIn.pick({ title: true, description: true, dueAt: true, priority: true }).partial().parse(raw)));
  handle('tasks:status', (id, s) => c.tasks.setStatus(me, Id.parse(id), z.enum(TASK_STATUSES).parse(s)));
  handle('tasks:check', (id, item, done) => c.tasks.check(me, Id.parse(id), Id.parse(item), z.boolean().parse(done)));
  handle('tasks:addItem', (id, text) => c.tasks.addItem(me, Id.parse(id), z.string().parse(text)));
  handle('tasks:attach', (id, m, e) => c.tasks.attach(me, Id.parse(id), Mod.parse(m), Id.parse(e)));

  // ---- exams ----
  const ExamIn = z.object({ courseId: Id, name: z.string(), at: Ts, location: z.string().optional(), topicIds: z.array(Id).max(200).optional(), notes: z.string().optional() });
  handle('exams:list', () => c.exams.list(me).map((e) => ({ ...e, countdown: countdown(e.at, Date.now()) })));
  /** Creates the exam; the suggested reminders are created only for the offsets the student ticked. */
  handle('exams:create', (raw, rem) => {
    const e = c.exams.create(me, ExamIn.parse(raw));
    for (const d of z.array(z.union([z.literal(7), z.literal(1)])).max(2).parse(rem ?? [])) {
      const at = e.at - d * DAY;
      if (at > Date.now()) c.reminders.create(me, { text: `${e.name} in ${d === 7 ? 'one week' : 'one day'}`, dueAt: at, target: { module: 'exams', id: e.id } });
    }
    return e;
  });
  handle('exams:update', (id, raw) => c.exams.update(me, Id.parse(id), ExamIn.omit({ courseId: true }).partial().parse(raw)));
  handle('exams:status', (id, s, r) => c.exams.setStatus(me, Id.parse(id), z.enum(EXAM_STATUSES).parse(s), z.object({ grade: z.string(), total: z.string(), reflection: z.string() }).partial().optional().parse(r)));
  handle('exams:attach', (id, m, e) => c.exams.attach(me, Id.parse(id), Mod.parse(m), Id.parse(e)));
  /** Exam Command Center: everything real for one exam. Readiness is only "N of M topics in scope marked Confident". */
  handle('exams:center', (id) => {
    const prep = c.exams.prep(me, Id.parse(id)), cid = prep.exam.courseId;
    const links = c.courses.links(me, cid);
    const scope = new Set(prep.exam.topicIds);
    return {
      ...prep, course: c.courses.mine(me, cid),
      pastPapers: links.filter((l) => l.kind === 'past_paper'), resources: links.filter((l) => l.module === 'files' && l.kind !== 'past_paper' && (!l.topicId || scope.has(l.topicId))),
      notes: links.filter((l) => l.module === 'notes' && (!l.topicId || scope.has(l.topicId))), saved: links.filter((l) => l.module === 'saved' && (!l.topicId || scope.has(l.topicId))),
      decks: [...c.flashcards.decks(me, { examId: prep.exam.id }), ...c.flashcards.decks(me, { courseId: cid }).filter((d) => !d.examId)],
      dueCards: c.flashcards.dueCount(me, { courseId: cid }),
      tasks: c.tasks.list(me, { courseId: cid, open: true, limit: 50 }), sessions: c.study.recent(me, { courseId: cid, limit: 10 }),
      reminders: c.reminders.forTarget(me, 'exams', prep.exam.id),
    };
  });

  // ---- reminders ----
  const Target = z.object({ module: z.enum(['courses', 'exams', 'tasks', 'files', 'saved', 'notes']), id: z.string().min(1).max(100) });
  handle('reminders:create', (raw) => c.reminders.create(me, z.object({ text: z.string(), dueAt: Ts, target: Target.optional(), recurrence: z.enum(RECURRENCES).optional() }).parse(raw)));
  handle('reminders:done', (id) => c.reminders.done(me, Id.parse(id)));
  handle('reminders:dismiss', (id) => c.reminders.dismiss(me, Id.parse(id)));
  handle('reminders:snooze', (id, until) => c.reminders.snooze(me, Id.parse(id), Ts.parse(until)));
  handle('reminders:remove', (id) => c.reminders.remove(me, Id.parse(id)));
  handle('reminders:upcoming', () => c.reminders.upcoming(me));

  // ---- Today / Semester Board ----
  handle('study:today', () => c.agenda.today(me));
  handle('study:range', (from, to) => { const f = Ts.parse(from), t = Ts.parse(to); if (t - f > 62 * DAY) throw new Error('Range too large.'); return c.agenda.range(me, f, t); });
  /** Member devices: the assignment list the host just delivered (projection only; the classroom stays authoritative). */
  handle('study:assignmentsSeen', (clanId, list) => c.assignments.seen(me, Id.parse(clanId), list));

  // ---- flashcards ----
  handle('cards:decks', (raw) => c.flashcards.decks(me, z.object({ courseId: Id.optional(), examId: Id.optional() }).parse(raw ?? {})));
  handle('cards:createDeck', (raw) => c.flashcards.createDeck(me, z.object({ name: z.string(), courseId: Id.nullable().optional(), topicId: Id.nullable().optional(), examId: Id.nullable().optional() }).parse(raw)));
  handle('cards:add', (deckId, raw) => c.flashcards.addCard(me, Id.parse(deckId), z.object({ front: z.string(), back: z.string(), note: z.string().optional(), ref: z.object({ module: Mod, id: Id }).optional() }).parse(raw)));
  handle('cards:edit', (id, raw) => c.flashcards.editCard(me, Id.parse(id), z.object({ front: z.string(), back: z.string(), note: z.string() }).partial().parse(raw)));
  handle('cards:remove', (id) => c.flashcards.removeCard(me, Id.parse(id)));
  handle('cards:list', (deckId, offset) => c.flashcards.cards(me, Id.parse(deckId), { offset: z.number().int().min(0).optional().parse(offset) }));
  handle('cards:queue', (deckId) => c.flashcards.queue(me, Id.parse(deckId)));
  handle('cards:review', (id, g) => c.flashcards.review(me, Id.parse(id), z.enum(GRADES).parse(g)));
  handle('cards:dueCount', () => c.flashcards.dueCount(me));

  // ---- study sessions ----
  handle('session:active', () => c.study.active(me));
  handle('session:plan', (raw) => c.study.plan(me, z.object({ courseId: Id.nullable().optional(), topicId: Id.nullable().optional(), goal: z.string().optional(), at: Ts, minutes: z.number().int().min(1).max(600).nullable().optional() }).parse(raw)));
  handle('session:start', (raw) => c.study.start(me, z.object({ sessionId: Id.optional(), courseId: Id.nullable().optional(), topicId: Id.nullable().optional(), goal: z.string().optional(), minutes: z.number().int().min(1).max(600).nullable().optional(), focus: z.boolean().optional() }).parse(raw)));
  handle('session:end', (id, reflection) => c.study.end(me, Id.parse(id), z.string().max(5000).optional().parse(reflection)));
  handle('session:cancel', (id) => c.study.cancel(me, Id.parse(id)));
  /** Personal history only (never compared with anyone). */
  handle('session:history', () => {
    const since = Date.now() - 30 * DAY, names = new Map(c.courses.list(me).map((x) => [x.id, x.name]));
    const reviews = new Map(c.flashcards.reviewsByCourse(me, since).map((r) => [r.courseId, r.n]));
    const rows = c.study.history(me, since).map((h) => ({ ...h, course: h.courseId ? names.get(h.courseId) ?? 'Archived course' : 'General', reviews: reviews.get(h.courseId) ?? 0 }));
    for (const [courseId, n] of reviews) if (!rows.some((r) => r.courseId === courseId)) rows.push({ courseId, course: courseId ? names.get(courseId) ?? 'Archived course' : 'General', sessions: 0, minutes: 0, topics: 0, reviews: n });
    return rows;
  });
}

// CLAN Intelligence end to end with the deterministic provider (no external AI): Ask CLAN with citations → Ask this
// document → Compare My Notes → Quiz Me → draft cards (reject one, edit one, accept the rest) → Exam Coach plan →
// nothing changes before acceptance → accept → owning modules update → restart → persists. Plus the security boundary.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { makePdf } from '../../../packages/clan/test/fixtures/pdf.ts';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'clan-ai-')); dirs.push(scratch);
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const chooseFiles = (app: ElectronApplication, paths: string[]) => app.evaluate(({ dialog }, ps) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: ps })) as never; }, paths);

async function launch(userData = mkdtempSync(join(tmpdir(), 'clan-'))) {
  if (!dirs.includes(userData)) dirs.push(userData);
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: ['.'] }), cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData, CLAN_AI_PROVIDER: 'deterministic' } });
  apps.push(app);
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}
const study = async (p: Page, tab: string) => { await p.getByRole('button', { name: 'Study', exact: true }).click(); await p.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name: tab, exact: true }).click(); };
const openCourse = async (p: Page) => { await study(p, 'Campus'); await p.getByRole('tab', { name: 'List View' }).click(); await p.getByRole('button', { name: 'CS-330 · Operating Systems' }).click(); await p.getByTestId('course-space').waitFor(); };
const section = (p: Page, name: string) => p.getByRole('tablist', { name: 'Course sections' }).getByRole('tab', { name: new RegExp(`^${name}`) }).click();
const sheet = (p: Page) => p.getByTestId('ai-sheet');
const close = (p: Page) => sheet(p).getByRole('button', { name: 'Close', exact: true }).click();

it('Ask → Document → Compare → Quiz → drafts → Exam Coach → accept → restart', async () => {
  const { app, page: p, userData } = await launch();
  // the honest no-provider state first
  await p.getByRole('button', { name: 'Ask CLAN' }).first().click();
  await sheet(p).getByLabel('Ask CLAN').fill('anything');
  await sheet(p).getByRole('button', { name: 'Ask', exact: true }).click();
  await expect.poll(() => sheet(p).getByTestId('ai-status').textContent()).toContain('Connect an AI provider');
  await close(p);
  // Me › AI: choose the (test) on-device provider
  await p.getByRole('button', { name: 'Me', exact: true }).click();
  await p.getByLabel('AI provider').selectOption('local');
  await p.getByTestId('ai-settings').getByText(/Using Deterministic/).waitFor();

  // material, through the app's own bridge and file import
  const ids = await p.evaluate(async () => {
    const s = window.classroom.study;
    const c = await s.createCourse({ name: 'Operating Systems', code: 'CS-330' });
    const t = [await s.addTopic(c.id, 'Processes'), await s.addTopic(c.id, 'Deadlocks')];
    const l = await s.addLecture(c.id, { title: 'Lecture 6', topicIds: [t[1]!.id] });
    const n = await window.classroom.clan.createNote({ title: 'My deadlock notes', body: 'A deadlock means processes wait forever.' });
    await s.link(c.id, { module: 'notes', entityId: n.id, topicId: t[1]!.id });
    const e = await s.createExam({ courseId: c.id, name: 'Midterm', at: Date.now() + 6 * 86_400_000, topicIds: t.map((x) => x.id) }, []);
    return { course: c.id, lecture: l.id, exam: e.id };
  });
  writeFileSync(join(scratch, 'Lecture 6.pdf'), makePdf(['Processes are programs in execution. A process control block stores the state of each process.', 'A deadlock is a situation where each process waits for a resource held by another process. The Coffman conditions are mutual exclusion, hold and wait, no preemption and circular wait.']));
  writeFileSync(join(scratch, 'Past Paper 2025.pdf'), makePdf(['Q1 Explain the four Coffman conditions for deadlock.\nQ2 Describe the process states.']));
  await chooseFiles(app, [join(scratch, 'Lecture 6.pdf')]);
  await p.evaluate((c) => window.classroom.study.importFiles(c, { kind: 'lecture_material' }), ids.course);
  await chooseFiles(app, [join(scratch, 'Past Paper 2025.pdf')]);
  await p.evaluate((c) => window.classroom.study.importFiles(c, { kind: 'past_paper' }), ids.course);

  // Ask CLAN in the course: answer cites the lecture page
  await openCourse(p);
  await p.getByRole('group', { name: 'CLAN for this course' }).getByRole('button', { name: 'Ask CLAN' }).click();
  await sheet(p).getByText(/Sources CLAN will use/).waitFor();
  await sheet(p).getByLabel('Ask CLAN').fill('Which Coffman conditions include circular wait and preemption?');
  await sheet(p).getByRole('button', { name: 'Ask', exact: true }).click();
  await expect.poll(() => sheet(p).getByTestId('citation').allTextContents(), { timeout: 20_000 }).toEqual([expect.stringMatching(/^\[\d+\] Lecture 6.pdf · page 2$/)]);
  expect(await sheet(p).getByTestId('ai-answer').textContent()).toContain('circular wait');
  await close(p);

  // Ask this document (page-referenced)
  await section(p, 'Resources');
  await p.getByTestId('link-files').filter({ hasText: 'Lecture 6.pdf' }).getByRole('button', { name: 'Ask this document' }).click();
  await sheet(p).getByLabel('Ask CLAN').fill('Where is the process control block?');
  await sheet(p).getByRole('button', { name: 'Ask', exact: true }).click();
  await expect.poll(() => sheet(p).getByTestId('citation').allTextContents(), { timeout: 20_000 }).toEqual([expect.stringContaining('Lecture 6.pdf · page 1')]);
  await close(p);

  // Compare My Notes: missing concepts cited; the note is not touched
  await study(p, 'Notes');
  await p.getByRole('button', { name: /My deadlock notes/ }).click();
  await p.getByLabel('Compare with course material').selectOption({ label: 'Operating Systems' });
  await sheet(p).getByTestId('compare').waitFor({ timeout: 20_000 });
  expect(await sheet(p).getByTestId('compare').getByTestId('citation').count()).toBeGreaterThan(0);
  await sheet(p).getByTestId('proposal-APPEND_NOTE').waitFor();
  expect((await p.evaluate(() => window.classroom.clan.notes()))[0]!.body).toBe('A deadlock means processes wait forever.');
  await sheet(p).getByRole('button', { name: 'Ignore all' }).click();
  await close(p);

  // Quiz Me
  await openCourse(p);
  await p.getByRole('group', { name: 'CLAN for this course' }).getByRole('button', { name: 'Quiz me' }).click();
  await sheet(p).getByTestId('quiz').waitFor({ timeout: 20_000 });
  await sheet(p).getByRole('button', { name: 'Check answers' }).click();
  await expect.poll(() => sheet(p).getByTestId('quiz-score').textContent()).toMatch(/of \d+ correct/);
  expect(await p.evaluate(async (c) => (await window.classroom.study.course(c)).topics.map((t) => t.state), ids.course)).toEqual(['not_started', 'not_started']); // only suggested
  await close(p);

  // draft flashcards: reject one, edit one, accept the rest
  await p.getByRole('group', { name: 'CLAN for this course' }).getByRole('button', { name: 'Draft flashcards' }).click();
  await sheet(p).getByTestId('draft-card').first().waitFor({ timeout: 20_000 });
  const drafts = await sheet(p).getByTestId('draft-card').count();
  expect(drafts).toBeGreaterThanOrEqual(2);
  expect(await p.evaluate(() => window.classroom.study.decks())).toEqual([]);
  await sheet(p).getByLabel('Keep card 2').uncheck();
  await sheet(p).getByLabel('Back of card 1').fill('Edited by me');
  await sheet(p).getByTestId('proposal-CREATE_FLASHCARDS').getByRole('button', { name: 'Accept' }).click();
  await sheet(p).getByTestId('proposal-CREATE_FLASHCARDS').getByText('accepted').waitFor();
  const deck = await p.evaluate(async () => { const d = (await window.classroom.study.decks())[0]!; return { cards: await window.classroom.study.cards(d.id) }; });
  expect(deck.cards).toHaveLength(drafts - 1);
  expect(deck.cards.some((c) => c.back === 'Edited by me')).toBe(true);
  await close(p);

  // Exam Coach: a plan is only a proposal until accepted
  await study(p, 'Exams');
  await p.getByRole('button', { name: /^Midterm/ }).click();
  await p.getByRole('button', { name: 'Exam Coach' }).click();
  await sheet(p).getByTestId('exam-coach').waitFor();
  await sheet(p).getByRole('button', { name: 'Suggest a study plan' }).click();
  await sheet(p).getByTestId('proposal-CREATE_STUDY_PLAN').waitFor({ timeout: 20_000 });
  const planned = () => p.evaluate(() => window.classroom.study.range(Date.now(), Date.now() + 14 * 86_400_000).then((x) => x.filter((i) => i.kind === 'session').length));
  expect(await planned()).toBe(0);
  await sheet(p).getByTestId('proposal-CREATE_STUDY_PLAN').getByRole('button', { name: 'Accept' }).click();
  await expect.poll(planned).toBeGreaterThan(0);
  const n = await planned();
  await close(p);

  // restart: accepted changes persist
  await app.close();
  const again = await launch(userData);
  const after = await again.page.evaluate(async () => ({ cards: (await window.classroom.study.decks())[0]?.cards ?? 0, sessions: (await window.classroom.study.range(Date.now(), Date.now() + 14 * 86_400_000)).filter((i) => i.kind === 'session').length }));
  expect(after).toEqual({ cards: drafts - 1, sessions: n });
}, 300_000);

it('security: unrelated CLAN and Diary without permission are refused through the real bridge', async () => {
  const { page: p } = await launch();
  await p.getByRole('button', { name: 'Me', exact: true }).click();
  await p.getByLabel('AI provider').selectOption('local');
  const r = await p.evaluate(async (clanId) => {
    const ai = window.classroom.ai;
    await window.classroom.clan.writeDiary({ day: '2027-01-01', body: 'secret PINEAPPLE' });
    const other = await ai.run(crypto.randomUUID(), { action: 'ask', scope: { kind: 'clan', clanId }, question: 'secrets' });
    const diary = await ai.run(crypto.randomUUID(), { action: 'ask', scope: { kind: 'global' }, question: 'PINEAPPLE', include: { diary: true } });
    const bad = await ai.run(crypto.randomUUID(), { action: 'deleteEverything' as never, scope: { kind: 'global' } }).then(() => 'accepted', (e: Error) => e.message);
    return { otherNotes: other.notes, otherUsed: other.used.length, diaryIncluded: diary.diaryIncluded, diaryNotes: diary.notes, cited: diary.citations.map((c) => c.label), bad };
  }, randomUUID());
  expect(r.otherNotes).toContain('You are not a member of that CLAN.');
  expect(r.otherUsed).toBe(0);
  expect(r.diaryIncluded).toBe(false);
  expect(r.diaryNotes.join(' ')).toMatch(/Diary not included/);
  expect(r.cited.some((l) => l.startsWith('Diary'))).toBe(false);
  expect(r.bad).not.toBe('accepted');
}, 120_000);

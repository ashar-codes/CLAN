// Study Engine end to end in the real app: course → topics → note/resource/link → task → exam → reminder → deck →
// review → focus study session → Exam Command Center → restart → everything persists. Then: a Classroom's
// assignment appears in its linked Course and in Today without being copied into Tasks.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'clan-study-')); dirs.push(scratch);
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const chooseFiles = (app: ElectronApplication, paths: string[]) => app.evaluate(({ dialog }, ps) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: ps })) as never; }, paths);
const local = (ts: number) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

async function launch(userData = mkdtempSync(join(tmpdir(), 'clan-'))) {
  if (!dirs.includes(userData)) dirs.push(userData);
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: ['.'] }), cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData } });
  apps.push(app);
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}
const study = async (p: Page, tab: string) => { await p.getByRole('button', { name: 'Study', exact: true }).click(); await p.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name: tab, exact: true }).click(); };
const openCourse = async (p: Page) => { await study(p, 'Campus'); await p.getByRole('tab', { name: 'List View' }).click(); await p.getByRole('button', { name: 'CS-330 · Operating Systems' }).click(); await p.getByTestId('course-space').waitFor(); };
const section = (p: Page, name: string) => p.getByRole('tablist', { name: 'Course sections' }).getByRole('tab', { name: new RegExp(`^${name}`) }).click();

it('Study Engine: course → … → focus session → Exam Command Center → restart persists', async () => {
  const { app, page: p, userData } = await launch();

  // course + ordered topics
  await study(p, 'Campus');
  await p.getByRole('button', { name: 'New course' }).click();
  await p.getByLabel('Course name').fill('Operating Systems');
  await p.getByLabel('Course code').fill('CS-330');
  await p.getByRole('button', { name: 'Add course' }).click();
  await openCourse(p);
  await section(p, 'Topics');
  for (const t of ['Processes', 'Deadlocks']) { await p.getByLabel('New topic').fill(t); await p.getByRole('button', { name: 'Add topic' }).click(); await p.getByLabel(`Your mark for ${t}`).waitFor(); }
  await expect.poll(() => p.getByTestId('topic').count()).toBe(2);

  // a real Note, filed into the course (topic Processes) — the note stays in Notes
  await study(p, 'Notes');
  await p.getByRole('button', { name: 'New note' }).click();
  await p.getByLabel('Title', { exact: true }).fill('Process states');
  await p.getByLabel('Note', { exact: true }).fill('new, ready, running, waiting, terminated');
  await p.getByRole('button', { name: 'Save', exact: true }).click();
  await p.getByLabel('Add to course').selectOption({ label: 'Operating Systems › Processes' });
  await p.getByText('Added to the course').waitFor();

  // a Resource through the canonical store, classified as a past paper
  writeFileSync(join(scratch, 'Midterm-2025.pdf'), Buffer.alloc(64 * 1024, 7));
  await openCourse(p);
  await section(p, 'Resources');
  await p.getByLabel('Kind for new file').selectOption('past_paper');
  await chooseFiles(app, [join(scratch, 'Midterm-2025.pdf')]);
  await p.getByRole('button', { name: 'Import files…' }).click();
  await expect.poll(() => p.getByTestId('link-files').textContent()).toContain('Midterm-2025.pdf');

  // a link saved straight into the course with Quick Capture
  await p.getByRole('button', { name: 'Quick Capture' }).click();
  await p.getByLabel('Capture into').selectOption({ label: 'Operating Systems' });
  await p.getByRole('menuitem', { name: 'Link' }).click();
  await p.getByLabel('Link to save').fill('https://example.com/deadlocks-explained');
  await p.getByRole('button', { name: 'Save', exact: true }).click();
  await openCourse(p);
  await section(p, 'Saved');
  await expect.poll(() => p.getByTestId('link-saved').count()).toBe(1);

  // task
  await section(p, 'Tasks');
  await p.getByLabel('Task title').fill('Problem set 3');
  await p.getByLabel('Due', { exact: true }).fill(local(Date.now() + 3 * 3_600_000));
  await p.getByRole('button', { name: 'Add task' }).click();
  await p.getByTestId('task').filter({ hasText: 'Problem set 3' }).waitFor();

  // exam with two topics in scope
  await section(p, 'Exams');
  await p.getByLabel('Exam name').fill('Midterm');
  await p.getByLabel('Exam date').fill(local(Date.now() + 5 * 86_400_000));
  await p.getByLabel('Processes', { exact: true }).check();
  await p.getByLabel('Deadlocks', { exact: true }).check();
  await p.getByRole('button', { name: 'Add exam' }).click();
  await p.locator('.line', { hasText: 'Midterm' }).waitFor();

  // deck + card + review
  await section(p, 'Flashcards');
  await p.getByLabel('Deck name').fill('OS terms');
  await p.getByRole('button', { name: 'Add deck' }).click();
  await p.getByRole('button', { name: /OS terms/ }).click();
  await p.getByLabel('Card front').fill('What is a TLB?');
  await p.getByLabel('Card back').fill('Translation lookaside buffer');
  await p.getByRole('button', { name: 'Add card' }).click();
  await p.getByRole('button', { name: 'Review 1 due' }).click();
  await p.getByTestId('review').waitFor();
  await p.keyboard.press('Space');
  await p.getByRole('button', { name: /^Good/ }).click();
  await p.getByText('All caught up.').waitFor();

  // reminder on the Semester Board
  await study(p, 'Semester Board');
  await p.getByLabel('Reminder text').fill('Bring calculator');
  await p.getByLabel('Reminder time').fill(local(Date.now() + 2 * 86_400_000));
  await p.getByRole('button', { name: 'Add reminder' }).click();
  await expect.poll(() => p.getByTestId('board-item').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('Bring calculator')]));
  expect((await p.getByTestId('board-item').allTextContents()).join(' ')).toContain('Midterm');

  // my own topic mark, then a Focus study session
  await openCourse(p);
  await section(p, 'Topics');
  await p.getByLabel('Your mark for Processes').selectOption('confident');
  await p.getByRole('button', { name: 'Start study session' }).click();
  await p.getByTestId('session-bar').waitFor();
  await expect.poll(() => p.locator('.shell').getAttribute('class')).toContain('is-focus');
  await p.getByRole('button', { name: 'End session' }).click();
  await p.getByLabel('Reflection').fill('Scheduling clicked');
  await p.getByRole('button', { name: 'Save and end' }).click();
  await expect.poll(() => p.getByTestId('session-bar').count()).toBe(0);
  await expect.poll(() => p.locator('.shell').getAttribute('class')).not.toContain('is-focus');

  // Exam Command Center reflects the real data
  const center = async (q: Page) => {
    await study(q, 'Exams');
    await q.getByRole('button', { name: /^Midterm/ }).click();
    await q.getByTestId('exam-center').waitFor();
    expect(await q.getByTestId('readiness').textContent()).toBe('1 of 2 topics marked Confident');
    const text = await q.getByTestId('exam-center').textContent();
    for (const s of ['Midterm-2025.pdf', 'Process states', 'Problem set 3', 'OS terms', 'Study Operating Systems']) expect(text).toContain(s);
    expect(await q.getByTestId('cards-due').textContent()).toBe('0 cards due');
  };
  await center(p);
  // Today on My Space projects the task and the exam
  await p.getByRole('button', { name: 'My Space', exact: true }).click();
  await expect.poll(() => p.getByTestId('today').textContent()).toContain('Problem set 3');
  expect(await p.getByTestId('today').textContent()).toContain('Midterm');

  // restart: everything persists
  await app.close();
  const again = await launch(userData);
  await center(again.page);
  await openCourse(again.page);
  await section(again.page, 'Notes');
  await expect.poll(() => again.page.getByTestId('link-notes').textContent()).toContain('Process states');
  await section(again.page, 'Saved');
  expect(await again.page.getByTestId('link-saved').count()).toBe(1);
}, 240_000);

it('Classroom → linked Course → assignment appears in Course and Today, not as a Task', async () => {
  const { page: t } = await launch();
  await t.getByText('Create Classroom').click();
  await t.getByLabel('Class name').fill('CS402 Fall 2026');
  await t.getByRole('button', { name: 'Start Classroom' }).click();
  await t.getByLabel('Join code').waitFor();
  await t.getByRole('button', { name: 'New assignment' }).click();
  await t.getByLabel('Title').fill('Lab 2');
  await t.getByLabel('Due (optional)').fill(local(Date.now() + 2 * 86_400_000));
  await t.getByRole('button', { name: 'Publish' }).click();
  await t.getByText('Lab 2').first().waitFor();
  // Read through the app's own bridge (the teacher dashboard stays open).
  const r = await t.evaluate(async () => {
    const s = window.classroom.study;
    const courses = await s.courses();
    const c = courses.find((x) => x.clanName === 'CS402 Fall 2026')!;
    const d = await s.course(c.id);
    return { name: c.name, linked: !!c.clanId, assignments: d.assignments.map((a) => a.title), today: (await s.today()).filter((i) => i.kind === 'assignment').map((i) => ({ title: i.title, source: i.source, courseId: i.courseId === c.id })), tasks: (await s.tasks()).length };
  });
  expect(r).toEqual({ name: 'CS402 Fall 2026', linked: true, assignments: ['Lab 2'], today: [{ title: 'Lab 2', source: 'Classroom assignment', courseId: true }], tasks: 0 });
}, 120_000);

// Drives two real Electron instances (teacher + student) over the machine's real LAN interface and mDNS.
// Run: pnpm --filter @classroom/desktop test:e2e  (builds first)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'clan-files-'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Make the next native file dialog in that app "choose" these paths (dialogs can't be clicked by Playwright). */
const chooseFiles = (app: ElectronApplication, paths: string[]) =>
  app.evaluate(({ dialog }, ps) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: ps })) as never; }, paths);
let lastApp: ElectronApplication;
async function launch(env: Record<string, string> = {}): Promise<Page> {
  // E2E_EXECUTABLE=release/mac-arm64/Classroom LAN.app/Contents/MacOS/Classroom LAN tests the packaged build instead.
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: ['.'] }), cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: mkdtempSync(join(tmpdir(), 'clan-')), ...env } });
  apps.push(app);
  lastApp = app;
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}
afterAll(async () => { await Promise.all(apps.map((a) => a.close())); rmSync(scratch, { recursive: true, force: true }); });

it('join, approve, files (download, pause/resume, send to everyone), assignment submission + receipt', async () => {
  const teacher = await launch();
  const teacherApp = lastApp;
  await teacher.getByText('Create Classroom').click();
  await teacher.getByLabel('Class name').fill('Operating Systems');
  await teacher.getByRole('button', { name: 'Start Classroom' }).click();
  const code = (await teacher.getByLabel('Classroom code').textContent())!.replace(/\D/g, '');
  expect(code).toMatch(/^\d{6}$/);

  const downloads = join(scratch, 'downloads');
  const student = await launch({ CLASSROOM_DOWNLOADS_DIR: downloads });
  const studentApp = lastApp;
  await student.getByText('Join Classroom').click();
  await student.getByLabel('Full name').fill('Ashar Khan');
  await student.getByLabel('Student / roll number').fill('FA23-CS-114');
  await student.getByLabel('Device name').fill('Ashar-MacBook');
  await student.getByRole('button', { name: 'Save' }).click();

  // Wrong code first: must be refused without revealing anything.
  await student.locator('.code-input').fill(code === '000000' ? '000001' : '000000');
  await student.getByRole('button', { name: 'Join' }).click();
  await expect.poll(() => student.locator('.error').textContent(), { timeout: 10_000 }).toContain('No classroom matches');

  await student.locator('.code-input').fill(code);
  await student.getByRole('button', { name: 'Join' }).click();
  await student.getByText('Waiting for the teacher').waitFor({ timeout: 10_000 });

  await teacher.getByText('Ashar Khan', { exact: true }).waitFor();
  await teacher.getByRole('button', { name: 'Approve', exact: true }).click();
  await student.getByText("You're in the class").waitFor({ timeout: 5000 });
  await teacher.getByText('Students (1/1 connected)').waitFor();
  await expect.poll(() => student.locator('.pill').textContent()).toMatch(/Excellent|Good/);

  if (process.env.SCREENSHOT_DIR) {
    await teacher.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'teacher.png') });
    await student.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'student.png') });
  }

  // ---- Files ----
  const pdf = randomBytes(1_500_000), big = randomBytes(400 * 1024 * 1024), pushed = randomBytes(200_000);
  writeFileSync(join(scratch, 'Lecture-05.pdf'), pdf);
  writeFileSync(join(scratch, 'Lab04.zip'), big);
  writeFileSync(join(scratch, 'Handout.pdf'), pushed);
  await chooseFiles(teacherApp, [join(scratch, 'Lecture-05.pdf'), join(scratch, 'Lab04.zip')]);
  await teacher.getByRole('button', { name: 'Add files' }).click();
  await teacher.getByTestId('teacher-file-Lab04.zip').getByText('✓ SHA-256').waitFor({ timeout: 30_000 });

  const lecture = student.getByTestId('student-file-Lecture-05.pdf');
  await lecture.waitFor();
  await lecture.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => lecture.getByTestId('file-state').textContent(), { timeout: 15_000 }).toBe('Downloaded');
  expect(sha(readFileSync(join(downloads, 'Operating Systems', 'Lecture-05.pdf')))).toBe(sha(pdf));
  await expect.poll(() => teacher.getByTestId('teacher-file-Lecture-05.pdf').getByTestId('completed-count').textContent()).toBe('1');

  // Pause a large download part-way, then resume: it must continue from the partial, not restart.
  const lab = student.getByTestId('student-file-Lab04.zip');
  await lab.getByRole('button', { name: 'Download' }).click();
  await expect.poll(async () => /Downloading · ([1-9]\d?)%/.test((await lab.getByTestId('file-state').textContent()) ?? ''), { intervals: [20], timeout: 15_000 }).toBe(true);
  await lab.getByRole('button', { name: 'Pause' }).click();
  await expect.poll(() => lab.getByTestId('file-state').textContent()).toMatch(/^Paused · \d+%/);
  expect(readdirSync(join(downloads, 'Operating Systems'))).not.toContain('Lab04.zip'); // partial never looks finished
  await lab.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => lab.getByTestId('file-state').textContent(), { timeout: 60_000 }).toBe('Downloaded · resumed');
  expect(sha(readFileSync(join(downloads, 'Operating Systems', 'Lab04.zip')))).toBe(sha(big));

  // Send to everyone: the student app queues and fetches it without a click.
  await chooseFiles(teacherApp, [join(scratch, 'Handout.pdf')]);
  await teacher.getByRole('button', { name: 'Add files' }).click();
  await teacher.getByTestId('teacher-file-Handout.pdf').getByRole('button', { name: 'Send to everyone' }).click();
  await expect.poll(() => student.getByTestId('student-file-Handout.pdf').getByTestId('file-state').textContent(), { timeout: 15_000 }).toBe('Downloaded');
  await expect.poll(() => teacher.getByTestId('teacher-file-Handout.pdf').getByTestId('completed-count').textContent()).toBe('1');

  // ---- Assignment ----
  await teacher.getByRole('button', { name: 'New assignment' }).click();
  await teacher.getByLabel('Title').fill('Assignment 04');
  await teacher.getByLabel('Allowed types').fill('pdf');
  await teacher.getByRole('button', { name: 'Publish' }).click();
  const asg = student.getByTestId('assignment-Assignment 04');
  await asg.waitFor();
  await chooseFiles(studentApp, [join(scratch, 'Lecture-05.pdf')]);
  await asg.getByRole('button', { name: 'Submit file' }).click();
  await asg.getByTestId('receipt').waitFor({ timeout: 15_000 });
  expect(await asg.getByTestId('receipt').textContent()).toContain('Lecture-05.pdf');
  await expect.poll(() => teacher.getByTestId('submitted-count').textContent()).toBe('1');
  await student.getByText('Receipts saved on this device (1)').waitFor();

  if (process.env.SCREENSHOT_DIR) {
    await teacher.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'teacher-m2.png'), fullPage: true });
    await student.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'student-m2.png'), fullPage: true });
  }

  // Teacher ends class -> student is told.
  teacher.once('dialog', (d) => d.accept());
  await teacher.getByRole('button', { name: 'End class' }).click();
  await student.getByText('The class has ended.').waitFor({ timeout: 5000 });
}, 180_000);

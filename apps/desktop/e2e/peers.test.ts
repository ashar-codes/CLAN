// Milestone 2.75: three real Electron apps (teacher, student A, student B) on this machine's LAN.
// Proves peer-assisted transfer between real apps, teacher-signed verification, switching back to teacher-only, and
// fallback when the serving peer disappears mid-transfer.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'clan-peers-')); dirs.push(scratch);
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const chooseFiles = (app: ElectronApplication, paths: string[]) => app.evaluate(({ dialog }, ps) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: ps })) as never; }, paths);

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = mkdtempSync(join(tmpdir(), 'clan-')); dirs.push(userData);
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: ['.'] }), cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData, ...env } });
  apps.push(app);
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function joinAs(page: Page, name: string, code: string) {
  await page.getByText('Join Classroom').click();
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Student / roll number').fill(`R-${name}`);
  await page.getByLabel('Device name').fill(`${name}-Mac`);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.code-input').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByText('Waiting for the teacher').waitFor({ timeout: 15_000 });
}

it('teacher + two students: peer transfer, signature verified, teacher-only switch, peer disappears mid-transfer', async () => {
  const { app: teacherApp, page: teacher } = await launch();
  await teacher.getByText('Create Classroom').click();
  await teacher.getByLabel('Class name').fill('Networks');
  await teacher.getByRole('button', { name: 'Start Classroom' }).click();
  const code = (await teacher.getByLabel('Classroom code').textContent())!.replace(/\D/g, '');
  await teacher.getByTestId('peer-assist-toggle').click();
  await expect.poll(() => teacher.getByTestId('distribution').textContent()).toContain('Peer Assistance ON');

  const dlA = join(scratch, 'A'), dlB = join(scratch, 'B');
  // A's peer upload is capped so the later "disappears mid-transfer" step has time to happen on a fast machine.
  let A = await launch({ CLASSROOM_DOWNLOADS_DIR: dlA, CLASSROOM_PEER_UPLOAD_LIMIT: String(25 * 1024 * 1024) });
  const B = await launch({ CLASSROOM_DOWNLOADS_DIR: dlB });
  await joinAs(A.page, 'Ali', code);
  await joinAs(B.page, 'Sara', code);
  await teacher.getByRole('button', { name: /Approve all/ }).click();
  for (const p of [A.page, B.page]) await p.getByTestId('secure-state').waitFor({ timeout: 10_000 });
  for (const p of [A.page, B.page]) await p.getByRole('button', { name: 'Details' }).click();

  // ---- peer-assisted transfer A -> B ----
  const big = randomBytes(48 * 1024 * 1024);
  writeFileSync(join(scratch, 'Lecture.mp4'), big);
  await chooseFiles(teacherApp, [join(scratch, 'Lecture.mp4')]);
  await teacher.getByRole('button', { name: 'Add files' }).click();
  const fileA = A.page.getByTestId('student-file-Lecture.mp4');
  await fileA.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => fileA.getByTestId('file-state').textContent(), { timeout: 60_000 }).toMatch(/^Downloaded/);
  expect(sha(readFileSync(join(dlA, 'Networks', 'Lecture.mp4')))).toBe(sha(big));
  await new Promise((r) => setTimeout(r, 1500)); // A's availability announcement reaches the teacher
  const fileB = B.page.getByTestId('student-file-Lecture.mp4');
  await fileB.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => fileB.getByTestId('file-state').textContent(), { timeout: 60_000 }).toMatch(/^Downloaded/);
  const viaB = await fileB.getByTestId('file-via').textContent();
  expect(viaB).toMatch(/1 peer/); // bytes came from student A's app
  expect(viaB).toContain('teacher-signed ✓'); // manifest signature + every chunk + whole file verified
  expect(sha(readFileSync(join(dlB, 'Networks', 'Lecture.mp4')))).toBe(sha(big));

  // ---- teacher disables peer assistance: next transfer is teacher-only ----
  await teacher.getByTestId('peer-assist-toggle').click();
  await expect.poll(() => teacher.getByTestId('distribution').textContent()).toContain('Teacher only');
  const second = randomBytes(12 * 1024 * 1024);
  writeFileSync(join(scratch, 'Slides.pdf'), second);
  await chooseFiles(teacherApp, [join(scratch, 'Slides.pdf')]);
  await teacher.getByRole('button', { name: 'Add files' }).click();
  for (const p of [A.page, B.page]) {
    const f = p.getByTestId('student-file-Slides.pdf');
    await f.getByRole('button', { name: 'Download' }).click();
    await expect.poll(() => f.getByTestId('file-state').textContent(), { timeout: 60_000 }).toMatch(/^Downloaded/);
    expect(await f.getByTestId('file-via').textContent()).toContain('via teacher');
  }

  // ---- peer disappears mid-transfer: B falls back and still verifies ----
  await teacher.getByTestId('peer-assist-toggle').click();
  const third = randomBytes(160 * 1024 * 1024);
  writeFileSync(join(scratch, 'Dataset.zip'), third);
  await chooseFiles(teacherApp, [join(scratch, 'Dataset.zip')]);
  await teacher.getByRole('button', { name: 'Add files' }).click();
  const fA = A.page.getByTestId('student-file-Dataset.zip');
  await fA.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => fA.getByTestId('file-state').textContent(), { timeout: 90_000 }).toMatch(/^Downloaded/);
  await new Promise((r) => setTimeout(r, 1500));
  const fB = B.page.getByTestId('student-file-Dataset.zip');
  await fB.getByRole('button', { name: 'Download' }).click();
  await expect.poll(async () => { const t = (await fB.getByTestId('file-state').textContent()) ?? ''; const m = /(\d+)%/.exec(t); return m ? Number(m[1]) : 0; }, { timeout: 60_000, intervals: [50] }).toBeGreaterThanOrEqual(10);
  await A.app.close(); // the serving peer vanishes (laptop closed)
  await expect.poll(() => fB.getByTestId('file-state').textContent(), { timeout: 120_000 }).toMatch(/^Downloaded/);
  expect(await fB.getByTestId('file-via').textContent()).toContain('teacher');
  expect(sha(readFileSync(join(dlB, 'Networks', 'Dataset.zip')))).toBe(sha(third));
  void A;

  // ---- class ends ----
  teacher.once('dialog', (d) => d.accept());
  await teacher.getByRole('button', { name: 'End class' }).click();
  await B.page.getByText('The class has ended.').waitFor({ timeout: 10_000 });
}, 400_000);

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
async function launch(env: Record<string, string> = {}, userData = mkdtempSync(join(tmpdir(), 'clan-'))): Promise<Page> {
  if (!userDataDirs.includes(userData)) userDataDirs.push(userData);
  // E2E_EXECUTABLE=release/mac-arm64/CLAN.app/Contents/MacOS/CLAN tests the packaged build instead.
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: ['.'] }), cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData, ...env } });
  apps.push(app);
  lastApp = app;
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}
const userDataDirs: string[] = [];
afterAll(async () => { await Promise.all(apps.map((a) => a.close())); for (const d of [scratch, ...userDataDirs]) rmSync(d, { recursive: true, force: true }); });

it('secure join, approve, files, assignment + signed receipt, MITM/downgrade/clone rejected, device-key rejoin', async () => {
  const teacher = await launch();
  const teacherApp = lastApp;
  await teacher.getByText('Create Classroom').click();
  await teacher.getByLabel('Class name').fill('Operating Systems');
  await teacher.getByRole('button', { name: 'Start Classroom' }).click();
  const code = (await teacher.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  expect(code).toMatch(/^\d{6}$/);

  const downloads = join(scratch, 'downloads');
  const studentData = mkdtempSync(join(tmpdir(), 'clan-student-'));
  let student = await launch({ CLASSROOM_DOWNLOADS_DIR: downloads }, studentData);
  let studentApp = lastApp;
  await student.getByText('Join Classroom').click();
  await student.getByLabel('Full name').fill('Ashar Khan');
  await student.getByLabel('Student / roll number').fill('FA23-CS-114');
  await student.getByLabel('Device name').fill('Ashar-MacBook');
  await student.getByRole('button', { name: 'Save' }).click();

  // Wrong code first: must be refused without revealing anything.
  await student.locator('.code-input').fill(code === '000000' ? '000001' : '000000');
  await student.getByRole('button', { name: 'Join', exact: true }).click();
  await expect.poll(() => student.locator('.error').textContent(), { timeout: 10_000 }).toContain('No classroom matches');

  await student.locator('.code-input').fill(code);
  await student.getByRole('button', { name: 'Join', exact: true }).click();
  await Promise.race([
    student.getByText('Waiting for the teacher').waitFor({ timeout: 15_000 }),
    student.locator('.error').filter({ hasNotText: 'No classroom matches' }).waitFor({ timeout: 15_000 }).then(async () => { throw new Error('join failed: ' + await student.locator('.error').textContent()); }),
  ]);

  await teacher.getByText('Ashar Khan', { exact: true }).waitFor();
  await teacher.getByRole('button', { name: 'Approve', exact: true }).click();
  await student.getByTestId('secure-state').waitFor({ timeout: 5000 });
  expect(await student.getByTestId('secure-state').textContent()).toMatch(/Secure connection · teacher [0-9A-F]{4}(-[0-9A-F]{4}){3}/);
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
  // Signed receipt verified against the teacher key learned through OPAQUE pairing.
  await expect.poll(() => asg.getByTestId('receipt-verification').textContent()).toBe('Verified ✓');

  // ---- M2.5: transport attacks from inside the real student app ----
  const paired = Object.values(JSON.parse(readFileSync(join(studentData, 'paired-sessions.json'), 'utf8')))[0] as { url: string };
  const host = new URL(paired.url).hostname;
  // (a) Pin enforcement in Chromium: an attacker TLS server on the teacher's IP with its own certificate.
  const { createServer: createTls } = await import('node:tls');
  const { createClassroomTls } = await import('../../../packages/server/src/tls.ts');
  const fake = await createClassroomTls('attacker');
  const attacker = createTls({ cert: fake.certPem, key: fake.keyPem }, (sock) => sock.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'));
  await new Promise<void>((r) => attacker.listen(0, host, r));
  const attackerUrl = `https://${host}:${(attacker.address() as { port: number }).port}`;
  const probe = (url: string) => student.evaluate(async (u) => { try { const r = await fetch(u); return `status ${r.status}`; } catch (e) { return `blocked: ${(e as Error).message}`; } }, url);
  expect(await probe(`${attackerUrl}/api/info`)).toMatch(/^blocked/); // wrong certificate for a pinned host
  expect(await probe(`${paired.url}/api/resources`)).toBe('status 401'); // the genuine pinned server is reachable (TLS ok; no token sent)
  attacker.close();
  // (b) Plaintext downgrade: the renderer can't even attempt ws:// or http:// (CSP), and the server has no plaintext classroom API.
  const ws = await student.evaluate((u) => new Promise<string>((r) => { try { const w = new WebSocket(u); w.onopen = () => r('open'); w.onerror = () => r('error'); } catch (e) { r(`blocked: ${(e as Error).message}`); } }), paired.url.replace('https', 'ws') + '/ws');
  expect(ws).not.toBe('open');
  expect(await probe(paired.url.replace('https', 'http') + '/api/resources')).toMatch(/^blocked/);

  // ---- M2.5: device-key reconnect after an app restart (no code, no re-approval) ----
  await studentApp.close();
  student = await launch({ CLASSROOM_DOWNLOADS_DIR: downloads }, studentData);
  studentApp = lastApp;
  await student.getByText('Join Classroom').click();
  await student.getByRole('button', { name: /Rejoin Operating Systems/ }).click();
  await student.getByTestId('secure-state').waitFor({ timeout: 10_000 });
  await student.getByTestId('student-file-Lecture-05.pdf').getByText('Downloaded').waitFor(); // state survives restart
  await teacher.getByText('Students (1/1 connected)').waitFor();

  // ---- M2.5: copied identity (profile + old UUID, but not the OS-protected private key) is a NEW device ----
  await teacher.getByLabel('Who can join').last().selectOption('known');
  const cloneData = mkdtempSync(join(tmpdir(), 'clan-clone-'));
  writeFileSync(join(cloneData, 'profile.json'), readFileSync(join(studentData, 'profile.json')));
  writeFileSync(join(cloneData, 'paired-sessions.json'), readFileSync(join(studentData, 'paired-sessions.json')));
  const clone = await launch({ CLASSROOM_DOWNLOADS_DIR: join(scratch, 'clone') }, cloneData);
  await clone.getByText('Join Classroom').click();
  await clone.getByRole('button', { name: /Rejoin Operating Systems/ }).click(); // reconnect with a different key: refused
  await expect.poll(() => clone.locator('.error').textContent(), { timeout: 10_000 }).toMatch(/not joined|Join with the code/);
  await clone.locator('.code-input').fill(code);
  await clone.getByRole('button', { name: 'Join', exact: true }).click();
  await clone.getByText('Waiting for the teacher').waitFor({ timeout: 15_000 }); // NOT auto-approved under "known devices"
  await teacher.getByText('New device for this roll number').waitFor();

  if (process.env.SCREENSHOT_DIR) {
    await teacher.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'teacher-m2.png'), fullPage: true });
    await student.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'student-m2.png'), fullPage: true });
  }

  // Teacher ends class -> student is told.
  teacher.once('dialog', (d) => d.accept());
  await teacher.getByRole('button', { name: 'End class' }).click();
  await student.getByText('The class has ended.').waitFor({ timeout: 5000 });
}, 180_000);

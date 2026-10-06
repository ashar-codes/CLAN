// Drives two real Electron instances (teacher + student) over the machine's real LAN interface and mDNS.
// Run: pnpm --filter @classroom/desktop test:e2e  (builds first)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
async function launch(): Promise<Page> {
  // E2E_EXECUTABLE=release/mac-arm64/Classroom LAN.app/Contents/MacOS/Classroom LAN tests the packaged build instead.
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: ['.'] }), cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: mkdtempSync(join(tmpdir(), 'clan-')) } });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}
afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

it('teacher creates a classroom; student joins by code; teacher approves', async () => {
  const teacher = await launch();
  await teacher.getByText('Create Classroom').click();
  await teacher.getByLabel('Class name').fill('Operating Systems');
  await teacher.getByRole('button', { name: 'Start Classroom' }).click();
  const code = (await teacher.getByLabel('Classroom code').textContent())!.replace(/\D/g, '');
  expect(code).toMatch(/^\d{6}$/);

  const student = await launch();
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

  // Teacher ends class -> student is told.
  teacher.once('dialog', (d) => d.accept());
  await teacher.getByRole('button', { name: 'End class' }).click();
  await student.getByText('The class has ended.').waitFor({ timeout: 5000 });
}, 60_000);

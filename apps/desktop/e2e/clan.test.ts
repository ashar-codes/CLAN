// Universal CLAN join with three real apps: a Study Group hosted on one, joined by code from two others. Same secure
// pairing, approval, host-signed files and peer-assisted transfer as classrooms; removal and ending work for members too.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'clan-sg-')); dirs.push(scratch);
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

async function joinByCode(page: Page, name: string, code: string) {
  await page.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await page.getByRole('button', { name: 'Join by Code' }).click();
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Student / roll number').fill(`R-${name}`);
  await page.getByLabel('Device name').fill(`${name}-Mac`);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.code-input').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByText('Waiting for the host').waitFor({ timeout: 20_000 });
}

it('Study Group: create → join by code → approve → host file → peer-assisted → remove → end', async () => {
  const { app: hostApp, page: host } = await launch();
  await host.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await host.getByRole('button', { name: 'Create CLAN' }).click();
  await expect.poll(() => host.getByRole('radio', { name: 'Study group' }).getAttribute('aria-checked')).toBe('true');
  await host.getByLabel('Name', { exact: true }).fill('OS Study Group');
  await host.getByRole('button', { name: 'Start CLAN' }).click();
  const code = (await host.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  expect(code).toMatch(/^\d{6}$/);
  await host.getByText('you are the host').waitFor();
  expect(await host.getByRole('button', { name: 'New assignment' }).count()).toBe(0); // classroom-only capability
  await host.getByTestId('peer-assist-toggle').click();
  await expect.poll(() => host.getByTestId('distribution').textContent()).toContain('Peer Assistance ON');

  const dlA = join(scratch, 'A'), dlB = join(scratch, 'B');
  const A = await launch({ CLASSROOM_DOWNLOADS_DIR: dlA });
  await joinByCode(A.page, 'Ali', code);
  await host.getByRole('button', { name: 'Approve', exact: true }).click();
  await A.page.getByTestId('secure-state').waitFor({ timeout: 10_000 });
  expect(await A.page.getByTestId('secure-state').textContent()).toContain('Study group');
  await expect.poll(() => A.page.getByTestId('clan-members').textContent()).toContain('Ali');
  await A.page.getByRole('button', { name: 'Details' }).click();

  // host shares a file; member downloads and verifies
  const big = randomBytes(24 * 1024 * 1024);
  writeFileSync(join(scratch, 'Notes.pdf'), big);
  await chooseFiles(hostApp, [join(scratch, 'Notes.pdf')]);
  await host.getByRole('button', { name: 'Add files' }).click();
  const fA = A.page.getByTestId('student-file-Notes.pdf');
  await fA.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => fA.getByTestId('file-state').textContent(), { timeout: 60_000 }).toMatch(/^Downloaded/);
  expect(sha(readFileSync(join(dlA, 'OS Study Group', 'Notes.pdf')))).toBe(sha(big));

  // third member joins; peer-assisted transfer from Ali, verified against the host's signature
  const B = await launch({ CLASSROOM_DOWNLOADS_DIR: dlB });
  await joinByCode(B.page, 'Sara', code);
  await host.getByRole('button', { name: 'Approve', exact: true }).click();
  await B.page.getByTestId('secure-state').waitFor({ timeout: 10_000 });
  await B.page.getByRole('button', { name: 'Details' }).click();
  await new Promise((r) => setTimeout(r, 1500));
  const fB = B.page.getByTestId('student-file-Notes.pdf');
  await fB.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => fB.getByTestId('file-state').textContent(), { timeout: 60_000 }).toMatch(/^Downloaded/);
  const via = await fB.getByTestId('file-via').textContent();
  expect(via).toMatch(/1 peer/);
  expect(via).toContain('host-signed ✓');
  expect(sha(readFileSync(join(dlB, 'OS Study Group', 'Notes.pdf')))).toBe(sha(big));

  // host removes Ali: Ali's session ends and its token no longer works
  await host.locator('.person', { hasText: 'Ali' }).getByRole('button', { name: 'Remove' }).click();
  await A.page.getByText('You were removed from this CLAN.').waitFor({ timeout: 10_000 });
  await expect.poll(() => host.locator('.person', { hasText: 'Sara' }).count()).toBeGreaterThan(0);

  // the CLAN ends for everyone; Sara keeps her downloaded file and the CLAN stays in her My CLANs
  host.once('dialog', (d) => d.accept());
  await host.getByRole('button', { name: 'End CLAN' }).click();
  await B.page.getByText('The CLAN has ended.').waitFor({ timeout: 10_000 });
  expect(sha(readFileSync(join(dlB, 'OS Study Group', 'Notes.pdf')))).toBe(sha(big));
  await B.page.getByRole('button', { name: 'OK' }).click();
  await B.page.getByRole('button', { name: '← Back' }).click();
  await B.page.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await B.page.locator('.clan-card', { hasText: 'OS Study Group' }).waitFor();
}, 300_000);

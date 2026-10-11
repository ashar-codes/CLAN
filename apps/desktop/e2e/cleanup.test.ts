import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const profile = mkdtempSync(join(tmpdir(), 'clan-owner-cleanup-'));
const source = join(profile, 'student-original.txt'); writeFileSync(source, 'Original stays outside managed storage');
let app: ElectronApplication | undefined;
afterAll(async () => { await app?.close(); rmSync(profile, { recursive: true, force: true }); });
async function launch() {
  app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: profile } });
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); return page;
}

it('owner deletion confirms the last-copy risk, fences rehosting across restart and preserves personal data/source files', async () => {
  let page = await launch();
  await page.evaluate(() => window.classroom.clan.createNote({ title: 'Personal note stays', body: 'Private' }));
  await page.getByRole('button', { name: 'CLANs', exact: true }).click();
  await page.getByRole('button', { name: 'Create CLAN', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Owner delete group');
  await page.getByRole('button', { name: 'Start CLAN', exact: true }).click(); await page.getByLabel('Join code').waitFor();
  const id = await page.evaluate(() => window.classroom.clan.list().then((xs) => xs.find((c) => c.name === 'Owner delete group')!.id));
  expect(await page.evaluate((id) => window.classroom.clan.cleanup(id, 'delete').then(() => '', (e) => String(e)), id)).toContain('End the current');
  expect(await page.evaluate(() => window.classroom.clan.pendingCleanup())).toEqual([]);
  await app!.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as never; }, source);
  expect(await page.evaluate(() => window.classroom.addFiles())).toMatchObject({ added: 1 });
  page.once('dialog', (dialog) => dialog.accept()); await page.getByRole('button', { name: 'End CLAN', exact: true }).click();
  await page.getByRole('button', { name: 'CLANs', exact: true }).click(); await page.locator('.clan-card', { hasText: 'Owner delete group' }).click();
  await page.getByRole('button', { name: 'Delete CLAN from this device', exact: true }).click();
  await page.getByText('This device may hold the only copy.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => window.classroom.clan.list().then((xs) => xs.length))).toBe(1);
  const resources = join(profile, 'storage', 'resources');
  const managed = join(resources, readdirSync(resources).find((name) => /^[0-9a-f-]{36}$/.test(name))!);
  writeFileSync(managed, 'Changed managed bytes');
  await page.getByRole('button', { name: 'Delete CLAN from this device', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'changed classroom file' }).waitFor();
  expect(await page.evaluate(() => window.classroom.clan.list())).toEqual([]);
  expect(await page.evaluate(() => window.classroom.clan.pendingCleanup())).toHaveLength(1);
  expect(readFileSync(managed, 'utf8')).toBe('Changed managed bytes');
  writeFileSync(managed, readFileSync(source));
  await page.getByRole('button', { name: '← CLANs', exact: true }).click();
  await page.getByRole('region', { name: 'Pending CLAN cleanup' }).getByRole('button', { name: 'Retry cleanup', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Cleanup finished' }).waitFor();
  expect(await page.evaluate(() => window.classroom.clan.list())).toEqual([]);
  expect(await page.evaluate(() => window.classroom.pastClasses())).toEqual([]);
  expect(await page.evaluate(() => window.classroom.clan.pendingCleanup())).toEqual([]);
  expect(existsSync(source)).toBe(true); expect(readFileSync(source, 'utf8')).toBe('Original stays outside managed storage');
  await app!.close(); app = undefined; page = await launch();
  expect(await page.evaluate(() => window.classroom.clan.list())).toEqual([]);
  expect(await page.evaluate(() => window.classroom.clan.notes().then((xs) => xs.some((n) => n.title === 'Personal note stays')))).toBe(true);
  expect(await page.evaluate((id) => window.classroom.startClassroom({ title: 'Owner delete group', type: 'STUDY_GROUP', clanId: id, connectivity: 'lan', policy: 'approval', distribution: 'host' }).then(() => '', (e) => String(e)), id)).toContain('active CLANs');
}, 90_000);

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
const apps: ElectronApplication[] = [], profiles: string[] = [];
afterAll(async () => { for (const app of apps) await app.close().catch(() => {}); for (const p of profiles) rmSync(p, { recursive: true, force: true }); });
async function launch(profile?: string) {
  profile ??= mkdtempSync(join(tmpdir(), 'clan-leave-')); profiles.push(profile);
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: profile } }); apps.push(app);
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); return { app, page, profile };
}
async function joinGroup(member: Page, host: Page, code: string, first: boolean) {
  if (!await member.locator('.code-input').isVisible()) { await member.getByRole('button', { name: 'CLANs', exact: true }).click(); await member.getByRole('button', { name: 'Join by Code', exact: true }).click(); }
  if (first) { await member.getByLabel('Full name').fill('Leaving student'); await member.getByLabel('Student / roll number').fill('TEST-LEAVE'); await member.getByLabel('Device name').fill('Disposable Mac'); await member.getByRole('button', { name: 'Save', exact: true }).click(); }
  await member.locator('.code-input').fill(code); await member.getByRole('button', { name: 'Join', exact: true }).click();
  await member.getByText('Waiting for the host').waitFor();
  await host.getByRole('button', { name: 'Approve', exact: true }).click(); await member.getByTestId('secure-state').waitFor();
}
it('membership leave revokes host rights, persists local leave, forgets reconnect and requires approval to rejoin', async () => {
  const host = await launch(); let member = await launch();
  await host.page.getByRole('button', { name: 'CLANs', exact: true }).click(); await host.page.getByRole('button', { name: 'Create CLAN', exact: true }).click();
  await host.page.getByLabel('Name', { exact: true }).fill('Leave study group'); await host.page.getByRole('button', { name: 'Start CLAN', exact: true }).click();
  const code = (await host.page.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  await joinGroup(member.page, host.page, code, true);
  await member.page.evaluate(() => window.classroom.clan.createNote({ title: 'Personal note retained', body: 'Private' }));
  await expect.poll(() => member.page.evaluate(() => window.classroom.clan.list().then((xs) => xs.length))).toBe(1);
  member.page.once('dialog', (dialog) => dialog.accept()); await member.page.getByRole('button', { name: 'Leave membership', exact: true }).click();
  await member.page.locator('.code-input').waitFor();
  await expect.poll(() => member.page.evaluate(() => window.classroom.clan.list().then((xs) => xs.length))).toBe(0);
  expect(await member.page.evaluate(() => window.classroom.lastSession())).toBeNull();
  expect(await member.page.evaluate(() => window.classroom.clan.notes().then((xs) => xs.some((n) => n.title === 'Personal note retained')))).toBe(true);
  const profile = member.profile; await member.app.close(); member = await launch(profile);
  expect(await member.page.evaluate(() => window.classroom.lastSession())).toBeNull();
  expect(await member.page.evaluate(() => window.classroom.clan.list())).toEqual([]);
  await joinGroup(member.page, host.page, code, false);
  await expect.poll(() => member.page.evaluate(() => window.classroom.clan.list().then((xs) => xs.length))).toBe(1);
  // Disconnect retains membership. The separate offline leave explicitly describes its local-only effect.
  await member.page.getByRole('button', { name: 'Leave', exact: true }).click();
  await member.page.getByRole('button', { name: '← Back', exact: true }).click();
  await member.page.getByRole('button', { name: 'CLANs', exact: true }).click();
  await member.page.locator('.clan-card', { hasText: 'Leave study group' }).click();
  await member.page.getByRole('button', { name: 'Leave CLAN', exact: true }).click();
  await member.page.getByRole('button', { name: 'Confirm leave', exact: true }).click();
  await expect.poll(() => member.page.evaluate(() => window.classroom.clan.list().then((xs) => xs.length))).toBe(0);
  expect(await member.page.evaluate(() => window.classroom.lastSession())).toBeNull();
}, 90_000);

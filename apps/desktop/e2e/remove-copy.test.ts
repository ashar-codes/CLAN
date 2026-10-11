import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [], profiles: string[] = [];
afterAll(async () => { for (const app of apps) await app.close().catch(() => {}); for (const dir of profiles) rmSync(dir, { recursive: true, force: true }); });
async function launch(profile?: string) {
  profile ??= mkdtempSync(join(tmpdir(), 'clan-remove-copy-')); profiles.push(profile);
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: profile } }); apps.push(app);
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); return { app, page, profile };
}

it('member copy removal confirms scope, clears reconnect/cache across restart and retains private notes and host authority', async () => {
  const host = await launch(); let member = await launch();
  await host.page.getByRole('button', { name: 'CLANs', exact: true }).click(); await host.page.getByRole('button', { name: 'Create CLAN', exact: true }).click();
  await host.page.getByLabel('Name', { exact: true }).fill('Remove copy group'); await host.page.getByRole('button', { name: 'Start CLAN', exact: true }).click();
  const code = (await host.page.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  await member.page.getByRole('button', { name: 'CLANs', exact: true }).click(); await member.page.getByRole('button', { name: 'Join by Code', exact: true }).click();
  await member.page.getByLabel('Full name').fill('Removing student'); await member.page.getByLabel('Student / roll number').fill('TEST-REMOVE'); await member.page.getByLabel('Device name').fill('Disposable Mac'); await member.page.getByRole('button', { name: 'Save', exact: true }).click();
  await member.page.locator('.code-input').fill(code); await member.page.getByRole('button', { name: 'Join', exact: true }).click();
  await member.page.getByText('Waiting for the host').waitFor(); await host.page.getByRole('button', { name: 'Approve', exact: true }).click(); await member.page.getByTestId('secure-state').waitFor();
  await member.page.evaluate(() => window.classroom.clan.createNote({ title: 'Personal stays after removal' }));
  const id = await member.page.evaluate(() => window.classroom.clan.list().then((xs) => xs[0]!.id));
  expect(await member.page.evaluate((id) => window.classroom.clan.cleanup(id, 'delete').then(() => '', (e) => String(e)), id)).toContain('Only the owner');
  await member.page.getByRole('button', { name: 'Leave', exact: true }).click(); await member.page.getByRole('button', { name: '← Back', exact: true }).click();
  await member.page.getByRole('button', { name: 'CLANs', exact: true }).click(); await member.page.locator('.clan-card', { hasText: 'Remove copy group' }).click();
  expect(await member.page.getByRole('button', { name: 'Delete CLAN from this device', exact: true }).count()).toBe(0);
  await member.page.getByRole('button', { name: 'Remove CLAN copy from this device', exact: true }).click();
  await member.page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await member.page.evaluate(() => window.classroom.clan.list().then((xs) => xs.length))).toBe(1);
  await member.page.getByRole('button', { name: 'Remove CLAN copy from this device', exact: true }).click(); await member.page.getByRole('button', { name: 'Confirm remove', exact: true }).click();
  await member.page.getByRole('status').filter({ hasText: 'CLAN cleanup finished' }).waitFor();
  expect(await member.page.evaluate(() => window.classroom.lastSession())).toBeNull();
  expect(await member.page.evaluate((id) => window.classroom.chat.local(id), id)).toEqual([]);
  expect(await host.page.evaluate(() => window.classroom.clan.list().then((xs) => xs.length))).toBe(1);
  await host.page.getByLabel('Join code').waitFor();
  await member.app.close(); member = await launch(member.profile);
  expect(await member.page.evaluate(() => window.classroom.clan.list())).toEqual([]);
  expect(await member.page.evaluate(() => window.classroom.lastSession())).toBeNull();
  expect(await member.page.evaluate(() => window.classroom.clan.notes().then((xs) => xs.some((n) => n.title === 'Personal stays after removal')))).toBe(true);
}, 90_000);

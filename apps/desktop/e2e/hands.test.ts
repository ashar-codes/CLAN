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

it('host receives private join/hand notices and can acknowledge a member hand without granting other authority', async () => {
  const host = await launch(); let member = await launch();
  await host.page.getByRole('button', { name: 'My CLANs', exact: true }).click(); await host.page.getByRole('button', { name: 'Create CLAN', exact: true }).click();
  await host.page.getByLabel('Name', { exact: true }).fill('Hands group'); await host.page.getByRole('button', { name: 'Start CLAN', exact: true }).click();
  const code = (await host.page.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  await member.page.getByRole('button', { name: 'My CLANs', exact: true }).click(); await member.page.getByRole('button', { name: 'Join by Code', exact: true }).click();
  await member.page.getByLabel('Full name').fill('Hand student'); await member.page.getByLabel('Student / roll number').fill('TEST-REMOVE'); await member.page.getByLabel('Device name').fill('Disposable Mac'); await member.page.getByRole('button', { name: 'Save', exact: true }).click();
  await member.page.locator('.code-input').fill(code); await member.page.getByRole('button', { name: 'Join', exact: true }).click();
  await member.page.getByText('Waiting for the host').waitFor(); expect(await member.page.getByRole('button', { name: 'Raise hand', exact: true }).count()).toBe(0); await host.page.getByRole('button', { name: 'Approve', exact: true }).click(); await member.page.getByTestId('secure-state').waitFor();

  await host.page.getByRole('status').filter({ hasText: 'A member is waiting for your approval.' }).waitFor();
  await member.page.getByRole('button', { name: 'Raise hand', exact: true }).click();
  await member.page.getByRole('button', { name: 'Lower hand', exact: true }).waitFor();
  await host.page.getByText('Raised hands (1)', { exact: true }).waitFor();
  await host.page.getByRole('status').filter({ hasText: 'A member raised their hand.' }).waitFor();
  await host.page.getByRole('button', { name: 'Acknowledge hand', exact: true }).click();
  await member.page.getByRole('button', { name: 'Raise hand', exact: true }).waitFor();
  await host.page.getByText('Raised hands (0)', { exact: true }).waitFor();
}, 90_000);

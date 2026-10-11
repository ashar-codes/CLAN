import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const profile = mkdtempSync(join(tmpdir(), 'clan-lifecycle-'));
let app: ElectronApplication | undefined;
afterAll(async () => { await app?.close(); rmSync(profile, { recursive: true, force: true }); });
async function launch() {
  app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: profile } });
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded'); return page;
}

it('archive requires confirmation, survives restart, retains room access and restores the local list', async () => {
  let page = await launch();
  await page.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await page.getByRole('button', { name: 'Create CLAN' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Archive study group');
  await page.getByRole('button', { name: 'Start CLAN' }).click();
  await page.getByLabel('Join code').waitFor();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'End CLAN', exact: true }).click();
  await page.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await page.locator('.clan-card', { hasText: 'Archive study group' }).click();
  await page.getByRole('button', { name: 'Archive on this device', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.getByRole('button', { name: 'Confirm archive' }).count()).toBe(0);
  await page.getByRole('button', { name: 'Archive on this device', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm archive', exact: true }).click();
  await expect.poll(() => page.locator('.clan-card', { hasText: 'Archive study group' }).count()).toBe(0);
  await page.getByRole('region', { name: 'Archived CLANs' }).getByRole('button', { name: 'Archive study group', exact: true }).waitFor();
  await app!.close(); app = undefined; page = await launch();
  await page.getByRole('button', { name: 'My CLANs', exact: true }).click();
  const archived = page.getByRole('region', { name: 'Archived CLANs' });
  await archived.getByRole('button', { name: 'Archive study group', exact: true }).click();
  await page.getByRole('heading', { name: 'Archive study group', exact: true }).waitFor();
  await page.getByRole('button', { name: '← CLANs', exact: true }).click();
  await page.getByRole('region', { name: 'Archived CLANs' }).getByRole('button', { name: 'Restore', exact: true }).click();
  await page.locator('.clan-card', { hasText: 'Archive study group' }).waitFor();
  await expect.poll(() => page.getByRole('region', { name: 'Archived CLANs' }).count()).toBe(0);
}, 90_000);

// Personal device sync, two real app instances on this machine: link by code with approval → a note syncs → both go
// "offline" (paused) and edit it → reconnect → the conflict is shown and resolved with "Keep both" → unlink → refused.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); }, 30_000);

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'clan-sync-')); dirs.push(userData);
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: ['.'] }), cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData } });
  apps.push(app);
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return page;
}
const devices = async (p: Page) => { await p.getByRole('button', { name: 'Me', exact: true }).click(); const d = p.getByTestId('my-devices'); await d.waitFor(); return d; };
const notes = async (p: Page) => { await p.getByRole('button', { name: 'Study', exact: true }).click(); await p.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name: 'Notes', exact: true }).click(); };
const editNote = async (p: Page, title: string, body: string) => {
  await notes(p); await p.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
  await p.getByLabel('Note', { exact: true }).fill(body); await p.getByRole('button', { name: 'Save', exact: true }).click();
};
const syncNow = async (p: Page) => { const d = await devices(p); await d.getByRole('button', { name: 'Sync now' }).click(); await d.getByRole('status').filter({ hasText: /Synced|failed|unlinked|not linked/i }).waitFor(); };

it('My Devices: link, sync, offline edits on both, resolve, unlink, refused', async () => {
  const a = await launch(), b = await launch();

  // link: code shown on A, typed on B, approved on A
  const da = await devices(a);
  await da.getByRole('button', { name: 'Link a new device' }).click();
  const box = da.getByTestId('link-code');
  const code = (await box.getByLabel('Link code').textContent())!.trim();
  const addr = /(\d+\.\d+\.\d+\.\d+:\d+)/.exec((await box.textContent())!)?.[1] ?? '';
  expect(code).toMatch(/^CLAN-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  const db = await devices(b);
  await db.getByRole('button', { name: 'This is my new device' }).click();
  await db.getByLabel('Link code').fill(code);
  await db.getByLabel('Device address').fill(addr);
  await db.getByRole('button', { name: 'Link', exact: true }).click();
  const ask = a.getByRole('alertdialog', { name: 'Approve device' });
  await ask.waitFor({ timeout: 30_000 });
  await ask.getByRole('button', { name: 'Approve' }).click();
  await db.getByRole('status').filter({ hasText: 'Linked' }).waitFor({ timeout: 30_000 });
  await expect.poll(() => da.getByTestId('device-row').count()).toBe(2);

  // a note written on A arrives on B
  await notes(a);
  await a.getByRole('button', { name: 'New note' }).click();
  await a.getByLabel('Title', { exact: true }).fill('Thermodynamics');
  await a.getByLabel('Note', { exact: true }).fill('first law');
  await a.getByRole('button', { name: 'Save', exact: true }).click();
  await syncNow(b);
  await notes(b);
  await b.getByRole('button', { name: /^Thermodynamics/ }).first().click();
  await expect.poll(() => b.getByLabel('Note', { exact: true }).inputValue()).toBe('first law');

  // "disconnect" both (pause), edit the same note on each, reconnect
  const pause = async (p: Page, on: boolean) => { const c = (await devices(p)).getByRole('checkbox', { name: /Pause sync/ }); await c.click(); await expect.poll(() => c.isChecked()).toBe(on); };
  for (const p of [a, b]) await pause(p, true);
  await editNote(a, 'Thermodynamics', 'laptop: energy is conserved');
  await editNote(b, 'Thermodynamics', 'phone: ΔU = Q − W');
  for (const p of [a, b]) await pause(p, false);
  await syncNow(b);
  const conflict = (await devices(b)).getByTestId('conflict').first();
  await conflict.waitFor({ timeout: 30_000 });
  await expect.poll(() => conflict.textContent()).toMatch(/phone: ΔU[\s\S]*laptop: energy/);
  await conflict.getByRole('button', { name: 'Keep both' }).click();
  await syncNow(b);
  await notes(a);
  await expect.poll(async () => a.getByRole('button', { name: /^Thermodynamics/ }).count(), { timeout: 30_000 }).toBe(2); // the note + a copy of the other version

  // unlink B on A → B is refused and says so
  const d2 = await devices(a);
  const row = d2.getByTestId('device-row').filter({ hasNotText: 'this device' });
  await row.getByRole('button', { name: 'Unlink' }).click();
  await row.getByRole('button', { name: /^Unlink / }).click();
  await d2.getByRole('status').filter({ hasText: 'unlinked' }).waitFor();
  const d3 = await devices(b);
  await d3.getByRole('button', { name: 'Sync now' }).click();
  await d3.getByRole('alert').filter({ hasText: 'This device was unlinked' }).waitFor({ timeout: 30_000 });
  await expect(d3.getByRole('button', { name: 'Sync now' }).isDisabled()).resolves.toBe(true);
});

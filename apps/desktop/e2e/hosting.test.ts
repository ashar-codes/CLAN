// Persistent hosting across two real app instances (two disposable profiles): link the owner's computers, allow moving
// hosting, ask, confirm the pause, hand over with progress, and see the destination host while the source is fenced.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const profiles = [mkdtempSync(join(tmpdir(), 'clan-host-a-')), mkdtempSync(join(tmpdir(), 'clan-host-b-'))];
const apps: ElectronApplication[] = [];
afterAll(async () => { for (const a of apps) await a.close().catch(() => {}); for (const p of profiles) rmSync(p, { recursive: true, force: true }); });
async function launch(profile: string, name: string): Promise<Page> {
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: profile, CLAN_TEST_LOOPBACK: '1' } });
  apps.push(app);
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  await page.evaluate((n) => (window as unknown as { classroom: { saveProfile(p: object): Promise<unknown> } }).classroom.saveProfile({ fullName: 'Owner Person', rollNo: 'FA23-001', deviceName: n }), name);
  return page;
}
type W = { classroom: { sync: { startLink(): Promise<{ code: string; addresses: string[] }>; join(c: string, a: string): Promise<unknown>; status(): Promise<{ linkRequest: { sessionId: string } | null }>; approve(id: string): Promise<void> } } };

it('moves hosting between the owner\'s linked computers with explicit confirmation, progress and fencing', async () => {
  const a = await launch(profiles[0]!, 'Desk A'), b = await launch(profiles[1]!, 'Desk B');
  // link B to A (Me › My Devices does the same calls; the UI flow is covered by sync E2E)
  const link = await a.evaluate(() => (window as unknown as W).classroom.sync.startLink());
  const joining = b.evaluate(([c, ad]) => (window as unknown as W).classroom.sync.join(c!, ad!), [link.code, link.addresses.find((x) => x.startsWith('127.0.0.1'))!]);
  await expect.poll(async () => !!(await a.evaluate(() => (window as unknown as W).classroom.sync.status())).linkRequest, { timeout: 20_000 }).toBe(true);
  const req = (await a.evaluate(() => (window as unknown as W).classroom.sync.status())).linkRequest!;
  await a.evaluate((id) => (window as unknown as W).classroom.sync.approve(id), req.sessionId);
  await joining;

  // A creates and hosts a Study Group, then ends the live session
  await a.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await a.getByRole('button', { name: 'Create CLAN' }).click();
  await a.getByLabel('Name', { exact: true }).fill('Movable group');
  await a.getByRole('button', { name: 'Start CLAN' }).click();
  await a.getByLabel('Join code').waitFor();
  a.once('dialog', (d) => d.accept());
  await a.getByRole('button', { name: 'End CLAN', exact: true }).click();
  await a.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await a.locator('.clan-card', { hasText: 'Movable group' }).click();
  const panel = a.getByRole('region', { name: 'Hosting' });
  await panel.getByRole('button', { name: 'Allow moving hosting…' }).click();
  await panel.getByRole('button', { name: 'Allow', exact: true }).click();
  await panel.getByText('This computer hosts this CLAN.').waitFor();
  await panel.getByLabel('Move hosting to').selectOption({ index: 1 }); // the other linked computer (device names come from the OS here)
  await panel.getByRole('button', { name: 'Ask current host' }).click();
  await panel.getByText('The owner asked to move hosting to').waitFor();
  await panel.getByRole('button', { name: /^Hand over to .+…$/ }).click();
  await panel.getByRole('group', { name: 'Confirm hand-over' }).getByText('Members cannot change anything').waitFor();
  await panel.getByRole('button', { name: 'Pause and hand over' }).click();
  await panel.getByText(/now hosts this CLAN\./).waitFor({ timeout: 60_000 });
  await panel.getByText(/Hosted by /).waitFor(); // the source learned the new head and is a standby

  // B now holds the CLAN as its host
  await b.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await b.locator('.clan-card', { hasText: 'Movable group' }).click({ timeout: 20_000 });
  await b.getByRole('region', { name: 'Hosting' }).getByText('This computer hosts this CLAN.').waitFor();

  // A is fenced: hosting again is refused with a clear reason
  await a.getByRole('button', { name: 'Host again' }).click();
  await a.getByRole('heading', { name: 'Host Movable group again' }).waitFor();
  await a.getByRole('button', { name: 'Host again', exact: true }).last().click();
  await a.getByText(/handed hosting over|another device is the authorized host/i).waitFor();

  // the owner stops B hosting: B refuses changes from then on
  await a.getByRole('button', { name: '← Back' }).click();
  await a.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await a.locator('.clan-card', { hasText: 'Movable group' }).click();
  const ap = a.getByRole('region', { name: 'Hosting' });
  await ap.getByRole('button', { name: /^Stop .+ hosting…$/ }).click();
  await ap.getByRole('button', { name: 'Stop hosting', exact: true }).click();
  await ap.getByText(/no longer accepts changes\./).waitFor({ timeout: 30_000 });
  await b.getByRole('button', { name: '← CLANs' }).click();
  await b.locator('.clan-card', { hasText: 'Movable group' }).click();
  await b.getByRole('region', { name: 'Hosting' }).getByText(/can no longer accept changes: .*revoked/).waitFor();
}, 240_000);

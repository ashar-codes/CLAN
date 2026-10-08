// Screen sharing E2E: real Electron apps, real local SFU, real WebRTC. The presenter uses the TEST-ONLY pattern source
// (CLAN_TEST_CAPTURE=1, development builds only) so the viewer can prove it receives *changing* frames.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'clan-')); dirs.push(userData);
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData, CLAN_TEST_CAPTURE: '1' } });
  apps.push(app);
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.on('dialog', (d) => d.accept());
  return page;
}
async function hostClan(p: Page, type: 'Classroom' | 'Study group', name: string) {
  await p.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await p.getByRole('button', { name: 'Create CLAN' }).click();
  await p.getByRole('radio', { name: type, exact: true }).click();
  await p.getByLabel(type === 'Classroom' ? 'Class name' : 'Name', { exact: true }).fill(name);
  await p.getByRole('button', { name: type === 'Classroom' ? 'Start Classroom' : 'Start CLAN' }).click();
  return (await p.getByLabel('Join code').textContent())!.replace(/\D/g, '');
}
async function joinClan(p: Page, name: string, code: string, host: Page) {
  await p.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await p.getByRole('button', { name: 'Join by Code' }).click();
  await p.getByLabel('Full name').fill(name); await p.getByLabel('Student / roll number').fill(`R-${name}`); await p.getByLabel('Device name').fill(`${name}-Mac`);
  await p.getByRole('button', { name: 'Save' }).click();
  await p.locator('.code-input').fill(code); await p.getByRole('button', { name: 'Join', exact: true }).click();
  await host.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 25_000 });
  await p.getByTestId('secure-state').waitFor({ timeout: 15_000 });
}
async function present(p: Page, which: 'screen' | 'window') {
  await p.getByRole('option', { name: `Test pattern (${which})` }).click();
  await p.getByRole('button', { name: which === 'window' ? 'Share this window' : 'Share this screen' }).click();
}
/** Samples the wall video: distinct frames over ~2 s + the dominant background colour. */
const sample = (p: Page) => p.evaluate(async () => {
  const v = document.querySelector<HTMLVideoElement>('[data-testid="screen-video"]');
  if (!v || !v.videoWidth) return { distinct: 0, red: 0, blue: 0, w: 0 };
  const c = Object.assign(document.createElement('canvas'), { width: 96, height: 54 }); const g = c.getContext('2d')!;
  const seen = new Set<number>(); let red = 0, blue = 0;
  for (let i = 0; i < 7; i++) { g.drawImage(v, 0, 0, 96, 54); const d = g.getImageData(0, 0, 96, 54).data; let h = 0; for (let k = 0; k < d.length; k += 37) h = (h * 31 + d[k]!) >>> 0; seen.add(h); red = d[4 * 96 * 50 + 8]!; blue = d[4 * 96 * 50 + 10]!; await new Promise((r) => setTimeout(r, 300)); }
  return { distinct: seen.size, red, blue, w: v.videoWidth };
});

it('Study Group: member presents → host wall shows live frames → switch source → stop → wall returns', async () => {
  const host = await launch();
  const code = await hostClan(host, 'Study group', 'Screen Study Group');
  const sara = await launch();
  await joinClan(sara, 'Sara', code, host);
  await sara.getByRole('button', { name: 'Present', exact: true }).click();
  await present(sara, 'screen');
  await sara.getByTestId('presenter-bar').waitFor({ timeout: 15_000 });
  await host.getByTestId('screen-video').waitFor({ timeout: 20_000 });
  await expect.poll(async () => (await sample(host)).distinct, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
  expect(await host.getByTestId('wall-state').textContent()).toBe('Sara is presenting their screen');
  const navy = await sample(host);
  expect(navy.blue).toBeGreaterThan(navy.red); // screen pattern: navy background
  // switch source without ending anything
  await sara.getByRole('button', { name: 'Switch source' }).click();
  await present(sara, 'window');
  await expect.poll(async () => { const s = await sample(host); return s.red > s.blue && s.distinct >= 3; }, { timeout: 20_000 }).toBe(true); // window pattern: burgundy
  expect(await host.getByTestId('wall-state').textContent()).toBe('Sara is presenting their window');
  // stop → wall back to the room
  await sara.getByTestId('presenter-bar').getByRole('button', { name: 'Stop' }).click();
  await host.locator('.wall-code').waitFor({ timeout: 10_000 });
  expect(await host.getByTestId('screen-video').count()).toBe(0);
  expect(await sara.getByTestId('presenter-bar').count()).toBe(0);
}, 180_000);

it('Classroom: student requests → host allows → student presents → host stops it', async () => {
  const teacher = await launch();
  const code = await hostClan(teacher, 'Classroom', 'Screen Classroom');
  const hana = await launch();
  await joinClan(hana, 'Hana', code, teacher);
  expect(await hana.getByRole('button', { name: 'Present', exact: true }).count()).toBe(0); // not allowed yet
  await hana.getByRole('button', { name: 'Request to present' }).click();
  await hana.getByText('Waiting for the host to let you present').waitFor();
  await teacher.getByText('Hana wants to present').waitFor({ timeout: 10_000 });
  await teacher.getByRole('button', { name: 'Allow' }).click();
  await hana.getByRole('button', { name: 'Present', exact: true }).click();
  await present(hana, 'screen');
  await teacher.getByTestId('screen-video').waitFor({ timeout: 20_000 });
  await expect.poll(async () => (await sample(teacher)).distinct, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
  await teacher.getByRole('button', { name: 'Stop Hana’s presentation' }).click();
  await hana.getByTestId('presenter-bar').waitFor({ state: 'detached', timeout: 10_000 });
  await teacher.locator('.wall-code').waitFor({ timeout: 10_000 });
  expect(await hana.getByRole('button', { name: 'Present', exact: true }).count()).toBe(0); // approval covered one presentation
}, 180_000);

it('Minimal experience still shows the presentation; nothing is captured without an explicit pick (server-side refusal: media.test.ts)', async () => {
  const host = await launch();
  const code = await hostClan(host, 'Classroom', 'Minimal Room');
  const ali = await launch();
  await ali.evaluate(() => localStorage.setItem('clan.experience', 'minimal'));
  await ali.reload(); await ali.waitForLoadState('domcontentloaded');
  await joinClan(ali, 'Ali', code, host);
  // the renderer cannot capture anything on its own: no explicit pick in CLAN's picker → denied
  const silent = await ali.evaluate(() => navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => 'captured', () => 'denied'));
  expect(silent).toBe('denied');
  const forged = await ali.evaluate(() => (window as unknown as { classroom: { mediaChoose(id: string, a: boolean): Promise<void> } }).classroom.mediaChoose('screen:999:0', false).then(() => 'ok', () => 'refused'));
  expect(forged).toBe('refused');
  await host.getByRole('button', { name: 'Present', exact: true }).click();
  await present(host, 'screen');
  await ali.getByTestId('screen-video').waitFor({ timeout: 20_000 }); // Minimal: plain wall, no room stage
  expect(await ali.locator('.c-room').count()).toBe(0);
  await expect.poll(async () => (await sample(ali)).distinct, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
  await host.getByTestId('presenter-bar').getByRole('button', { name: 'Stop' }).click();
  await ali.getByTestId('screen-video').waitFor({ state: 'detached', timeout: 10_000 });
}, 180_000);

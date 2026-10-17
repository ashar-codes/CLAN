// REAL screen capture end to end — no test pattern (CLAN_TEST_CAPTURE is unset): Present → CLAN's picker → the OS
// captures a real window and then a real screen → the other CLAN instance shows live, changing frames → immersive
// fullscreen → floating + → private note saved while the stream keeps playing → presenter stops → note kept.
// Windows: runs by default. macOS: needs Screen Recording for the app that launches the test (CLAN_REAL_CAPTURE=1).
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const run = process.platform === 'win32' || process.env.CLAN_REAL_CAPTURE === '1';
const apps: ElectronApplication[] = [];
const dirs: string[] = [];
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'clan-')); dirs.push(userData);
  const env = { ...process.env, CLASSROOM_USER_DATA: userData }; delete env.CLAN_TEST_CAPTURE;
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env });
  apps.push(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.on('dialog', (d) => d.accept());
  return { app, page };
}
/** Green, constantly changing frames from a real window: unmistakably not CLAN's navy/burgundy test pattern. */
const FRAMES = `<title>CLAN Frames Test</title><body style="margin:0;background:#0a8f3c"><canvas id=c width=640 height=360></canvas><script>
const g=c.getContext('2d');let i=0;setInterval(()=>{g.fillStyle='#0a8f3c';g.fillRect(0,0,640,360);g.fillStyle='#fff';g.fillRect((i*23)%600,(i*11)%320,40,40);g.font='48px sans-serif';g.fillText(String(i++),20,340)},50)</script>`;
const sample = (p: Page) => p.evaluate(async () => {
  const v = document.querySelector<HTMLVideoElement>('[data-testid="screen-video"]');
  if (!v || !v.videoWidth) return { distinct: 0, r: 0, g: 0, b: 0 };
  const c = Object.assign(document.createElement('canvas'), { width: 96, height: 54 }); const x = c.getContext('2d')!;
  const seen = new Set<number>(); let r = 0, g = 0, b = 0;
  for (let i = 0; i < 7; i++) { x.drawImage(v, 0, 0, 96, 54); const d = x.getImageData(0, 0, 96, 54).data; let h = 0; for (let k = 0; k < d.length; k += 37) h = (h * 31 + d[k]!) >>> 0; seen.add(h); [r, g, b] = [d[4 * 96 * 10 + 8]!, d[4 * 96 * 10 + 9]!, d[4 * 96 * 10 + 10]!]; await new Promise((z) => setTimeout(z, 300)); }
  return { distinct: seen.size, r, g, b };
});
type Api = { classroom: { clan: { notes(): Promise<{ title: string; body: string }[]> } } };

it.skipIf(!run)('real window and screen capture reach another CLAN; fullscreen + notes while it plays; stop ends capture', async () => {
  const { app: hostApp, page: host } = await launch();
  await hostApp.evaluate(({ BrowserWindow }, html) => { const w = new BrowserWindow({ width: 640, height: 400, x: 40, y: 40, title: 'CLAN Frames Test', webPreferences: { sandbox: true, backgroundThrottling: false } }); void w.loadURL(`data:text/html,${encodeURIComponent(html)}`); }, FRAMES);
  await host.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await host.getByRole('button', { name: 'Create CLAN' }).click();
  await host.getByRole('radio', { name: 'Study group', exact: true }).click();
  await host.getByLabel('Name', { exact: true }).fill('Real Capture');
  await host.getByRole('button', { name: 'Start CLAN' }).click();
  const code = (await host.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  const { page: sara } = await launch();
  await sara.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await sara.getByRole('button', { name: 'Join by Code' }).click();
  await sara.getByLabel('Full name').fill('Sara'); await sara.getByLabel('Student / roll number').fill('R-1'); await sara.getByLabel('Device name').fill('Sara-PC');
  await sara.getByRole('button', { name: 'Save' }).click();
  await sara.locator('.code-input').fill(code); await sara.getByRole('button', { name: 'Join', exact: true }).click();
  await host.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 25_000 });
  await sara.getByTestId('secure-state').waitFor({ timeout: 15_000 });

  // cancelling the picker starts nothing
  await sara.getByRole('button', { name: 'Present', exact: true }).click();
  await sara.getByRole('dialog', { name: 'Present' }).getByRole('button', { name: 'Cancel' }).click();
  expect(await sara.getByTestId('presenter-bar').count()).toBe(0);

  // a real window, chosen explicitly
  await sara.getByRole('button', { name: 'Present', exact: true }).click();
  expect(await sara.getByRole('option', { name: /Test pattern/ }).count()).toBe(0); // not a test build path
  await sara.getByRole('option', { name: 'CLAN Frames Test' }).click({ timeout: 20_000 });
  await sara.getByRole('button', { name: 'Share this window' }).click();
  await sara.getByTestId('presenter-bar').waitFor({ timeout: 15_000 });
  expect(await sara.getByTestId('capture-failure').count()).toBe(0);
  await host.getByTestId('screen-video').waitFor({ timeout: 20_000 });
  await host.bringToFront();
  await expect.poll(async () => { const s = await sample(host); return s.distinct >= 4 && s.g > s.r + 40 && s.g > s.b + 40; }, { timeout: 25_000 }).toBe(true);
  expect(await host.getByTestId('wall-state').textContent()).toBe('Sara is presenting their window');

  // immersive view + floating tools
  await host.getByTestId('screen-wall').dblclick();
  await expect.poll(() => host.evaluate(() => document.body.hasAttribute('data-immersive'))).toBe(true);
  await host.getByTestId('presentation-tools').click();
  for (const n of ['Take Notes', 'Quick Capture', 'Chat', 'Participants', 'Presentation Controls']) await host.getByRole('menuitem', { name: n }).waitFor();
  await host.getByRole('menuitem', { name: 'Take Notes' }).click();
  const notes = host.getByTestId('presentation-notes');
  await notes.getByLabel('Note', { exact: true }).fill('Eigenvalues: slide 3');
  await notes.getByRole('button', { name: 'Save' }).click();
  await notes.getByText('Saved', { exact: true }).waitFor();
  expect((await sample(host)).distinct).toBeGreaterThanOrEqual(4); // stream kept playing while taking notes
  expect(await host.evaluate(() => document.body.hasAttribute('data-immersive'))).toBe(true);
  let mine = await host.evaluate(() => (window as unknown as Api).classroom.clan.notes());
  expect(mine.find((n) => n.body.startsWith('Eigenvalues: slide 3'))?.title).toBe('Notes — Sara’s presentation');
  expect(await host.getByTestId('chat').textContent()).not.toContain('Eigenvalues'); // private: never into the chat
  await host.getByRole('button', { name: 'Minimize' }).click();
  await host.getByRole('button', { name: 'Expand' }).click();
  await notes.getByLabel('Note', { exact: true }).fill('Eigenvalues: slide 3\nunsaved line'); // typed, not saved…

  // switch to an entire real screen without ending the presentation
  await sara.getByRole('button', { name: 'Switch source' }).click();
  await sara.getByRole('listbox', { name: 'Screens' }).getByRole('option').first().click({ timeout: 20_000 });
  await sara.getByRole('button', { name: 'Share this screen' }).click();
  await expect.poll(() => host.getByTestId('wall-state').textContent(), { timeout: 20_000 }).toBe('Sara is presenting their screen');
  await expect.poll(async () => (await sample(host)).distinct, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);

  // …the presenter stops while the note is open: capture ends, fullscreen closes, the note is not lost
  await sara.getByTestId('presenter-bar').getByRole('button', { name: 'Stop' }).click();
  await host.locator('.wall-code').waitFor({ timeout: 10_000 });
  expect(await host.evaluate(() => document.body.hasAttribute('data-immersive'))).toBe(false);
  await expect.poll(async () => { mine = await host.evaluate(() => (window as unknown as Api).classroom.clan.notes()); return mine.some((n) => n.body.includes('unsaved line')); }, { timeout: 10_000 }).toBe(true);
  expect(await sara.getByTestId('presenter-bar').count()).toBe(0);
}, 240_000);

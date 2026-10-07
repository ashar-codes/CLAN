// Production screenshots with real data entered through the real UI (no fixtures).
// Run: pnpm --filter @classroom/desktop build && node apps/desktop/scripts/production-shots.ts
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = join(import.meta.dirname, '../../..');
const out = join(root, 'design/production/after');
for (const d of ['desktop', 'mobile', 'interaction']) mkdirSync(join(out, d), { recursive: true });
const cwd = join(import.meta.dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'clan-shots-'));
const apps: ElectronApplication[] = [];
const launch = async (exp = 'full'): Promise<{ app: ElectronApplication; p: Page }> => {
  const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, CLASSROOM_USER_DATA: mkdtempSync(join(tmpdir(), 'clan-shot-')), CLASSROOM_DOWNLOADS_DIR: join(scratch, `dl-${apps.length}`) } });
  apps.push(app);
  const p = await app.firstWindow();
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.waitForLoadState('domcontentloaded');
  await p.evaluate((e) => { localStorage.setItem('clan.experience', e); }, exp);
  await p.reload(); await p.waitForTimeout(900);
  p.on('dialog', (d) => d.accept());
  return { app, p };
};
const tab = (p: Page, name: string) => p.locator('.tabs-main').getByRole('button', { name, exact: false }).click();
const both = async (p: Page, name: string, settle = 700) => {
  await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(settle);
  await p.screenshot({ path: join(out, 'desktop', `${name}.png`) });
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(settle);
  await p.screenshot({ path: join(out, 'mobile', `${name}.png`) });
  await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(200);
};
async function host(p: Page, type: 'Classroom' | 'Study group' | 'Temporary', name: string) {
  await tab(p, 'CLANs');
  await p.getByRole('button', { name: 'Create CLAN' }).click();
  await p.getByRole('radio', { name: type, exact: true }).click();
  await p.getByLabel(type === 'Classroom' ? 'Class name' : 'Name', { exact: true }).fill(name);
  await p.getByRole('button', { name: type === 'Classroom' ? 'Start Classroom' : 'Start CLAN' }).click();
  return (await p.getByLabel('Join code').textContent())!.replace(/\D/g, '');
}
async function end(p: Page) { await p.getByRole('button', { name: /^End / }).click(); await p.waitForTimeout(600); }
async function rehost(p: Page, name: string) {
  await tab(p, 'CLANs'); await p.locator('.place-card', { hasText: name }).click(); await p.getByRole('button', { name: 'Host again' }).click(); await p.getByRole('button', { name: 'Host again' }).click(); await p.waitForTimeout(500);
}

// a neighbour hosting something, so the Commons has something real nearby
const V = await launch();
await host(V.p, 'Temporary', 'Library study session');

const H = await launch();
const p = H.p;
await tab(p, 'Me'); await p.getByLabel('Your name').fill('Ayesha Khan'); await p.getByRole('button', { name: 'Save name' }).click();
for (const [course, n] of [['Operating Systems', 3], ['Data Structures', 2], ['Linear Algebra', 1]] as const) {
  await host(p, 'Classroom', course); await end(p);
  for (let i = 1; i < n; i++) { await rehost(p, course); await end(p); }
}
await tab(p, 'Study'); await p.getByRole('tab', { name: 'Notes' }).click();
for (const [t, b, share] of [['Dijkstra', 'Greedy: always expand the closest unvisited node.\nNegative edges → Bellman-Ford.', 'Data Structures'], ['Scheduling', 'Round robin vs SJF — quantum trade-offs.', 'Operating Systems'], ['Eigenvalues', 'Av = λv', '']] as const) {
  await p.getByRole('button', { name: 'New note' }).click(); await p.waitForTimeout(250);
  await p.getByLabel('Title').fill(t); await p.getByLabel('Note').fill(b); await p.getByRole('button', { name: 'Save', exact: true }).click(); await p.waitForTimeout(200);
  if (share) await p.getByLabel('Share to CLAN').selectOption({ label: share });
}
await p.getByRole('button', { name: 'Remind me tomorrow' }).click();
await tab(p, 'Saved');
for (const u of ['https://www.youtube.com/watch?v=dijkstra-visualised', 'https://example.org/articles/how-schedulers-work', 'https://example.org/papers/attention.pdf']) { await p.getByLabel('Link').fill(u); await p.getByRole('button', { name: 'Save to Inbox' }).click(); await p.waitForTimeout(250); }
await p.getByLabel('New collection name').fill('Thesis ideas'); await p.getByRole('button', { name: '+ Collection' }).click(); await p.waitForTimeout(300);
await tab(p, 'Me'); await p.getByRole('radio', { name: 'calm' }).click(); await p.getByLabel('Diary entry').fill('Long day, but the scheduling lecture finally clicked. Walked home the long way.'); await p.getByRole('button', { name: 'Save entry' }).click();

await tab(p, 'My Space'); await both(p, '1-my-space', 1200);
await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await both(p, '1b-my-space-night', 600);
await tab(p, 'Study'); await p.getByRole('tab', { name: 'Campus', exact: true }).click(); await p.waitForTimeout(1500); await p.screenshot({ path: join(out, 'desktop', '5c-campus-night.png') });
await p.evaluate(() => { delete document.documentElement.dataset.theme; }); await tab(p, 'My Space');
await tab(p, 'Commons'); await both(p, '2-commons');
await tab(p, 'CLANs'); await both(p, '3-clans');
await tab(p, 'Study'); await p.getByRole('tab', { name: 'Campus' }).click(); await p.waitForFunction(() => !!(window as { __clanPerf?: { sceneMs?: number } }).__clanPerf?.sceneMs, null, { timeout: 15000 }).catch(() => {});
await both(p, '5-knowledge-campus', 1500);
await p.getByRole('button', { name: 'Operating Systems' }).first().click(); await both(p, '5b-course-space');
await tab(p, 'Saved'); await both(p, '6-saved');
await tab(p, 'Me'); await both(p, '8-me');
await p.locator('.diary-book').scrollIntoViewIfNeeded(); await p.setViewportSize({ width: 1440, height: 900 }); await p.screenshot({ path: join(out, 'desktop', '7-diary.png') });
await p.setViewportSize({ width: 390, height: 844 }); await p.locator('.diary-book').scrollIntoViewIfNeeded(); await p.waitForTimeout(400); await p.screenshot({ path: join(out, 'mobile', '7-diary.png') }); await p.setViewportSize({ width: 1440, height: 900 });

// open Study Group, a member joins, a file travels
const code = await host(p, 'Study group', 'OS Study Group');
const M = await launch();
await tab(M.p, 'CLANs'); await M.p.getByRole('button', { name: 'Join by Code' }).click();
await M.p.getByLabel('Full name').fill('Ali Raza'); await M.p.getByLabel('Student / roll number').fill('FA23-CS-114'); await M.p.getByLabel('Device name').fill('Ali-Mac'); await M.p.getByRole('button', { name: 'Save' }).click();
await M.p.locator('.code-input').fill(code); await M.p.getByRole('button', { name: 'Join', exact: true }).click();
await p.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 25000 });
await M.p.getByTestId('secure-state').waitFor({ timeout: 15000 });
writeFileSync(join(scratch, 'Lecture-07-scheduling.pdf'), randomBytes(18 * 1024 * 1024));
await H.app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never; }, join(scratch, 'Lecture-07-scheduling.pdf'));
await p.getByRole('button', { name: 'Add files' }).click(); await p.waitForTimeout(1500);
await both(p, '4-open-study-group-host', 900);
await p.setViewportSize({ width: 1440, height: 900 });
// drag over the table (visual state only; real OS drops are not scriptable)
await p.evaluate(() => { const t = document.querySelector('[data-testid="room-table"]')!; const dt = new DataTransfer(); dt.items.add(new File(['x'], 'Slides.pdf')); t.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); });
await p.waitForTimeout(300); await p.screenshot({ path: join(out, 'interaction', '1-host-drag-over-table.png') });
await p.evaluate(() => { document.querySelector('[data-testid="room-table"]')!.dispatchEvent(new DragEvent('dragleave', { bubbles: true })); });
await p.locator('[data-person]').nth(1).click(); await p.waitForTimeout(700); await p.screenshot({ path: join(out, 'interaction', '2-clanmate-wheel.png') });
await p.keyboard.press('Escape');
await both(M.p, '4-open-study-group-member', 900);
await M.p.setViewportSize({ width: 1440, height: 900 });
await M.p.getByTestId('student-file-Lecture-07-scheduling.pdf').getByRole('button', { name: 'Download' }).click();
await M.p.waitForSelector('.packet', { timeout: 10000 }).catch(() => {});
await M.p.evaluate(() => { for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect).target instanceof Element && ((a.effect as KeyframeEffect).target as Element).classList.contains('packet')) { a.pause(); a.currentTime = 420; } });
await M.p.screenshot({ path: join(out, 'interaction', '3-file-in-flight.png') });
await M.p.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
await M.p.getByTestId('student-file-Lecture-07-scheduling.pdf').getByText('Downloaded').waitFor({ timeout: 60000 });
await M.p.waitForTimeout(500); await M.p.screenshot({ path: join(out, 'interaction', '4-received-verified.png') });

const perf = await p.evaluate(() => ({ heapMB: Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6) }));
console.log(JSON.stringify(perf));
for (const a of apps) await a.close().catch(() => {});

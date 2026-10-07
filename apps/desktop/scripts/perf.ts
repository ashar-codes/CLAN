// Desktop performance + accessibility mechanics for the production world UI (this Mac only; no mobile claims).
// Run after production-shots-like setup: node apps/desktop/scripts/perf.ts
import { _electron as electron, type Page } from 'playwright-core';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cwd = join(import.meta.dirname, '..');
const out = join(cwd, '../../design/production/after/modes');
const fps = (p: Page, ms = 5000) => p.evaluate((ms) => new Promise<number>((res) => { let n = 0; const s = performance.now(); const f = () => { n++; if (performance.now() - s < ms) requestAnimationFrame(f); else res(Math.round((n * 1000) / ms)); }; requestAnimationFrame(f); }), ms);
const heap = (p: Page) => p.evaluate(() => Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6));

const t0 = Date.now();
const app = await electron.launch({ args: ['.', '--js-flags=--expose-gc'], cwd, env: { ...process.env, CLASSROOM_USER_DATA: mkdtempSync(join(tmpdir(), 'clan-perf-')) } });
const p = await app.firstWindow();
await p.locator('svg.room').waitFor();
const firstSpace = Date.now() - t0;
await p.setViewportSize({ width: 1440, height: 900 });
p.on('dialog', (d) => d.accept());
// two courses so the campus has buildings
for (const c of ['Operating Systems', 'Data Structures']) {
  await p.locator('.tabs-main').getByRole('button', { name: /CLANs/ }).click();
  await p.getByRole('button', { name: 'Create CLAN' }).click(); await p.getByRole('radio', { name: 'Classroom', exact: true }).click();
  await p.getByLabel('Class name').fill(c); await p.getByRole('button', { name: 'Start Classroom' }).click(); await p.getByLabel('Join code').waitFor();
  await p.getByRole('button', { name: /^End / }).click(); await p.waitForTimeout(500);
}
await p.locator('.tabs-main').getByRole('button', { name: /My Space/ }).click(); await p.waitForTimeout(800);
const spaceFps = await fps(p), spaceHeap = await heap(p);
// keyboard: every room object focusable + labelled
const objs = await p.locator('svg.room .obj').evaluateAll((els) => els.map((e) => ({ tab: e.getAttribute('tabindex'), label: e.getAttribute('aria-label') })));
await p.locator('.tabs-main').getByRole('button', { name: /Study/ }).click();
const t1 = Date.now();
await p.waitForFunction(() => !!(window as { __clanPerf?: { sceneMs?: number } }).__clanPerf?.sceneMs, null, { timeout: 15000 });
const sceneWall = Date.now() - t1;
const sceneMs = await p.evaluate(() => (window as { __clanPerf?: { sceneMs?: number } }).__clanPerf!.sceneMs);
await p.waitForTimeout(500);
const campusFps = await fps(p), campusHeap = await heap(p);
// Reduced + Minimal render their alternatives
for (const mode of ['reduced', 'minimal'] as const) {
  await p.evaluate((m) => localStorage.setItem('clan.experience', m), mode); await p.reload(); await p.locator('.tabs-main').waitFor(); await p.waitForTimeout(600);
  await p.screenshot({ path: join(out, `${mode}-my-space.png`) }).catch(async () => { (await import('node:fs')).mkdirSync(out, { recursive: true }); await p.screenshot({ path: join(out, `${mode}-my-space.png`) }); });
  await p.locator('.tabs-main').getByRole('button', { name: /Study/ }).click(); await p.waitForTimeout(600);
  await p.screenshot({ path: join(out, `${mode}-campus.png`) });
  await p.locator('.tabs-main').getByRole('button', { name: /My Space/ }).click();
}
const minimalRoom = await p.locator('svg.room').count();
const dist = join(cwd, 'dist/renderer/assets');
const kb = (re: RegExp) => Math.round(readdirSync(dist).filter((f) => re.test(f)).reduce((a, f) => a + statSync(join(dist, f)).size, 0) / 1024);
console.log(JSON.stringify({ firstSpaceMs: firstSpace, spaceFps, spaceHeapMB: spaceHeap, sceneReadyMs: sceneMs, sceneWallMs: sceneWall, campusFps, campusHeapMB: campusHeap,
  roomObjects: objs.length, focusableLabelled: objs.filter((o) => o.tab === '0' && o.label).length, minimalShowsRoom: minimalRoom > 0,
  shellJsKB: kb(/^index-.*\.js$/), sceneChunkKB: kb(/^campus-.*\.js$/), cssKB: kb(/\.css$/) }, null, 1));
await app.close();

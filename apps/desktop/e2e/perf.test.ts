// Performance measurements in the real app (run with PERF=1; skipped otherwise — they take minutes and print numbers):
// whiteboard load / render / heap for 1k, 5k, 10k objects, and Study Tape recording at 720p and 1080p (deterministic
// canvas source, 30 fps) with CPU, memory, disk write rate and size per minute while a Study Session runs and notes are taken.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, it } from 'vitest';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const launch = async () => {
  const userData = mkdtempSync(join(tmpdir(), 'clan-perf-')); dirs.push(userData);
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData, CLAN_TEST_CAPTURE: '1' } });
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  return { app, page };
};

it.skipIf(!process.env.PERF)('PERF whiteboard render', async () => {
  const { app, page } = await launch();
  const rows: Record<string, unknown>[] = [];
  for (const n of [1000, 5000, 10_000]) {
    const id = await page.evaluate(async (n) => {
      const b = await window.classroom.board.create({ kind: 'personal', id: 'me' }, `Perf ${n}`);
      for (let i = 0; i < n; i += 200) await window.classroom.board.edit(b.id, Array.from({ length: Math.min(200, n - i) }, (_, k) => {
        const j = i + k;
        return { t: 'put' as const, id: crypto.randomUUID(), obj: crypto.randomUUID(), clock: j + 1, data: { kind: 'stroke' as const, page: 0, x: (j % 100) * 30, y: Math.floor(j / 100) * 30, w: 0, h: 0, points: Array.from({ length: 24 }, (_, q) => [q * 2, Math.sin(q) * 6] as [number, number]), color: '#17233b', width: 3, z: j } };
      }));
      return b.id;
    }, n);
    await page.getByRole('button', { name: 'Study', exact: true }).click();
    await page.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name: 'Notes', exact: true }).click(); // remount the list
    await page.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name: 'Boards', exact: true }).click();
    const t0 = Date.now();
    await page.getByTestId('board-card').filter({ hasText: `Perf ${n}` }).click();
    await page.waitForFunction((n) => /: (\d+) objects/.exec(document.querySelector('[data-testid=board-canvas]')?.getAttribute('aria-label') ?? '')?.[1] === String(n), n, { timeout: 120_000 });
    const loadMs = Date.now() - t0;
    const canvas = page.getByTestId('board-canvas'); const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const samples: number[] = [];
    for (let k = 0; k < 20; k++) { await page.mouse.wheel(0, k % 2 ? 120 : -120); await page.waitForTimeout(30); samples.push(await page.evaluate(() => (window as unknown as { __clanBoardPerf: { renderMs: number } }).__clanBoardPerf.renderMs)); }
    const zoomOut = async () => { for (let k = 0; k < 18; k++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(10); } };
    await zoomOut(); // whole board in view = worst case (no culling)
    const full: number[] = [];
    for (let k = 0; k < 10; k++) { await page.mouse.move(box.x + 100 + k, box.y + 100); await page.mouse.down(); await page.mouse.move(box.x + 140 + k, box.y + 120); await page.mouse.up(); full.push(await page.evaluate(() => (window as unknown as { __clanBoardPerf: { renderMs: number } }).__clanBoardPerf.renderMs)); }
    const heap = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
    const med = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)]!;
    rows.push({ objects: n, loadMs, renderMsInView: +med(samples).toFixed(1), fpsInView: Math.min(60, Math.round(1000 / Math.max(1, med(samples)))), renderMsWholeBoard: +med(full).toFixed(1), fpsWholeBoard: Math.min(60, Math.round(1000 / Math.max(1, med(full)))), rendererHeapMB: Math.round(heap / 1e6), id });
    await page.getByRole('button', { name: '← Boards' }).click();
  }
  console.table(rows);
  await app.close();
}, 600_000);

it.skipIf(!process.env.PERF)('PERF Study Tape recording 720p / 1080p', async () => {
  const rows: Record<string, unknown>[] = [];
  for (const [w, h] of [[1280, 720], [1920, 1080]] as const) {
    const { app, page } = await launch();
    await page.evaluate(([w, h]) => { (window as unknown as { __clanRecSize: object }).__clanRecSize = { w, h }; }, [w, h]);
    await page.getByRole('button', { name: 'Start studying' }).click();
    await page.getByTestId('session-bar').getByRole('button', { name: 'Record' }).click();
    const dlg = page.getByRole('dialog', { name: 'Record a Study Tape' });
    await dlg.getByRole('option', { name: /Test pattern/ }).click();
    await dlg.getByRole('button', { name: 'Start recording' }).click();
    await page.getByTestId('rec-indicator').waitFor();
    const cpu: number[] = [], mem: number[] = [];
    await app.evaluate(({ app }) => app.getAppMetrics()); // prime CPU counters
    for (let s = 0; s < 12; s++) {
      await page.waitForTimeout(5000);
      if (s % 3 === 0) { await page.getByTestId('rec-indicator').getByRole('button', { name: 'Add note' }).click(); await page.getByLabel('Timeline note').fill(`note ${s}`); await page.getByTestId('rec-indicator').getByRole('button', { name: 'Add', exact: true }).click(); }
      const m = await app.evaluate(({ app }) => app.getAppMetrics().map((x) => ({ cpu: x.cpu.percentCPUUsage, mem: x.memory.workingSetSize })));
      cpu.push(m.reduce((a, b) => a + b.cpu, 0)); mem.push(m.reduce((a, b) => a + b.mem, 0) / 1024);
    }
    await page.getByTestId('rec-indicator').getByRole('button', { name: 'Stop' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid=rec-indicator]'));
    await page.waitForFunction(async () => (await window.classroom.rec.list())[0]?.status === 'ready', undefined, { timeout: 60_000, polling: 250 }); // finalizing (move into the store) completes after the indicator goes
    const t = await page.evaluate(async () => (await window.classroom.rec.list())[0]!);
    const minutes = (t.durationMs ?? 1) / 60000;
    rows.push({ resolution: `${w}×${h}`, seconds: Math.round((t.durationMs ?? 0) / 1000), cpuPercentAvg: Math.round(cpu.reduce((a, b) => a + b, 0) / cpu.length), memoryMBStart: Math.round(mem[0]!), memoryMBEnd: Math.round(mem.at(-1)!), fileMB: +(t.bytes / 1e6).toFixed(1), MBperMinute: +(t.bytes / 1e6 / minutes).toFixed(1), writeKBps: Math.round(t.bytes / 1024 / ((t.durationMs ?? 1) / 1000)) });
    await app.close();
  }
  console.table(rows);
}, 600_000);

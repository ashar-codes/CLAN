// Desktop startup, N fresh-profile then N existing-profile launches of the built app (run `pnpm build` first):
// launch → first window → DOM ready → navigation ready (.tabs-main), plus when the lazy 3D campus is up (Study, Full mode).
// Usage: node scripts/startup-bench.ts [n=5]
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const n = Number(process.argv[2] ?? 5), profile = mkdtempSync(join(tmpdir(), 'clan-startup-')), runs = [];
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
for (let i = 0; i < 2 * n; i++) {
  const fresh = i < n, dir = fresh ? mkdtempSync(join(tmpdir(), 'clan-startup-fresh-')) : profile;
  const t0 = performance.now(), at = () => Math.round(performance.now() - t0);
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: dir } });
  const p = await app.firstWindow(); const windowMs = at();
  await p.waitForLoadState('domcontentloaded'); const domMs = at();
  await p.locator('.tabs-main').waitFor(); const readyMs = at();
  await p.evaluate(async (create) => { localStorage.setItem('clan.experience', 'full'); if (create) await (window as unknown as { classroom: { study: { createCourse(o: object): Promise<unknown> } } }).classroom.study.createCourse({ name: 'Physics' }); }, fresh || i === n); // the campus shows courses
  await p.reload(); await p.locator('.tabs-main').waitFor(); // the experience mode applies on load
  await p.waitForTimeout(Number(process.env.IDLE_MS ?? 0)); // IDLE_MS: a user who opens Study after the app settled
  const t3 = performance.now();
  await p.locator('.tabs-main').getByRole('button', { name: 'Study' }).click(); await p.locator('canvas').first().waitFor({ timeout: 30_000 });
  const campusMs = Math.round(performance.now() - t3);
  await app.close(); if (fresh) rmSync(dir, { recursive: true, force: true });
  runs.push({ fresh, windowMs, domMs, readyMs, campusMs }); console.log(JSON.stringify(runs.at(-1)));
}
for (const fresh of [true, false]) {
  const r = runs.filter((x) => x.fresh === fresh);
  console.log(`${fresh ? 'fresh' : 'existing'} median: window ${median(r.map((x) => x.windowMs))} · dom ${median(r.map((x) => x.domMs))} · ready ${median(r.map((x) => x.readyMs))} · campus ${median(r.map((x) => x.campusMs))} ms`);
}
rmSync(profile, { recursive: true, force: true });

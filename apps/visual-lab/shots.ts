// Screenshots (desktop 1440×900, mobile 390×844), the Commons → person → Send capture, and performance numbers.
// Usage: pnpm build:lab && node apps/visual-lab/shots.ts [--perf]   (uses the installed Google Chrome)
import { chromium, type Page } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const dist = join(import.meta.dirname, 'dist');
const out = join(import.meta.dirname, '../../design/screenshots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
  const p = join(dist, path === '/' ? 'index.html' : path);
  if (!p.startsWith(dist)) { res.writeHead(403).end(); return; }
  let body: Buffer;
  try { body = readFileSync(p); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' }).end(body);
}).listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const SCREENS = ['home', 'commons', 'mate/p1', 'study', 'campus', 'saved', 'diary', 'exam'];
const settle = async (page: Page, route: string, threeD = true) => {
  if (threeD && (route === 'commons' || route === 'campus')) await page.waitForFunction((r) => !!window.__clanPerf?.sceneMs?.[r], route, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(900);
};

const perf = process.argv.includes('--perf');
const browser = await chromium.launch({ executablePath: CHROME, headless: !perf, args: ['--enable-precise-memory-info', '--ignore-gpu-blocklist'] });

if (!perf) {
  for (const [dir, viewport, scale] of [['desktop', { width: 1440, height: 900 }, 1], ['mobile', { width: 390, height: 844 }, 2]] as const) {
    mkdirSync(join(out, dir), { recursive: true });
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, hasTouch: dir === 'mobile', reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    for (const [i, r] of SCREENS.entries()) {
      await page.goto(`${base}#/${r}`); await settle(page, r);
      await page.screenshot({ path: join(out, dir, `${i + 1}-${r.split('/')[0]}.png`) });
    }
    await ctx.close();
  }

  // Interaction: Commons → Hana → Send → pick a file → flight + transfer Beacon. Frames + a video.
  const idir = join(out, 'interaction'); mkdirSync(idir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: idir, size: { width: 1440, height: 900 } } });
  const page = await ctx.newPage();
  await page.goto(`${base}#/commons`); await settle(page, 'commons');
  await page.screenshot({ path: join(idir, '1-commons.png') });
  await page.getByRole('button', { name: /Hana/ }).first().click(); await page.waitForTimeout(700);
  await page.screenshot({ path: join(idir, '2-person-wheel.png') });
  await page.getByRole('menuitem', { name: 'Send' }).click(); await page.waitForTimeout(300);
  await page.screenshot({ path: join(idir, '3-pick-file.png') });
  await page.getByText('Graphs — lecture 6.pdf').click();
  // Screenshots are slower than the 900 ms flight, so pause the Web Animation and seek to exact times.
  const seek = (t: number | null) => page.evaluate((t) => { for (const a of document.getAnimations()) if ((a.effect as KeyframeEffect).target?.classList.contains('fly-chip')) { if (t === null) a.play(); else { a.pause(); a.currentTime = t; } } }, t);
  for (const [n, t] of [[4, 150], [5, 450], [6, 750]] as const) { await seek(t); await page.screenshot({ path: join(idir, `${n}-flight-${t}ms.png`) }); }
  await seek(null); await page.waitForTimeout(400); await page.screenshot({ path: join(idir, '7-receiving-transfer-beacon.png') });
  await page.waitForTimeout(1500); await page.screenshot({ path: join(idir, '7b-sent-verified.png') });
  // A few other interactions on the same session.
  await page.getByRole('button', { name: 'Quick Capture' }).click(); await page.waitForTimeout(400); await page.screenshot({ path: join(idir, '8-quick-capture.png') });
  await page.getByRole('menuitem', { name: /Link/ }).click(); await page.getByPlaceholder('https://…').fill('https://example.com/graph-algorithms'); await page.keyboard.press('Enter');
  await page.waitForTimeout(300); await page.screenshot({ path: join(idir, '9-captured-to-inbox.png') });
  await page.getByRole('button', { name: 'Focus', exact: true }).click(); await page.waitForTimeout(700); await page.screenshot({ path: join(idir, '10-focus-mode.png') });
  await page.getByRole('button', { name: 'End focus' }).first().click();
  await page.goto(`${base}#/campus`); await settle(page, 'campus');
  await page.getByRole('button', { name: /CS-201/ }).last().click(); await page.waitForTimeout(1600); await page.screenshot({ path: join(idir, '11-campus-enter-building.png') });
  await page.goto(`${base}#/home`); await page.waitForTimeout(500);
  await page.locator('.guide-orb').click(); await page.waitForTimeout(400); await page.screenshot({ path: join(idir, '12-guide.png') });
  await page.goto(`${base}#/exam`); await page.waitForTimeout(250); await page.screenshot({ path: join(idir, '13-exam-transition.png') });
  const video = page.video(); await ctx.close();
  if (video) renameSync(await video.path(), join(idir, 'commons-send.webm'));
  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const dp = await dark.newPage(); await dp.goto(`${base}?theme=dark#/home`); await dp.waitForTimeout(800); await dp.screenshot({ path: join(idir, '14-home-dark.png') });
  await dark.close();
} else {
  // Headed Chrome so WebGL uses the real GPU. FPS = rAF over 5 s; heap = performance.memory after settling.
  const rows: string[] = [];
  for (const threeD of [true, false]) for (const r of ['home', 'commons', 'campus', 'study']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const t = Date.now();
    await page.goto(`${base}?perf=1${threeD ? '' : '&3d=0'}#/${r}`); await settle(page, r, threeD);
    const m = await page.evaluate(() => new Promise<{ fps: number; heap: number; scene?: number }>((done) => {
      let n = 0; const s = performance.now();
      const f = () => { n++; if (performance.now() - s < 5000) requestAnimationFrame(f); else done({ fps: Math.round(n / 5), heap: Math.round(((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize) / 1e6), scene: Object.values(window.__clanPerf?.sceneMs ?? {})[0] }); };
      requestAnimationFrame(f);
    }));
    rows.push(`| ${r} | ${threeD ? '3D' : '2D'} | ${m.scene ?? '—'} | ${m.fps} | ${m.heap} | ${Date.now() - t - 5000} |`);
    await ctx.close();
  }
  const size = (re: RegExp) => readdirSync(join(dist, 'assets')).filter((f) => re.test(f)).reduce((a, f) => a + statSync(join(dist, 'assets', f)).size, 0);
  const report = ['| screen | mode | scene ms (import→first frame) | fps (5 s) | JS heap MB | total settle ms |', '|---|---|---|---|---|---|', ...rows, '',
    `Bundle: main JS ${(size(/^index-.*\.js$/) / 1e3).toFixed(0)} kB, 3D chunks ${(size(/^(mate3d|commons|campus)-.*\.js$/) / 1e3).toFixed(0)} kB, CSS ${(size(/\.css$/) / 1e3).toFixed(0)} kB, fonts ${(size(/\.woff2$/) / 1e3).toFixed(0)} kB (minified, before gzip). fps is capped by the display refresh rate.`];
  writeFileSync(join(import.meta.dirname, 'perf.md'), report.join('\n') + '\n');
  console.log(report.join('\n'));
}
await browser.close(); server.close();

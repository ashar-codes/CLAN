// Packaged-app REAL screen sharing: two packaged CLAN instances (disposable profiles), real OS capture of a real
// window and then a real screen (no test pattern — packaged builds cannot use it), frames verified on the viewer.
// Node 24: node apps/desktop/e2e/packaged-screen.mjs '/path/CLAN QA.app/Contents/MacOS/CLAN QA'
// The content source is a separate helper window (development Electron) drawing green, changing frames.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const binary = process.argv[2]; assert(binary, 'A real packaged executable is required');
const children = [], browsers = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = openSync(join(tmpdir(), 'clan-packaged-screen.log'), 'a');
async function port() { const s = createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function launch() {
  const p = await port(), dir = mkdtempSync(join(tmpdir(), 'clan-screen-'));
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ fullName: 'QA Tester', rollNo: '', deviceName: 'QA device' })); // onboarding result
  const env = { ...process.env, CLASSROOM_USER_DATA: dir }; delete env.CLAN_TEST_CAPTURE;
  const child = spawn(binary, [`--remote-debugging-port=${p}`, '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', log, log] }); children.push(child);
  let b; for (let i = 0; i < 90 && !b; i++) { assert.equal(child.exitCode, null, 'App exited before startup'); try { b = await chromium.connectOverCDP(`http://127.0.0.1:${p}`, { timeout: 1500 }); } catch { await delay(500); } }
  assert(b, 'Packaged CDP unavailable'); browsers.push(b);
  const ctx = b.contexts()[0]; const page = ctx.pages()[0] ?? await ctx.waitForEvent('page', { timeout: 90000 });
  await page.waitForLoadState('domcontentloaded'); page.on('dialog', (d) => d.accept());
  return page;
}
function frames() {
  const dir = mkdtempSync(join(tmpdir(), 'clan-frames-'));
  writeFileSync(join(dir, 'index.html'), `<title>CLAN Frames Test</title><body style="margin:0;background:#0a8f3c"><canvas id=c width=640 height=360></canvas><script>
const g=c.getContext('2d');let i=0;setInterval(()=>{g.fillStyle='#0a8f3c';g.fillRect(0,0,640,360);g.fillStyle='#fff';g.fillRect((i*23)%600,(i*11)%320,40,40);g.font='48px sans-serif';g.fillText(String(i++),20,340)},50)</script>`);
  writeFileSync(join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:640,height:400,x:40,y:40,title:'CLAN Frames Test',webPreferences:{backgroundThrottling:false}});w.loadFile(__dirname+'/index.html');});`);
  const electron = createRequire(join(import.meta.dirname, '..', 'package.json'))('electron');
  children.push(spawn(electron, [join(dir, 'main.cjs')], { stdio: ['ignore', log, log] }));
}
const sample = (p) => p.evaluate(async () => {
  const v = document.querySelector('[data-testid="screen-video"]');
  if (!v || !v.videoWidth) return { distinct: 0, r: 0, g: 0, b: 0, w: 0, h: 0 };
  const c = Object.assign(document.createElement('canvas'), { width: 96, height: 54 }); const x = c.getContext('2d');
  const seen = new Set(); let r = 0, g = 0, b = 0;
  for (let i = 0; i < 7; i++) { x.drawImage(v, 0, 0, 96, 54); const d = x.getImageData(0, 0, 96, 54).data; let h = 0; for (let k = 0; k < d.length; k += 37) h = (h * 31 + d[k]) >>> 0; seen.add(h); [r, g, b] = [d[4 * 96 * 10 + 8], d[4 * 96 * 10 + 9], d[4 * 96 * 10 + 10]]; await new Promise((z) => setTimeout(z, 300)); }
  return { distinct: seen.size, r, g, b, w: v.videoWidth, h: v.videoHeight };
});
async function poll(f, ok, ms, what) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await f(); if (ok(last)) return last; await delay(500); } throw new Error(`${what}: ${JSON.stringify(last)}`); }

try {
  frames();
  const host = await launch();
  await host.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await host.getByRole('button', { name: 'Create CLAN' }).click();
  await host.getByRole('radio', { name: 'Study group', exact: true }).click();
  await host.getByLabel('Name', { exact: true }).fill('Packaged Capture');
  await host.getByRole('button', { name: 'Start CLAN' }).click();
  const code = (await host.getByLabel('Join code').textContent()).replace(/\D/g, '');
  const sara = await launch();
  await sara.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await sara.getByRole('button', { name: 'Join by Code' }).click();
  await sara.getByLabel('Full name').fill('Sara'); await sara.getByLabel('Student / roll number').fill('R-1'); await sara.getByLabel('Device name').fill('Sara-PC');
  await sara.getByRole('button', { name: 'Save' }).click();
  await sara.locator('.code-input').fill(code); await sara.getByRole('button', { name: 'Join', exact: true }).click();
  await host.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 30_000 });
  await sara.getByTestId('secure-state').waitFor({ timeout: 20_000 });
  const diag0 = await sara.evaluate(() => window.classroom.mediaDiagnostics());
  assert.equal(diag0.packaged, true, 'not a packaged build');

  await sara.getByRole('button', { name: 'Present', exact: true }).click();
  assert.equal(await sara.getByRole('option', { name: /Test pattern/ }).count(), 0);
  await sara.getByRole('option', { name: 'CLAN Frames Test' }).click({ timeout: 30_000 });
  await sara.getByRole('button', { name: 'Share this window' }).click();
  try { await sara.getByTestId('presenter-bar').waitFor({ timeout: 20_000 }); }
  catch (e) { const f = await sara.getByTestId('capture-failure').textContent().catch(() => null); throw new Error(`Presenting failed: ${f ?? e.message} ${JSON.stringify(await sara.evaluate(() => window.classroom.mediaDiagnostics()))}`); }
  const diag = await sara.evaluate(() => window.classroom.mediaDiagnostics());
  assert(diag.picked && diag.permissionGranted && diag.handlerRan && diag.sourceFound, `capture stages: ${JSON.stringify(diag)}`);
  await host.getByTestId('screen-video').waitFor({ timeout: 25_000 });
  await host.bringToFront();
  const win = await poll(() => sample(host), (s) => s.distinct >= 4 && s.g > s.r + 40 && s.g > s.b + 40, 30_000, 'window frames');
  console.log(`window: ${win.w}x${win.h}, ${win.distinct}/7 distinct frames, rgb ${win.r},${win.g},${win.b}`);

  await host.getByTestId('screen-wall').dblclick();
  await host.getByTestId('presentation-tools').click();
  await host.getByRole('menuitem', { name: 'Take Notes' }).click();
  await host.getByTestId('presentation-notes').getByLabel('Note', { exact: true }).fill('Packaged note');
  await host.getByTestId('presentation-notes').getByRole('button', { name: 'Save' }).click();
  await host.getByTestId('presentation-notes').getByText('Saved', { exact: true }).waitFor();
  const during = await sample(host);
  assert(during.distinct >= 4, 'stream paused while taking notes');
  assert((await host.evaluate(() => window.classroom.clan.notes())).some((n) => n.body.startsWith('Packaged note')), 'note not saved');
  console.log(`fullscreen + notes: saved, stream still ${during.distinct}/7 distinct`);

  await sara.getByRole('button', { name: 'Switch source' }).click();
  await sara.getByRole('listbox', { name: 'Screens' }).getByRole('option').first().click({ timeout: 30_000 });
  await sara.getByRole('button', { name: 'Share this screen' }).click();
  await poll(() => host.getByTestId('wall-state').textContent(), (t) => t === 'Sara is presenting their screen', 20_000, 'switch');
  const scr = await poll(() => sample(host), (s) => s.distinct >= 3, 20_000, 'screen frames');
  console.log(`screen: ${scr.w}x${scr.h}, ${scr.distinct}/7 distinct frames`);

  await sara.getByTestId('presenter-bar').getByRole('button', { name: 'Stop' }).click();
  await host.locator('.wall-code').waitFor({ timeout: 15_000 });
  assert.equal(await sara.getByTestId('presenter-bar').count(), 0);
  console.log('PASS packaged real capture: window + screen captured, received live by a second instance, fullscreen notes saved, stop ended capture');
} finally {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  await delay(1500); for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
}

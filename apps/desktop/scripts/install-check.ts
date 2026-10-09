// Packaged-app install → update → rollback → uninstall on a disposable profile (macOS, unpacked builds).
// The release app has its Node fuses off, so it is driven over Chromium's DevTools port instead of Playwright's
// Electron launcher. Usage: node scripts/install-check.ts <old CLAN.app> <new CLAN.app>
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [oldApp, newApp] = process.argv.slice(2);
if (!oldApp || !newApp) throw new Error('usage: install-check.ts <old CLAN.app> <new CLAN.app>');
const root = mkdtempSync(join(tmpdir(), 'clan-install-')), installed = join(root, 'Applications', 'CLAN.app'), profile = join(root, 'profile');
const install = (from: string) => { rmSync(installed, { recursive: true, force: true }); execFileSync('ditto', [from, installed]); };
type Api = { classroom: { clan: { createNote(o: object): Promise<unknown>; notes(): Promise<{ title: string }[]> }; feedback: { preview(): Promise<{ app: { version: string; packaged: boolean } }> } } };

async function run<T>(f: (api: (fn: (w: Api) => unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
  const p = spawn(join(installed, 'Contents/MacOS/CLAN'), ['--remote-debugging-port=9339'], { env: { ...process.env, CLASSROOM_USER_DATA: profile }, stdio: 'ignore' });
  try {
    let browser;
    for (let i = 0; !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9339'); } catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 500)); } }
    let page = browser.contexts()[0]?.pages()[0];
    for (let i = 0; !page && i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); page = browser.contexts()[0]?.pages()[0]; }
    await page!.waitForFunction(() => 'classroom' in window);
    return await f((fn) => page!.evaluate(fn as never));
  } finally { p.kill(); await new Promise((r) => p.once('exit', r)); }
}
const state = (api: (fn: (w: Api) => unknown) => Promise<unknown>) => Promise.all([
  api(() => (window as unknown as Api).classroom.feedback.preview().then((d) => d.app)),
  api(() => (window as unknown as Api).classroom.clan.notes().then((n) => n.map((x) => x.title))),
]) as Promise<[{ version: string; packaged: boolean }, string[]]>;

install(oldApp);
const [v1] = await run(async (api) => { await api(() => (window as unknown as Api).classroom.clan.createNote({ title: 'Made before the update' })); return state(api); });
assert.equal(v1.packaged, true); console.log(`✓ installed ${v1.version}, note written`);

install(newApp);
const [v2, n2] = await run(state);
assert.notEqual(v2.version, v1.version); assert.deepEqual(n2, ['Made before the update']);
console.log(`✓ updated in place to ${v2.version}: data kept`);

install(oldApp);
const [v3, n3] = await run(state);
assert.equal(v3.version, v1.version); assert.deepEqual(n3, ['Made before the update']);
console.log(`✓ rolled back to ${v3.version}: data kept (same schema; a rollback across a migration is not supported)`);

rmSync(installed, { recursive: true, force: true });
assert.ok(existsSync(join(profile, 'teacher.db')));
console.log(`✓ uninstalled (app removed): profile kept — ${readdirSync(profile).filter((n) => !n.startsWith('.')).length} entries`);
rmSync(root, { recursive: true, force: true });

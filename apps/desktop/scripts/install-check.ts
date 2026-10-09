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
/** Identity keys must survive an update: a key safeStorage can't decrypt is renamed `*.unreadable-*` and regenerated. */
const keys = () => { const d = join(profile, 'keys'); return existsSync(d) ? readdirSync(d).sort() : []; };
const assertKeysKept = (before: string[], step: string) => {
  const now = keys(), lost = now.filter((n) => n.includes('.unreadable-'));
  assert.deepEqual(lost, [], `${step}: identity keys could not be decrypted and were regenerated: ${lost.join(', ')}`);
  assert.deepEqual(now, before, `${step}: key files changed`);
};
const install = (from: string) => { rmSync(installed, { recursive: true, force: true }); execFileSync('ditto', [from, installed]); };
type Api = { classroom: { clan: { createNote(o: object): Promise<unknown>; notes(): Promise<{ title: string }[]> }; feedback: { preview(): Promise<{ app: { version: string; packaged: boolean } }> } } };

async function run<T>(f: (api: (fn: (w: Api) => unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
  const p = spawn(join(installed, 'Contents/MacOS', execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', join(installed, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()), ['--remote-debugging-port=9339'], { env: { ...process.env, CLASSROOM_USER_DATA: profile }, stdio: 'ignore' });
  const t0 = Date.now(), step = (m: string) => { if (process.env.DEBUG_INSTALL_CHECK) console.error(`  [${Date.now() - t0} ms] ${m}`); };
  try {
    let browser;
    for (let i = 0; !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9339'); } catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 500)); } }
    step('devtools connected');
    let page = browser.contexts()[0]?.pages()[0];
    for (let i = 0; !page && i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); page = browser.contexts()[0]?.pages()[0]; }
    step(`page ${page?.url()}`);
    await page!.waitForFunction(() => 'classroom' in window);
    step('api ready');
    return await f((fn) => page!.evaluate(fn as never));
  } finally { p.kill(); await new Promise((r) => p.once('exit', r)); }
}
const state = (api: (fn: (w: Api) => unknown) => Promise<unknown>) => Promise.all([
  api(() => (window as unknown as Api).classroom.feedback.preview().then((d) => d.app)),
  api(() => (window as unknown as Api).classroom.clan.notes().then((n) => n.map((x) => x.title))),
]) as Promise<[{ version: string; packaged: boolean }, string[]]>;

install(oldApp);
const [v1] = await run(async (api) => { await api(() => (window as unknown as Api).classroom.clan.createNote({ title: 'Made before the update' })); return state(api); });
assert.equal(v1.packaged, true); const k1 = keys(); assert.ok(k1.length > 0, 'no identity keys written');
console.log(`✓ installed ${v1.version}, note written, ${k1.length} identity keys (safeStorage)`);

install(newApp);
const [v2, n2] = await run(state);
assert.notEqual(v2.version, v1.version); assert.deepEqual(n2, ['Made before the update']); assertKeysKept(k1, 'update');
console.log(`✓ updated in place to ${v2.version}: data and identity keys kept`);

install(oldApp);
const [v3, n3] = await run(state);
assert.equal(v3.version, v1.version); assert.deepEqual(n3, ['Made before the update']); assertKeysKept(k1, 'rollback');
console.log(`✓ rolled back to ${v3.version}: data kept (same schema; a rollback across a migration is not supported)`);

rmSync(installed, { recursive: true, force: true });
assert.ok(existsSync(join(profile, 'teacher.db')));
console.log(`✓ uninstalled (app removed): profile kept — ${readdirSync(profile).filter((n) => !n.startsWith('.')).length} entries`);
rmSync(root, { recursive: true, force: true });

import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { afterAll, expect, it } from 'vitest';
const profile = mkdtempSync(join(tmpdir(), 'clan-btc2r-background-'));
let app: ElectronApplication | null = null;
afterAll(async () => { await app?.close().catch(() => {}); rmSync(profile, { recursive: true, force: true }); });
const listening = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({ host: '127.0.0.1', port });
  const done = (value: boolean) => { socket.destroy(); resolve(value); };
  socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(1000, () => done(false));
});
it('opt-in window close keeps the real People listener, while explicit Quit closes it', async () => {
  writeFileSync(join(profile, 'background-availability.json'), JSON.stringify({ enabled: true }));
  app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: profile, CLAN_TEST_LOOPBACK: '1' } });
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  const port = await page.evaluate(async () => {
    const api = (window as any).classroom;
    await api.saveProfile({ fullName: 'Background QA', rollNo: 'QA', deviceName: 'Disposable' });
    return (await api.people.me()).port as number;
  });
  expect(await listening(port)).toBe(true);
  const state = await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.close(); return { visible: win.isVisible(), destroyed: win.isDestroyed() }; });
  expect(state).toEqual({ visible: false, destroyed: false });
  expect(await listening(port)).toBe(true);
  const closed = app.waitForEvent('close'); await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }); await closed; app = null;
  await expect.poll(() => listening(port), { timeout: 5000 }).toBe(false);
});

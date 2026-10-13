// Your data + beta feedback + crash recovery in the real app: export → import into another app (Diary only when ticked),
// feedback saved locally with/without diagnostics (no private text), and a damaged database after a crash is restored
// from the automatic backup on the next launch.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
// Windows crash termination can precede OS/AV handle release. Wait for that actual precondition;
// corruption/recovery assertions remain unchanged and every non-lock error still fails immediately.
async function removeReleased(path: string, recursive = false) {
  const deadline = Date.now() + 5000;
  for (;;) { try { rmSync(path, { recursive, force: true }); return; } catch (e) {
    if (!['EPERM', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw e;
    await new Promise(resolve => setTimeout(resolve, 50));
  } }
}
const tmp = (p = 'clan-data-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) await removeReleased(d, true); });

async function launch(userData = tmp(), recovery = false) {
  const args = recovery ? ['-r', join(import.meta.dirname, 'fixtures/accept-recovery-dialog.cjs'), '.'] : ['.'];
  const app = await electron.launch({ args, cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData } });
  apps.push(app);
  try {
    const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
    return { app, page, userData };
  } catch (error) {
    const diagnostic = await Promise.race([
      app.evaluate(({ app, BrowserWindow }) => ({ ready: app.isReady(), ownsLock: app.hasSingleInstanceLock(), windows: BrowserWindow.getAllWindows().length, warningPresented: !!(globalThis as { __qaRecoveryWarning?: boolean }).__qaRecoveryWarning })).catch(() => ({ evaluationFailed: true })),
      new Promise(resolve => setTimeout(() => resolve({ mainUnresponsive: true }), 3000)),
    ]);
    console.error('Disposable recovery launch diagnostic', { recovery, exited: app.process().exitCode !== null, diagnostic });
    throw error;
  }
}
const pickDir = (app: ElectronApplication, dir: string) => app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as never; }, dir);
const saveTo = (app: ElectronApplication, path: string) => app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as never; }, path);
const me = (p: Page) => p.getByRole('button', { name: 'Me', exact: true }).click();
const addNote = async (p: Page, title: string, body: string) => {
  await p.getByRole('button', { name: 'Study', exact: true }).click(); await p.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name: 'Notes', exact: true }).click();
  await p.getByRole('button', { name: 'New note' }).click(); await p.getByLabel('Title', { exact: true }).fill(title); await p.getByLabel('Note', { exact: true }).fill(body);
  await p.getByRole('button', { name: 'Save', exact: true }).click();
};

it('export → import, local feedback without private text, and recovery from a damaged database', async () => {
  const a = await launch();
  await addNote(a.page, 'Exported note', 'PRIVATE-NOTE-BODY');
  await a.page.evaluate(() => (window as unknown as { classroom: { clan: { writeDiary(o: unknown): Promise<unknown> } } }).classroom.clan.writeDiary({ day: '2026-10-01', body: 'PRIVATE-DIARY' }));

  // export without Diary, then with
  const out = tmp('clan-export-');
  await me(a.page); await pickDir(a.app, out);
  await a.page.getByRole('button', { name: 'Export my data…' }).click();
  await a.page.getByRole('status').filter({ hasText: /^Exported/ }).waitFor();
  const folder = join(out, readdirSync(out).find((n) => n.startsWith('CLAN export'))!), exp = readFileSync(join(folder, 'clan-export.json'), 'utf8');
  expect(exp).toContain('PRIVATE-NOTE-BODY'); expect(exp).not.toContain('PRIVATE-DIARY');

  // feedback: diagnostics only when ticked, and never private text
  const fb1 = join(tmp('clan-fb-'), 'a.json'), fb2 = join(tmp('clan-fb-'), 'b.json');
  await a.page.getByLabel('Your feedback').fill('The board felt slow'); await saveTo(a.app, fb1);
  await a.page.getByRole('button', { name: 'Save feedback…' }).click(); await a.page.getByRole('status').filter({ hasText: /^Saved to/ }).waitFor();
  expect(JSON.parse(readFileSync(fb1, 'utf8'))).not.toHaveProperty('diagnostics');
  await a.page.getByLabel('Your feedback').fill('Again, with diagnostics'); await a.page.getByRole('checkbox', { name: /Attach diagnostics/ }).check();
  await a.page.getByRole('button', { name: "Show exactly what's attached" }).click(); await a.page.getByLabel('Diagnostics preview').waitFor();
  await saveTo(a.app, fb2); await a.page.getByRole('button', { name: 'Save feedback…' }).click(); await a.page.getByRole('status').filter({ hasText: /^Saved to/ }).waitFor();
  const fb = readFileSync(fb2, 'utf8');
  expect(JSON.parse(fb).diagnostics.counts.note).toBe(1);
  for (const secret of ['PRIVATE-NOTE-BODY', 'PRIVATE-DIARY', 'Exported note']) expect(fb).not.toContain(secret);

  // import into a fresh app
  const b = await launch();
  await me(b.page); await pickDir(b.app, folder);
  await b.page.getByRole('button', { name: 'Import an export…' }).click();
  await b.page.getByRole('status').filter({ hasText: /^Imported/ }).waitFor();
  await b.page.getByRole('button', { name: 'Study', exact: true }).click(); await b.page.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name: 'Notes', exact: true }).click();
  await b.page.getByRole('button', { name: /^Exported note/ }).waitFor();

  // crash with a damaged database → next launch restores the automatic backup
  const backups = join(a.userData, 'backups');
  await me(a.page); await a.page.getByRole('button', { name: 'Back up now' }).click(); await a.page.getByRole('status').filter({ hasText: 'Backed up.' }).waitFor();
  expect(existsSync(backups) && readdirSync(backups).length).toBeGreaterThan(0);
  // Wait for the killed instance to release Electron's single-instance lock before relaunching.
  const killed = a.app.process();
  await new Promise<void>((resolve, reject) => {
    killed.once('exit', () => resolve());
    try {
      // Windows does not propagate main-process termination to Electron's child tree.
      // Crash the entire disposable instance before manipulating its database files.
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(killed.pid), '/T', '/F'], { windowsHide: true });
      else killed.kill('SIGKILL');
    } catch (error) { reject(error); }
  });
  apps.splice(apps.indexOf(a.app), 1); // Playwright cannot close a process already killed by this crash test.
  const dbPath = join(a.userData, 'teacher.db');
  for (const ext of ['-wal', '-shm']) await removeReleased(dbPath + ext);
  const fd = openSync(dbPath, 'r+'), size = statSync(dbPath).size;
  for (let off = 0; off < size; off += 4096) writeSync(fd, Buffer.alloc(512, 0xa5), 0, 512, off);
  closeSync(fd);
  const a2 = await launch(a.userData, true);
  await a2.page.getByRole('button', { name: 'Study', exact: true }).click(); await a2.page.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name: 'Notes', exact: true }).click();
  await a2.page.getByRole('button', { name: /^Exported note/ }).waitFor({ timeout: 20_000 });
  expect(readdirSync(a.userData).some((n) => n.startsWith('teacher.db.corrupt-'))).toBe(true); // kept, not deleted
  await expect.poll(() => a2.app.evaluate(() => (globalThis as { __qaRecoveryWarning?: boolean }).__qaRecoveryWarning)).toBe(true);
});

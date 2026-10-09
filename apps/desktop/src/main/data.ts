// Me › Your data (main process): export your personal data to a folder you choose (JSON in the sync record format +
// your own files by SHA-256; Diary only when ticked), import such an export, and open the automatic backups folder.
// Nothing leaves the device except to the folder the student picks.
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ClanApp } from '@clan/core';

export function registerData(c: ClanApp, backupsDir: string, backupNow: () => string | null) {
  const pickDir = async (title: string) => {
    const w = BrowserWindow.getFocusedWindow() ?? undefined, o = { title, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o);
    return r.canceled ? null : r.filePaths[0]!;
  };
  ipcMain.handle('data:export', async (_e, raw) => {
    const { diary } = z.object({ diary: z.boolean() }).parse(raw);
    const parent = await pickDir('Export your CLAN data'); if (!parent) return null;
    const dir = join(parent, `CLAN export ${new Date().toISOString().slice(0, 10)}`), files = join(dir, 'files');
    await mkdir(files, { recursive: true });
    const exp = c.sync.exportAll({ diary });
    let copied = 0;
    for (const r of exp.records.filter((x) => x.kind === 'file')) {
      const sha = (r.payload as { sha256: string }).sha256, src = c.files.personalObject(c.me, sha);
      if (src && /^[0-9a-f]{64}$/.test(sha)) { await copyFile(src, join(files, sha)); copied++; }
    }
    await writeFile(join(dir, 'clan-export.json'), JSON.stringify(exp), { mode: 0o600 });
    shell.showItemInFolder(join(dir, 'clan-export.json'));
    return { records: exp.records.length, files: copied, diary };
  });
  ipcMain.handle('data:import', async () => {
    const dir = await pickDir('Choose a CLAN export folder'); if (!dir) return null;
    const exp = JSON.parse(await readFile(join(dir, 'clan-export.json'), 'utf8')) as unknown;
    let files = 0; // bytes first, so file records apply
    for (const name of await readdir(join(dir, 'files')).catch(() => [] as string[])) if (/^[0-9a-f]{64}$/.test(name)) { await c.store.put(join(dir, 'files', name)); files++; }
    return { records: c.sync.importExport(exp), files };
  });
  ipcMain.handle('data:backups', () => shell.openPath(backupsDir));
  ipcMain.handle('data:backupNow', () => {
    if (!backupNow()) throw new Error('Not enough free disk space for a backup (CLAN always leaves 1 GB free).');
    return { at: Date.now() };
  });
}

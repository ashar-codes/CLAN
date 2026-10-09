// Beta feedback (main process): the student writes feedback and may tick "attach diagnostics". The result is SAVED to a
// file they choose and send themselves — CLAN never uploads anything. Diagnostics are versions, platform, counts and
// recent error kinds only: never notes, Diary, chats, files, names, ids, credentials or log text. Previewable first.
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arch, platform, release } from 'node:os';
import { z } from 'zod';
import type { ClanApp } from '@clan/core';
import { recentErrors } from '@classroom/server';
import type { Keystore } from './keystore.ts';

export function registerFeedback(c: ClanApp, keystore: Keystore) {
  const diagnostics = () => {
    let dbBytes = 0; try { dbBytes = statSync(join(app.getPath('userData'), 'teacher.db')).size; } catch { /* none yet */ }
    return {
      app: { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, chrome: process.versions.chrome },
      system: { platform: platform(), release: release(), arch: arch(), locale: app.getLocale(), gpu: app.getGPUFeatureStatus() },
      secureKeyStorage: keystore.status.secure, dbBytes, uptimeSeconds: Math.round(process.uptime()),
      ...c.sync.diagnostics(), recentErrors: recentErrors(),
    };
  };
  ipcMain.handle('feedback:preview', () => diagnostics());
  ipcMain.handle('feedback:save', async (_e, raw) => {
    const f = z.object({ kind: z.enum(['problem', 'idea', 'other']), text: z.string().trim().min(1).max(10_000), diagnostics: z.boolean() }).parse(raw);
    const w = BrowserWindow.getFocusedWindow() ?? undefined;
    const o = { title: 'Save your feedback', defaultPath: join(app.getPath('documents'), `CLAN feedback ${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o);
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, JSON.stringify({ format: 'clan-beta-feedback/v1', at: new Date().toISOString(), kind: f.kind, text: f.text, ...(f.diagnostics ? { diagnostics: diagnostics() } : {}) }, null, 2), { mode: 0o600 });
    return { path: r.filePath };
  });
}

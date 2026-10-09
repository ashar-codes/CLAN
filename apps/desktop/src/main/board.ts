// Local whiteboards (Personal / Course / Study Session) and export. CLAN boards are served by the hosting session over
// its pinned WSS; this only handles boards that belong to the person on this device. Export is derived output: a PNG
// rendered by the board itself (or that PNG laid out as a PDF page); the editable board is never replaced by it.
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ClanApp } from '@clan/core';

const Id = z.uuid();
const Owner = z.object({ kind: z.enum(['personal', 'course', 'session']), id: z.string().min(1).max(64) });

export function registerBoards(c: ClanApp) {
  const me = { kind: 'user' as const, userId: c.me };
  const handle = (ch: string, f: (...a: unknown[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => f(...a));
  const owner = (raw: unknown) => { const o = Owner.parse(raw); return o.kind === 'personal' ? { kind: 'personal' as const, id: c.me } : o; };
  handle('board:list', (raw) => c.whiteboard.list(me, owner(raw)));
  handle('board:create', (raw, title) => c.whiteboard.create(me, owner(raw), z.string().parse(title)));
  handle('board:read', (id, since) => { const b = c.whiteboard.get(me, Id.parse(id)); if (!b) throw new Error('Board not found.'); return { ...c.whiteboard.read(me, b.id, z.number().int().min(0).parse(since)), title: b.title }; });
  handle('board:edit', (id, ops) => c.whiteboard.edit(me, Id.parse(id), z.array(z.unknown()).max(200).parse(ops)));
  handle('board:rename', (id, title) => c.whiteboard.rename(me, Id.parse(id), z.string().parse(title)));
  handle('board:remove', (id) => c.whiteboard.remove(me, Id.parse(id)));
  handle('board:export', async (fmt, dataUrl, title) => {
    const f = z.enum(['png', 'pdf']).parse(fmt), url = z.string().max(60_000_000).regex(/^data:image\/png;base64,/).parse(dataUrl);
    const name = `${z.string().max(120).parse(title).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Board'}.${f}`;
    const w = BrowserWindow.getFocusedWindow() ?? undefined;
    const r = !app.isPackaged && process.env.CLAN_EXPORT_DIR ? { canceled: false, filePath: `${process.env.CLAN_EXPORT_DIR}/${name}` } // tests: no dialog
      : w ? await dialog.showSaveDialog(w, { defaultPath: name }) : await dialog.showSaveDialog({ defaultPath: name });
    if (r.canceled || !r.filePath) return null;
    const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    if (f === 'png') { await writeFile(r.filePath, png); return r.filePath; }
    // PDF: one page with the rendered board (an offscreen window prints it; nothing else is loaded)
    const pw = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
    try {
      await pw.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0"><img src="${url}" style="width:100%"></body></html>`)}`);
      await writeFile(r.filePath, await pw.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4' }));
    } finally { pw.destroy(); }
    return r.filePath;
  });
}

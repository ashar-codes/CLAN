import { app, BrowserWindow, dialog, ipcMain, session, shell, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { JoinPolicy, PRODUCT_NAME, StudentProfile } from '@classroom/protocol';
import { candidateInterfaces, openDb, startClassroomServer, type RunningServer } from '@classroom/server';
import { browse } from '@classroom/server/discovery';
import type { Capabilities, Conn, PastClass, StartedClassroom } from '../shared.ts';
import { StudentFiles } from './student.ts';
import type { ResourceView } from '@classroom/protocol';

const here = dirname(fileURLToPath(import.meta.url));
// `--profile=name` gives a separate data dir so one machine can run teacher + students during development.
const profileArg = process.argv.find((a) => a.startsWith('--profile='))?.slice(10);
if (profileArg && /^[\w-]{1,32}$/.test(profileArg)) app.setPath('userData', join(app.getPath('userData'), `profile-${profileArg}`));
if (process.env.CLASSROOM_USER_DATA) app.setPath('userData', process.env.CLASSROOM_USER_DATA); // tests
app.setName(PRODUCT_NAME);

let server: RunningServer | null = null;
const db = () => (dbHandle ??= openDb(join(app.getPath('userData'), 'teacher.db')));
let dbHandle: ReturnType<typeof openDb> | undefined;

function capabilities(): Capabilities {
  const directReason: Record<string, string> = {
    darwin: 'macOS has no supported public API for an app to create a Wi-Fi access point. Connect everyone to the same Wi-Fi or router and use LAN Mode.',
    win32: 'Direct Mode (Windows Wi-Fi Direct access point) is scheduled for Milestone 3 and is not available in this build yet.',
    linux: 'Direct Mode is not supported on Linux. Use LAN Mode.',
  };
  return {
    platform: process.platform,
    lanMode: true,
    directMode: { available: false, reason: directReason[process.platform] ?? 'Not supported on this OS.' },
    interfaces: candidateInterfaces(),
    hostname: hostname(),
  };
}

const profilePath = () => join(app.getPath('userData'), 'profile.json');
function loadProfile(): Partial<StudentProfile> & { deviceId: string } {
  try {
    const p = JSON.parse(readFileSync(profilePath(), 'utf8'));
    if (typeof p.deviceId === 'string') return p;
  } catch {}
  const fresh = { deviceId: randomUUID() };
  mkdirSync(dirname(profilePath()), { recursive: true });
  writeFileSync(profilePath(), JSON.stringify(fresh));
  return fresh;
}

const ConnArgs = z.object({ url: z.string().regex(/^http:\/\/[\w.:[\]-]+$/), token: z.string().min(16).max(128), sessionId: z.uuid(), classTitle: z.string().max(200) });
const ResourceArgs = z.object({ id: z.uuid(), name: z.string().max(300), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: z.string().max(200), addedAt: z.number(), status: z.literal('ready'), available: z.boolean(), pushed: z.boolean() });
const StartArgs = z.object({ title: z.string().trim().min(1).max(80), policy: JoinPolicy, host: z.ipv4().optional() });

function registerIpc() {
  ipcMain.handle('caps', () => capabilities());
  ipcMain.handle('profile:get', () => loadProfile());
  ipcMain.handle('profile:save', (_e, p: unknown) => {
    // deviceId is owned by this process, never by the renderer.
    const parsed = StudentProfile.parse({ ...(p as object), deviceId: loadProfile().deviceId });
    writeFileSync(profilePath(), JSON.stringify(parsed));
    return parsed;
  });

  ipcMain.handle('teacher:start', async (e, raw: unknown): Promise<StartedClassroom> => {
    const a = StartArgs.parse(raw);
    if (server) await server.close();
    const ifaces = candidateInterfaces();
    const host = a.host && ifaces.some((i) => i.address === a.host) ? a.host : ifaces[0]?.address;
    if (!host) throw new Error('No network connection found. Connect this computer to the classroom Wi-Fi or router first.');
    server = await startClassroomServer({ title: a.title, host, db: db(), storageDir: join(app.getPath('userData'), 'storage'), advertise: true, networkMode: 'lan' });
    server.resources.on('progress', (resourceId: string, bytes: number, size: number) => e.sender.send('teacher:import', { resourceId, bytes, size }));
    server.classroom.setPolicy(a.policy);
    return { url: server.url, code: server.classroom.code, teacherToken: server.classroom.teacherToken, title: a.title, host, iface: ifaces.find((i) => i.address === host)!.name };
  });
  ipcMain.handle('teacher:stop', async () => { await server?.close(); server = null; });

  ipcMain.handle('teacher:addFiles', async (e) => {
    if (!server) throw new Error('Start a class first.');
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = win ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }) : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    const errors: string[] = [];
    let added = 0;
    for (const p of r.canceled ? [] : r.filePaths) {
      try { await server.resources.importFile(p); added++; } catch (err) { errors.push(`${p.split(/[\\/]/).pop()}: ${(err as Error).message}`); }
    }
    return { added, errors };
  });
  // Reveal only — never open/execute student-submitted files.
  ipcMain.handle('teacher:revealSubmission', (_e, id: unknown) => {
    if (!server || typeof id !== 'string') throw new Error('No active class.');
    shell.showItemInFolder(server.assignments.submissionPath(id));
  });
  ipcMain.handle('teacher:pastClasses', (): PastClass[] => db().prepare(`
    SELECT s.id sessionId, s.title, s.started_at startedAt, s.ended_at endedAt,
      (SELECT count(*) FROM resources r WHERE r.session_id = s.id AND r.status = 'ready') files,
      (SELECT count(*) FROM submissions x WHERE x.session_id = s.id) submissions
    FROM sessions s ORDER BY s.started_at DESC LIMIT 30`).all() as PastClass[]);
  ipcMain.handle('teacher:revealPastClass', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Bad id');
    const dir = join(app.getPath('userData'), 'storage', 'submissions', id);
    await import('node:fs/promises').then((f) => f.mkdir(dir, { recursive: true }));
    await shell.openPath(dir); // a folder: opens the file manager, executes nothing
  });

  const files = new StudentFiles(() => BrowserWindow.getAllWindows()[0]);
  const conn = (c: unknown): Conn => ConnArgs.parse(c);
  const res = (r: unknown): ResourceView => ResourceArgs.parse(r) as ResourceView;
  ipcMain.handle('student:fileStatus', (_e, c, list: unknown) => files.status(conn(c), z.array(ResourceArgs).max(1000).parse(list) as ResourceView[]));
  ipcMain.handle('student:download', (_e, c, r) => files.download(conn(c), res(r)));
  ipcMain.handle('student:pause', (_e, id) => files.pause(z.uuid().parse(id)));
  ipcMain.handle('student:show', (_e, sid, id) => files.show({ sessionId: z.uuid().parse(sid) }, z.uuid().parse(id)));
  ipcMain.handle('student:open', (_e, sid, id) => files.open({ sessionId: z.uuid().parse(sid) }, z.uuid().parse(id)));
  ipcMain.handle('student:pick', (e, ext) => files.pick(e, z.array(z.string().regex(/^[a-z0-9]{1,10}$/)).max(30).parse(ext)));
  ipcMain.handle('student:submit', (_e, c, a, p) => files.submit(conn(c), z.uuid().parse(a), z.uuid().parse(p)));
  ipcMain.handle('student:receipts', (_e, sid) => files.receipts(sid === undefined ? undefined : z.uuid().parse(sid)));

  const browsers = new Map<WebContents, () => void>();
  ipcMain.handle('discover:start', (e) => {
    browsers.get(e.sender)?.();
    const stop = browse((list) => { if (!e.sender.isDestroyed()) e.sender.send('discover:list', list); });
    browsers.set(e.sender, stop);
    e.sender.once('destroyed', () => { browsers.get(e.sender)?.(); browsers.delete(e.sender); });
  });
  ipcMain.handle('discover:stop', (e) => { browsers.get(e.sender)?.(); browsers.delete(e.sender); });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 720, minHeight: 540, title: PRODUCT_NAME,
    webPreferences: { preload: join(here, '../preload/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  const dev = process.env.CLASSROOM_DEV_URL;
  if (dev) win.loadURL(dev);
  else win.loadFile(join(here, '../renderer/index.html'));
}

app.whenReady().then(() => {
  // Nothing needs camera/mic/notifications yet; grant capabilities explicitly as features land.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  server.close().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

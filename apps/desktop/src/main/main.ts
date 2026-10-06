import { app, BrowserWindow, ipcMain, session, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { JoinPolicy, PRODUCT_NAME, StudentProfile } from '@classroom/protocol';
import { candidateInterfaces, openDb, startClassroomServer, type RunningServer } from '@classroom/server';
import { browse } from '@classroom/server/discovery';
import type { Capabilities, StartedClassroom } from '../shared.ts';

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

  ipcMain.handle('teacher:start', async (_e, raw: unknown): Promise<StartedClassroom> => {
    const a = StartArgs.parse(raw);
    if (server) await server.close();
    const ifaces = candidateInterfaces();
    const host = a.host && ifaces.some((i) => i.address === a.host) ? a.host : ifaces[0]?.address;
    if (!host) throw new Error('No network connection found. Connect this computer to the classroom Wi-Fi or router first.');
    server = await startClassroomServer({ title: a.title, host, db: db(), advertise: true, networkMode: 'lan' });
    server.classroom.setPolicy(a.policy);
    return { url: server.url, code: server.classroom.code, teacherToken: server.classroom.teacherToken, title: a.title, host, iface: ifaces.find((i) => i.address === host)!.name };
  });
  ipcMain.handle('teacher:stop', async () => { await server?.close(); server = null; });

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

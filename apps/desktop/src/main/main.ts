import { app, BrowserWindow, dialog, ipcMain, session, shell, type WebContents } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as opaque from '@serenity-kit/opaque';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { JoinPolicy, keyFingerprint, LEGACY_STORAGE_NAME, PRODUCT_NAME, StudentProfile, type Receipt } from '@classroom/protocol';
import { pairAndJoin, reconnect, type Candidate } from '@classroom/client';
import { pinnedTransport } from '@classroom/client/node';
import { logError } from '@classroom/server';
import { Keystore } from './keystore.ts';
import { Trust } from './trust.ts';
import { candidateInterfaces, openDb, startClassroomServer, type RunningServer } from '@classroom/server';
import { browse } from '@classroom/server/discovery';
import type { Capabilities, Conn, Joined, OwnProfile, PastClass, StartedClassroom } from '../shared.ts';
import { StudentFiles } from './student.ts';
import type { ResourceView } from '@classroom/protocol';

const here = dirname(fileURLToPath(import.meta.url));
// Storage identity first (before anything reads userData or touches safeStorage); the user-visible name is set after ready.
app.setName(LEGACY_STORAGE_NAME);
// `--profile=name` gives a separate data dir so one machine can run teacher + students during development.
const profileArg = process.argv.find((a) => a.startsWith('--profile='))?.slice(10);
if (profileArg && /^[\w-]{1,32}$/.test(profileArg)) app.setPath('userData', join(app.getPath('userData'), `profile-${profileArg}`));
if (process.env.CLASSROOM_USER_DATA) app.setPath('userData', process.env.CLASSROOM_USER_DATA); // tests

let server: RunningServer | null = null;
let keystore: Keystore;
let trust: Trust;
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
    keystore: keystore.status,
  };
}

const profilePath = () => join(app.getPath('userData'), 'profile.json');
/**
 * Names live in profile.json; identity is the Ed25519 key in the OS keystore. A pre-2.5 profile's random deviceId
 * is ignored for trust (kept only as legacyDeviceId) — the key is generated on first use after upgrade.
 */
function loadProfile(): OwnProfile {
  const p = (() => { try { return JSON.parse(readFileSync(profilePath(), 'utf8')); } catch { return {}; } })();
  const devicePublicKey = trust.device().publicKey;
  return { fullName: p.fullName, rollNo: p.rollNo, deviceName: p.deviceName, devicePublicKey, fingerprint: keyFingerprint(devicePublicKey) };
}

const ConnArgs = z.object({ url: z.string().regex(/^https:\/\/[\w.:[\]-]+$/), token: z.string().min(16).max(128), sessionId: z.uuid(), classTitle: z.string().max(200) });
const ResourceArgs = z.object({ id: z.uuid(), name: z.string().max(300), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: z.string().max(200), addedAt: z.number(), status: z.literal('ready'), available: z.boolean(), pushed: z.boolean() });
const StartArgs = z.object({ title: z.string().trim().min(1).max(80), policy: JoinPolicy, host: z.ipv4().optional() });

function registerIpc() {
  ipcMain.handle('caps', () => capabilities());
  ipcMain.handle('profile:get', () => loadProfile());
  ipcMain.handle('profile:save', (_e, p: unknown) => {
    // The public key is owned by this process (from the keystore), never by the renderer.
    const parsed = StudentProfile.parse({ ...(p as object), devicePublicKey: trust.device().publicKey });
    let legacy: unknown;
    try { legacy = JSON.parse(readFileSync(profilePath(), 'utf8')).deviceId ?? JSON.parse(readFileSync(profilePath(), 'utf8')).legacyDeviceId; } catch {}
    writeFileSync(profilePath(), JSON.stringify({ fullName: parsed.fullName, rollNo: parsed.rollNo, deviceName: parsed.deviceName, ...(legacy ? { legacyDeviceId: legacy } : {}) }));
    return loadProfile();
  });

  // ---- secure student join (everything security-relevant happens here, not in the renderer) ----
  const joined = (r: { url: string; token: string; memberId: string; status: Joined['status']; classroom: Joined['classroom'] }, teacherPublicKey: string): Joined => ({
    url: r.url, token: r.token, memberId: r.memberId, status: r.status, classroom: r.classroom, teacherPublicKey,
    teacherFingerprint: keyFingerprint(teacherPublicKey), teacherTrust: trust.teacherTrust(r.classroom.title, teacherPublicKey),
  });
  ipcMain.handle('student:join', async (_e, code: unknown, manual: unknown): Promise<Joined> => {
    const c = z.string().regex(/^\d{6}$/).parse(code);
    const p = loadProfile();
    if (!p.fullName || !p.rollNo || !p.deviceName) throw new Error('Fill in your details first.');
    let candidates: Candidate[] = discovered;
    if (manual !== undefined && manual !== '') {
      const m = z.string().regex(/^(http:\/\/)?[\w.-]+:\d{1,5}$/).parse(manual); // diagnostics fallback: teacher's bootstrap address
      candidates = [{ url: m.startsWith('http') ? m : `http://${m}` }];
    }
    // Multicast discovery can take several seconds on busy Wi-Fi; wait up to 10 s before reporting "none found".
    for (let i = 0; i < 40 && candidates.length === 0; i++) { await new Promise((r) => setTimeout(r, 250)); candidates = discovered; }
    await opaque.ready;
    const r = await pairAndJoin({
      candidates, code: c, profile: { fullName: p.fullName, rollNo: p.rollNo, deviceName: p.deviceName }, device: trust.device(),
      opaque: opaque.client, transportFor: (b) => pinnedTransport(b),
    }).catch((e) => { logError('join', (e as { cause?: unknown }).cause ?? e); throw new Error((e as Error).message); });
    trust.remember({ sessionId: r.classroom.sessionId, url: r.url, title: r.classroom.title, binding: r.binding, savedAt: Date.now() });
    return joined(r, r.binding.teacherPublicKey);
  });
  ipcMain.handle('student:rejoin', async (_e, sid: unknown): Promise<Joined> => {
    const s = trust.session(z.uuid().parse(sid));
    if (!s) throw new Error('This class is no longer paired on this device. Join with the code.');
    const r = await reconnect({ url: s.url, transport: s.transport, sessionId: s.sessionId, device: trust.device() }).catch((e) => { throw new Error((e as Error).message); });
    return joined({ ...r, url: s.url }, s.binding.teacherPublicKey);
  });
  ipcMain.handle('student:lastSession', () => { const s = trust.lastSession(); return s && { sessionId: s.sessionId, title: s.title, savedAt: s.savedAt }; });
  ipcMain.handle('student:trustTeacher', (_e, title: unknown, key: unknown) => {
    const t = z.string().max(200).parse(title), k = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(key);
    // Only a key we actually paired with (PAKE-authenticated) can be accepted.
    if (!trust.pairedTeacherKeys().has(k)) throw new Error('Unknown teacher key.');
    trust.trustTeacher(t, k);
  });

  ipcMain.handle('teacher:start', async (e, raw: unknown): Promise<StartedClassroom> => {
    const a = StartArgs.parse(raw);
    if (server) await server.close();
    const ifaces = candidateInterfaces();
    const host = a.host && ifaces.some((i) => i.address === a.host) ? a.host : ifaces[0]?.address;
    if (!host) throw new Error('No network connection found. Connect this computer to the classroom Wi-Fi or router first.');
    server = await startClassroomServer({ title: a.title, host, db: db(), storageDir: join(app.getPath('userData'), 'storage'), advertise: true, networkMode: 'lan', identity: await trust.teacherIdentity() });
    trust.pin(server.url, server.tls.spkiSha256); // the teacher's own dashboard uses WSS too
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

  const files = new StudentFiles(() => BrowserWindow.getAllWindows()[0], trust);
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
  ipcMain.handle('student:verifyReceipt', (_e, r: unknown) => files.check(r as Receipt));
  ipcMain.handle('student:peerState', (_e, c, s: unknown) => files.peerState(conn(c), z.object({ peerAssist: z.boolean(), revoked: z.array(z.string().max(64)).max(1000) }).parse(s)));
  ipcMain.handle('student:setSharing', (_e, on: unknown) => files.setSharing(z.boolean().parse(on)));
  app.on('before-quit', () => { void files.stopAll(); });

  const browsers = new Map<WebContents, () => void>();
  ipcMain.handle('discover:start', (e) => {
    browsers.get(e.sender)?.();
    // Discovery is a hint only ("there may be a classroom here"); OPAQUE decides.
    const stop = browse((list) => { discovered = list; if (!e.sender.isDestroyed()) e.sender.send('discover:list', list); });
    browsers.set(e.sender, stop);
    e.sender.once('destroyed', () => { browsers.get(e.sender)?.(); browsers.delete(e.sender); });
  });
  ipcMain.handle('discover:stop', (e) => { browsers.get(e.sender)?.(); browsers.delete(e.sender); });
}

let discovered: Candidate[] = [];

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
  keystore = new Keystore(); // initialise OS key storage under the legacy storage identity…
  app.setName(PRODUCT_NAME); // …then present as CLAN
  trust = new Trust(keystore, app.getPath('userData'));
  trust.installVerifyProc(session.defaultSession);
  // Nothing needs camera/mic/notifications yet; grant capabilities explicitly as features land.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  process.on('uncaughtException', (e) => logError('main', e));
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

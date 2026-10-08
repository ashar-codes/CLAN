import { app, BrowserWindow, dialog, ipcMain, powerMonitor, session, shell, type WebContents } from 'electron';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import * as opaque from '@serenity-kit/opaque';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ClanType, JoinPolicy, keyFingerprint, LEGACY_STORAGE_NAME, PRODUCT_NAME, StudentProfile, type Receipt } from '@classroom/protocol';
import { pairAndJoin, reconnect, type Candidate } from '@classroom/client';
import { pinnedTransport } from '@classroom/client/node';
import { logError } from '@classroom/server';
import { Keystore } from './keystore.ts';
import { Trust } from './trust.ts';
import { candidateInterfaces, openDb, startClassroomServer, type RunningServer } from '@classroom/server';
import { browse, dlog } from '@classroom/server/discovery';
import type { Capabilities, Conn, Joined, OwnProfile, PastClass, StartedClassroom } from '../shared.ts';
import { StudentFiles } from './student.ts';
import { registerClan } from './clan.ts';
import { registerChat } from './chat.ts';
import { registerStudy } from './study.ts';
import { Credentials, providerFactory, registerAI } from './ai.ts';
import { registerBoards } from './board.ts';
import { micArmed, registerMediaScheme, registerTapes } from './tape.ts';
import { DesktopDirect } from './direct.ts';
import { mediaBinary, mediaWorkDir, registerScreen } from './screen.ts';
import { ScreenShareEvents } from '@clan/core';
import { connect as tcpConnect } from 'node:net';
import { decodeDirectQr } from '@classroom/protocol';
import { TransferError } from '@classroom/client';
import type { ResourceView } from '@classroom/protocol';

const here = dirname(fileURLToPath(import.meta.url));
/** IPC rejects lose custom fields, so the manual Wi-Fi fallback travels as a tagged message (only to this app's own window). */
const joinError = (e: unknown) => {
  const d = (e as { code?: string; direct?: { ssid: string; passphrase: string } });
  return new Error(d.code === 'direct_manual' && d.direct ? `DIRECT_MANUAL:${JSON.stringify({ ssid: d.direct.ssid, passphrase: d.direct.passphrase })}` : (e as Error).message);
};
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
let dbHandle: ReturnType<typeof openDb> | undefined; // legacy file name; it is this device's database
let clan: ReturnType<typeof registerClan>;

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
const ResourceArgs = z.object({ id: z.uuid(), name: z.string().max(300), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), mime: z.string().max(200), addedAt: z.number(), status: z.literal('ready'), available: z.boolean(), pushed: z.boolean(), direct: z.object({ from: z.string().max(80) }).optional() });
const StartArgs = z.object({ title: z.string().trim().min(1).max(80), policy: JoinPolicy, host: z.ipv4().optional(), type: ClanType.default('CLASSROOM'),
  description: z.string().max(500).default(''), hours: z.number().min(0.25).max(72).optional(),
  /** Host again: a new session under this existing CLAN (same id, members, trust). */
  clanId: z.uuid().optional(), connectivity: z.enum(['lan', 'direct']).default('lan'), distribution: z.enum(['host', 'peer']).default('host') });
let direct: DesktopDirect;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

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
    // Nearby Direct hosts over BLE are tried alongside LAN hosts; the code (OPAQUE) decides which one is ours.
    let ble: Awaited<ReturnType<DesktopDirect['bleCarriers']>> | null = manual ? [] : null;
    const t0 = Date.now();
    dlog('join: discovery', { known: candidates.length, ble: !manual });
    const bleP = manual ? Promise.resolve([]) : direct.bleCarriers().then((c) => { dlog('join: ble scan', { hosts: c.length, ms: Date.now() - t0 }); return (ble = c); });
    // Multicast discovery can take several seconds on busy Wi-Fi: wait up to 10 s, unless BLE already found a host.
    for (let i = 0; i < 40 && candidates.length === 0 && !(ble?.length); i++) { await new Promise((r) => setTimeout(r, 250)); candidates = discovered; }
    dlog('join: candidates', { lan: candidates.length, ms: Date.now() - t0 });
    const carriers = candidates.length ? await Promise.race([bleP, new Promise<[]>((r) => setTimeout(() => r([]), 500))]) : await bleP;
    await opaque.ready;
    const r = await pairAndJoin({
      candidates, code: c, profile: { fullName: p.fullName, rollNo: p.rollNo, deviceName: p.deviceName }, device: trust.device(),
      opaque: opaque.client, transportFor: (b) => pinnedTransport(b), carriers, associate: direct.associator(),
    }).catch((e) => { logError('join', (e as { cause?: unknown }).cause ?? e); throw joinError(e); });
    trust.remember({ sessionId: r.classroom.sessionId, url: r.url, title: r.classroom.title, binding: r.binding, savedAt: Date.now() });
    return joined(r, r.binding.teacherPublicKey);
  });
  /** QR fallback: the QR gives the network; the six-digit code still decides membership. */
  ipcMain.handle('student:joinQr', async (_e, qr: unknown, code: unknown): Promise<Joined> => {
    const pkg = decodeDirectQr(z.string().max(1024).parse(qr));
    const c = z.string().regex(/^\d{6}$/).parse(code);
    const p = loadProfile();
    if (!p.fullName || !p.rollNo || !p.deviceName) throw new Error('Fill in your details first.');
    const associate = direct.associator();
    if (!associate) throw joinError(Object.assign(new TransferError('direct_manual', 'Join the Wi-Fi network shown, then try again.'), { direct: pkg }));
    await associate(pkg);
    await opaque.ready;
    const r = await pairAndJoin({ candidates: [{ url: `http://${pkg.host}:${pkg.bootstrapPort}`, sid: pkg.sessionId }], code: c, profile: { fullName: p.fullName, rollNo: p.rollNo, deviceName: p.deviceName },
      device: trust.device(), opaque: opaque.client, transportFor: (b) => pinnedTransport(b), associate }).catch((e) => { throw joinError(e); });
    trust.remember({ sessionId: r.classroom.sessionId, url: r.url, title: r.classroom.title, binding: r.binding, savedAt: Date.now() });
    return joined(r, r.binding.teacherPublicKey);
  });
  /** Topology probe: can this member open a TCP connection to other members' peer servers on this network? */
  ipcMain.handle('student:peerProbe', async (_e, raw: unknown) => {
    const targets = z.array(z.string().regex(/^https:\/\/(10|172|192|127)\.[\d.]+:\d{1,5}$/)).max(3).parse(raw);
    const ok = await Promise.all(targets.map((t) => new Promise<boolean>((res) => {
      const u = new URL(t);
      const s = tcpConnect({ host: u.hostname, port: Number(u.port), timeout: 2500 }, () => { s.destroy(); res(true); });
      s.on('error', () => res(false)).on('timeout', () => { s.destroy(); res(false); });
    })));
    return { tried: targets.length, reachable: ok.filter(Boolean).length };
  });
  /** Media credential via the pinned CLAN channel (renderer HTTP has no CORS to the host, by design). */
  ipcMain.handle('media:token', async (_e, raw: unknown) => {
    const c = z.object({ url: z.string().regex(/^https:\/\/[\w.:[\]-]+$/), token: z.string().min(16).max(128), sessionId: z.uuid() }).parse(raw);
    const own = server && server.url === c.url && server.classroom.id === c.sessionId;
    const tr = own ? pinnedTransport({ certificate: server!.tls.certificate, spkiSha256: server!.tls.spkiSha256 }) : trust.session(c.sessionId)?.transport;
    const base = own ? server!.url : trust.session(c.sessionId)?.url;
    if (!tr || !base) throw new Error('Not connected to that CLAN.');
    const r = await tr.fetch(`${base}/api/media/token`, { method: 'POST', headers: { authorization: `Bearer ${c.token}` } });
    const b = await r.json().catch(() => ({})) as { token?: string; message?: string };
    if (!r.ok || !b.token) throw new Error(b.message ?? 'Screen sharing is unavailable.');
    return { token: b.token };
  });
  ipcMain.handle('direct:availability', () => direct.availability());
  ipcMain.handle('direct:status', async () => (server && direct.net?.active ? { ...(await direct.net.status()), connected: server.classroom.roster().filter((m) => m.connected).length, p2p: server.classroom.p2p } : null));
  ipcMain.handle('direct:qr', async () => { if (!server) throw new Error('No active CLAN.'); return direct.qr(server); });
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
    await direct.stop();
    // Every hosted session belongs to a canonical CLAN: re-host keeps it; classrooms reuse their course's CLAN; others are created.
    let title = a.title, type = a.type, clanId: string | null;
    if (a.clanId) {
      const c = clan.clans.get(a.clanId);
      if (!c || c.archivedAt || !clan.clans.members(c.id).some((m) => m.userId === clan.me && m.role === 'owner')) throw new Error('You can only host your own CLANs again.');
      if (c.type === 'TEMPORARY') throw new Error('A Temporary CLAN cannot be hosted again; start a new one.');
      ({ name: title, type } = c); clanId = c.id;
    } else clanId = null;
    const expiresAt = type === 'TEMPORARY' ? Date.now() + (a.hours ?? 2) * 3600_000 : null;
    clanId ??= type === 'CLASSROOM' ? clan.classroomClanFor(title) : clan.clans.create({ type, name: title, createdBy: clan.me, expiresAt: expiresAt ?? undefined }).id;
    const sessionKey = randomUUID();
    let host: string | undefined, iface = '', directNet: Awaited<ReturnType<DesktopDirect['start']>> | null = null;
    if (a.connectivity === 'direct') {
      directNet = await direct.start(sessionKey); // the CLAN server binds only to the Direct interface
      host = directNet.hostAddress; iface = 'Direct network';
    } else {
      const ifaces = candidateInterfaces();
      host = a.host && ifaces.some((i) => i.address === a.host) ? a.host : ifaces[0]?.address;
      iface = ifaces.find((i) => i.address === host)?.name ?? '';
      if (!host) throw new Error('No network connection found. Connect this computer to a Wi-Fi network or router, or use Direct Network.');
    }
    // Canonical display name only if the person actually set one (never the placeholder, never device data).
    const named = clan.identity.displayName(clan.me);
    const hostName = loadProfile().fullName || (named && named !== 'Me' ? named : undefined);
    try {
      server = await startClassroomServer({ title, host, db: db(), storageDir: join(app.getPath('userData'), 'storage'), advertise: true, networkMode: a.connectivity === 'direct' ? 'direct' : 'lan', identity: await trust.teacherIdentity(),
        clan: { type, id: clanId, description: a.description, expiresAt }, hostName, media: { binary: mediaBinary(), workDir: mediaWorkDir() }, chat: clan.chat, whiteboard: clan.whiteboard,
        direct: directNet ? { ssid: directNet.ssid, passphrase: directNet.passphrase, auth: 'WPA2', host: directNet.hostAddress, expiresAt: expiresAt ?? Date.now() + 12 * 3600_000 } : undefined });
      if (directNet) await direct.publish(server);
      chatHooks.hosted(server);
      // Presentation control events onto the CLAN event bus (IDs/status only; never media).
      const sid = server.classroom.id;
      server.presentations.on('event', (ev: import('@classroom/server').PresentationEvent) => {
        if (ev.type === 'PresentationStarted') clan.bus.publish(ScreenShareEvents.PresentationStarted, 'screenshare', { sessionId: sid, presentationId: ev.presentationId, presenter: ev.presenter, source: ev.source, audio: ev.audio });
        else if (ev.type === 'PresentationSourceChanged') clan.bus.publish(ScreenShareEvents.PresentationSourceChanged, 'screenshare', { sessionId: sid, presentationId: ev.presentationId, source: ev.source, audio: ev.audio });
        else if (ev.type === 'PresentationStopped') clan.bus.publish(ScreenShareEvents.PresentationStopped, 'screenshare', { sessionId: sid, presentationId: ev.presentationId, reason: ev.reason });
        else if ('memberId' in ev) clan.bus.publish(ScreenShareEvents[ev.type], 'screenshare', { sessionId: sid, memberId: ev.memberId });
      });
    } catch (err) { await server?.close(); server = null; await direct.stop(); throw err; }
    clan.syncClassrooms();
    clearTimeout(expiryTimer);
    if (expiresAt) expiryTimer = setTimeout(() => server?.classroom.end(), expiresAt - Date.now()); // the session also refuses joins/tokens after expiry
    trust.pin(server.url, server.tls.spkiSha256); // the teacher's own dashboard uses WSS too
    server.resources.on('progress', (resourceId: string, bytes: number, size: number) => e.sender.send('teacher:import', { resourceId, bytes, size }));
    server.classroom.setPolicy(a.policy);
    if (a.distribution === 'peer') server.classroom.setPeerAssist(true);
    return { url: server.url, code: server.classroom.code, teacherToken: server.classroom.teacherToken, title, host, iface,
      direct: directNet ? { ssid: directNet.ssid, band: directNet.band, strategy: directNet.strategy, vpn: directNet.vpn } : null };
  });
  ipcMain.handle('teacher:stop', async () => {
    const ended = server?.classroom.clan;
    await server?.close(); server = null; clearTimeout(expiryTimer);
    await direct.stop(); // AP down, its credentials gone, firewall rules removed
    clan.syncClassrooms();
    if (ended?.type === 'TEMPORARY' && ended.id) { clan.clans.archive(ended.id); clan.whiteboard.purgeOwner('clan', ended.id); } // ending a Temporary CLAN ends the CLAN (and its board); downloaded files stay
  });

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
  ipcMain.handle('teacher:addPaths', async (_e, raw: unknown) => {
    if (!server) throw new Error('Start a CLAN session first.');
    const paths = z.array(z.string().min(3).max(4096)).max(20).parse(raw);
    const errors: string[] = []; let added = 0;
    for (const p of paths) {
      try {
        if (!isAbsolute(p) || !statSync(p).isFile()) throw new Error('not a file');
        await server.resources.importFile(p); added++;
      } catch (err) { errors.push(`${p.split(/[\\/]/).pop()}: ${(err as Error).message}`); }
    }
    return { added, errors };
  });
  ipcMain.handle('files:addPersonal', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = win ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }) : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    let n = 0;
    for (const p of r.canceled ? [] : r.filePaths.slice(0, 20)) { await clan.files.add({ kind: 'user', userId: clan.me }, p, basename(p), { kind: 'personal', ownerId: clan.me }); n++; }
    return n;
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

  const files = (studentFiles = new StudentFiles(() => BrowserWindow.getAllWindows()[0], trust));
  const conn = (c: unknown): Conn => ConnArgs.parse(c);
  const res = (r: unknown): ResourceView => ResourceArgs.parse(r) as ResourceView;
  ipcMain.handle('student:fileStatus', (_e, c, list: unknown) => files.status(conn(c), z.array(ResourceArgs).max(1000).parse(list) as ResourceView[]));
  ipcMain.handle('student:download', (_e, c, r, hostOnly) => files.download(conn(c), res(r), hostOnly === true));
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
let studentFiles: StudentFiles;
let chatHooks: ReturnType<typeof registerChat>;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 720, minHeight: 540, title: PRODUCT_NAME,
    webPreferences: { preload: join(here, '../preload/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Links (Saved, chat) open in the system browser; the app window itself never navigates or opens pages.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
  const dev = process.env.CLASSROOM_DEV_URL;
  if (dev) win.loadURL(dev);
  else win.loadFile(join(here, '../renderer/index.html'));
}

registerMediaScheme(); // privileged scheme must be declared before ready
app.whenReady().then(() => {
  keystore = new Keystore(); // initialise OS key storage under the legacy storage identity…
  app.setName(PRODUCT_NAME); // …then present as CLAN
  trust = new Trust(keystore, app.getPath('userData'));
  trust.installVerifyProc(session.defaultSession);
  // Nothing needs camera/mic/notifications yet; grant capabilities explicitly as features land.
  // Only screen capture (display-capture) may be requested, and only after the user picked a source in CLAN. No mic/camera.
  // Microphone only right after the student started a Study Tape with “Microphone” ticked (audio only, never camera).
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => cb(perm === 'display-capture' || (perm === 'media' && micArmed() && !!(details as { mediaTypes?: string[] }).mediaTypes?.length && (details as { mediaTypes: string[] }).mediaTypes.every((t) => t === 'audio'))));
  process.on('uncaughtException', (e) => logError('main', e));
  direct = new DesktopDirect();
  void direct.recover(); // a crash may have left a Direct network or firewall rules behind
  powerMonitor.on('resume', () => { void direct.net?.restart().catch((e) => logError('direct', e)); }); // same SSID/passphrase: members rejoin with their device keys
  registerIpc();
  registerScreen();
  const aiCreds = new Credentials();
  clan = registerClan(db(), join(app.getPath('userData'), 'storage'), () => loadProfile().fullName, providerFactory(aiCreds));
  chatHooks = registerChat({ clan, server: () => server, trust, files: studentFiles });
  registerStudy(clan);
  registerAI(clan, aiCreds);
  registerBoards(clan);
  registerTapes(clan);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !server) return;
  e.preventDefault();
  quitting = true;
  server.close().then(() => direct.stop()).finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

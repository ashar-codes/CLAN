import { directoryConfig, type DirectoryAdvert } from '@classroom/protocol';
import { directoryHost, setDirectoryClassrooms } from './lan-directory.ts';
// Nearby People, friends, private chats, direct files, voice notes and call signaling on the desktop (main process).
// Identity: this computer's keystore-held device key (the key that proves identity when joining a CLAN). The people
// endpoint's TLS certificate is long-lived (keystore) and vouched for by that key. Rules live in @clan/core People;
// transport in people-runtime.ts; WebRTC media runs in the renderer with signaling relayed here (signed, live-only).
import { BrowserWindow, Notification, dialog, ipcMain, powerMonitor, shell } from 'electron';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import QRCode from 'qrcode';
import type { ClanApp } from '@clan/core';
import { PeopleChanged, PeopleAlert, PushAgent } from '@clan/core';
import { candidateInterfaces, createClassroomTls, logError } from '@classroom/server';
import { IMAGE_PREVIEW_BYTES, TEXT_PREVIEW_BYTES, previewImageMime, previewKind, type FilePreview } from '@classroom/client';
import { newEd25519, nodeSigner, sha256File } from '@classroom/client/node';
import { ackCode, encodeTransfer, keyFingerprint, parseReceiveCode, PROFILE_FIELDS, QRX_MAX_BYTES, safetyNumber, TEMP_TTLS, verifyAck, VOICE_MIME, type PeerBody } from '@classroom/protocol';
import { startPeopleRuntime } from './people-runtime.ts';
import { canOpen } from './student.ts';
import { windowsOpenWith } from './open-with.ts';
import { armMedia } from './tape.ts';
import type { Keystore } from './keystore.ts';
import type { Trust } from './trust.ts';

const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/), Id = z.uuid();

export async function registerPeople(c: ClanApp, o: { keystore: Keystore; trust: Trust; dataDir: string; displayName(): string | undefined; deviceName?(): string | undefined }) {
  const p = c.people, signer = nodeSigner(o.keystore.get('device-ed25519', () => newEd25519().privatePkcs8)); // the same key as trust.device(), synchronous signer
  const fresh = await createClassroomTls('people', Date.now(), 5 * 365 * 86_400_000);
  const tls = JSON.parse(o.keystore.get('people-tls', () => JSON.stringify({ certPem: fresh.certPem, keyPem: fresh.keyPem, certificate: fresh.certificate, spkiSha256: fresh.spkiSha256 }))) as typeof fresh;
  p.setSigner(signer);
  p.adoptIdentity(o.displayName(), o.deviceName?.());
  const send = (ch: string, v: unknown) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, v); };
  const loopback = process.env.CLAN_TEST_LOOPBACK === '1' && !(await import('electron')).app.isPackaged; // development/E2E only
  // The same port across restarts, so friends' saved routes keep working; a fresh one only if it is taken.
  const portFile = join(o.dataDir, 'people', 'port');
  await mkdir(join(o.dataDir, 'people'), { recursive: true });
  const saved = Number(await readFile(portFile, 'utf8').catch(() => '')) || undefined;
  const linkPortFile = join(o.dataDir, 'people', 'link-port'), savedLink = Number(await readFile(linkPortFile, 'utf8').catch(() => '')) || undefined;
  const directoryFile = join(o.dataDir, 'people', 'lan-directory.json');
  const savedDirectory = await readFile(directoryFile, 'utf8').then((v) => directoryConfig(JSON.parse(v))).catch(() => null);
  const start = (port?: number) => startPeopleRuntime({
    people: p, signer, tls, dir: join(o.dataDir, 'people'), discover: true, port, linkPort: savedLink, allowLoopback: loopback,
    endpoints: (port) => [...candidateInterfaces().filter((i) => i.private).map((i) => `${i.address}:${port}`), ...(loopback ? [`127.0.0.1:${port}`] : [])].slice(0, 3),
    directory: savedDirectory,
    ownClans: () => { const h = directoryHost(); if (!h) return []; const u = new URL(h.url); return [{ kind: 'clan', r: h.sid.replaceAll('-', ''), endpoints: [u.host], clan: { sid: h.sid, title: h.title.slice(0, 80), type: h.type } } satisfies DirectoryAdvert]; },
    onClans: (items, expires) => setDirectoryClassrooms(items.filter((x) => x.clan).map((x) => ({ ...x.clan!, url: `http://${x.endpoints[0]}`, alt: x.endpoints.slice(1).map((a) => `http://${a}`), discoverySource: 'directory' })), expires),
    onLive: (e) => send('people:live', { from: e.from, body: e.body }),
    onChange: (what) => send('people:changed', { what }),
  });
  const rt = await start(saved).catch((e: NodeJS.ErrnoException) => { if (saved && e.code === 'EADDRINUSE') return start(); throw e; });
  if (rt.port !== saved) await writeFile(portFile, String(rt.port));
  if (rt.linkPort !== savedLink) await writeFile(linkPortFile, String(rt.linkPort));
  c.bus.subscribe('desktop.people', PeopleChanged, (e) => { send('people:changed', e.payload); if (e.payload.what === 'profile' || e.payload.what === 'relations') { void rt.refreshDiscovery(); void rt.links.tick(); } });
  c.bus.subscribe('desktop.people.alert', PeopleAlert, (e) => {
    const x = e.payload, w = BrowserWindow.getAllWindows()[0], prefs = c.notifications.prefs({ kind: 'user', userId: c.me });
    if (!prefs.direct || x.kind.startsWith('file.') && !prefs.files || w?.isFocused() || !Notification.isSupported()) return;
    const who = prefs.previews ? p.contact(x.key)?.name : null;
    const n = new Notification({ title: who ?? 'CLAN', body: x.kind === 'friend.nearby' ? 'A verified friend is reachable nearby.' : x.kind === 'call.attempt' ? 'Call attempt received after reconnecting (did not ring).' : x.kind === 'call.missed' ? 'Missed CLAN call.' : x.kind === 'call.invite' ? 'Incoming call. Open CLAN to answer.' : x.kind === 'friend.request' ? 'New friend request.' : x.kind === 'file.offer' ? 'New file or voice note offer.' : x.kind === 'file.done' ? 'Transfer complete.' : 'New message or chat invitation.' });
    n.on('click', () => { const win = BrowserWindow.getAllWindows()[0]; if (win) { win.show(); win.focus(); win.webContents.send('people:open', x.convId ?? null); } }); n.show();
  });
  // this computer is one of the account's devices (after Me › My Devices linking); friends hear about the others
  const devices = () => { try { const acc = c.sync.account(); if (!acc) return; p.announceDevice(acc.accountId, p.myProfile().deviceName ?? `${p.myProfile().name}’s ${process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'PC' : 'computer'}`); if (p.shareDeviceLinks()) void rt.tick(); } catch (e) { logError('people', e); } };
  devices();
  setInterval(() => { void p.sweep().catch((e) => logError('people', e)); devices(); }, 60_000).unref();
  // Optional internet-assisted wake-ups for friends' phones (sender side only: a computer has no push token).
  const push = new PushAgent(p, { fetch: (u, i) => fetch(u, i), sign: (b) => signer.sign(b), devices: () => [], nonce: () => randomUUID().replaceAll('-', '') });
  setInterval(() => void push.tick(), 5_000).unref();
  void p.sweep();

  const handle = (ch: string, f: (...a: unknown[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => f(...a));
  const me = () => {
    const prof = p.myProfile(), qr = rt.myQr();
    return { key: signer.publicKey, fingerprint: keyFingerprint(signer.publicKey), profile: prof, qr, port: rt.port };
  };
  handle('people:me', () => me());
  handle('people:qrImage', async (intent) => QRCode.toDataURL(rt.myQr(z.enum(['profile', 'friend', 'chat']).optional().parse(intent)), { errorCorrectionLevel: 'M', margin: 1, width: 280 }));
  handle('people:resetQr', () => { p.inviteToken(true); return me(); });
  handle('people:update', (raw) => p.updateProfile(z.object({ name: z.string().optional(), ...Object.fromEntries(PROFILE_FIELDS.map((f) => [f, f === 'interests' ? z.array(z.string()).optional() : z.string().optional()])),
    fieldVisibility: z.record(z.string(), z.enum(['everyone', 'friends', 'nobody'])).optional() }).parse(raw) as never));
  handle('people:pickAvatar', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = win ? await dialog.showOpenDialog(win, { filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg'] }], properties: ['openFile'] }) : await dialog.showOpenDialog({ properties: ['openFile'] });
    const path = r.filePaths[0]; if (r.canceled || !path) return null;
    const bytes = await readFile(path), mime = previewImageMime(bytes);
    if (!mime) throw new Error('Choose a PNG or JPEG picture.');
    return p.setAvatar(path, mime);
  });
  handle('people:avatar', async (raw) => {
    const key = raw === 'me' ? null : Key.parse(raw);
    if (!key) { const a = p.myProfile().avatar; if (!a) return null; const loc = p.avatarPath(a.objectId); return loc ? `data:${a.mime};base64,${(await readFile(loc)).toString('base64')}` : null; }
    const a = p.avatarOf(key); // fetched and verified against their signed profile
    return a ? `data:${a.mime};base64,${Buffer.from(a.data).toString('base64')}` : null;
  });
  handle('people:visibility', async (v, ms) => { const r = p.setVisibility(z.enum(['everyone', 'friends', 'invisible']).parse(v), ms === undefined ? undefined : z.number().int().parse(ms)); await rt.refreshDiscovery(); return r; });
  handle('people:nearby', () => rt.nearby());
  handle('people:directory', async (raw) => { if (raw !== undefined) { const config = raw === null ? null : directoryConfig(raw); const previous = rt.directory().config; rt.configureDirectory(config); try { await writeFile(directoryFile, JSON.stringify(config), { mode: 0o600 }); } catch (e) { rt.configureDirectory(previous); throw e; } } return rt.directory(); });
  let addresses = candidateInterfaces().map((i) => i.address).sort().join(',');
  powerMonitor.on('resume', () => rt.networkChanged());
  const networkTimer = setInterval(() => { const current = candidateInterfaces().map((i) => i.address).sort().join(','); if (current !== addresses) { addresses = current; rt.networkChanged(); } }, 5000); networkTimer.unref();
  handle('people:contacts', (f) => p.contacts(z.enum(['friends', 'requests', 'blocked', 'all']).parse(f ?? 'all')));
  handle('people:contact', (k) => { const key = Key.parse(k); const x = p.contact(key); return x && { ...x, safetyNumber: safetyNumber(signer.publicKey, key) }; });
  handle('people:connectQr', async (text) => { const r = await rt.connectQr(z.string().max(2000).parse(text)); void rt.tick(); return r; });
  handle('people:friend', async (action, k, note) => {
    const key = Key.parse(k), a = z.enum(['request', 'accept', 'reject', 'cancel', 'remove', 'block', 'unblock', 'verify']).parse(action);
    if (a === 'request') p.sendFriendRequest(key, note === undefined ? undefined : z.string().max(200).parse(note));
    else if (a === 'accept') p.acceptFriend(key); else if (a === 'reject') p.rejectFriend(key); else if (a === 'cancel') p.cancelFriendRequest(key);
    else if (a === 'remove') p.removeFriend(key); else if (a === 'block') p.block(key); else if (a === 'unblock') p.unblock(key); else p.markVerified(key);
    void rt.tick();
  });
  // ---- chats ----
  handle('people:conversations', () => p.conversations());
  handle('people:invite', (k, mode, ttl) => { const id = p.inviteChat(Key.parse(k), z.enum(['permanent', 'temporary']).parse(mode ?? 'permanent'), ttl === null || ttl === undefined ? null : z.number().int().refine((n) => (TEMP_TTLS as readonly number[]).includes(n)).parse(ttl)); void rt.tick(); return id; });
  handle('people:chat', (action, id) => { const conv = Id.parse(id), a = z.enum(['accept', 'decline', 'end']).parse(action); if (a === 'accept') p.acceptChat(conv); else if (a === 'decline') p.declineChat(conv); else p.endChat(conv); void rt.tick(); });
  handle('people:page', (id, before, limit) => p.page(Id.parse(id), { before: before === undefined || before === null ? undefined : z.number().int().parse(before), limit: limit === undefined ? undefined : z.number().int().parse(limit) }));
  handle('people:send', (id, text, replyTo) => { const m = p.sendText(Id.parse(id), z.string().parse(text), { replyTo: replyTo ? Id.parse(replyTo) : undefined }); void rt.tick(); return m; });
  handle('people:message', async (action, msgId, arg) => {
    const id = Id.parse(msgId), a = z.enum(['edit', 'deleteForEveryone', 'deleteForMe', 'react', 'forward']).parse(action);
    if (a === 'edit') p.editMessage(id, z.string().parse(arg));
    else if (a === 'deleteForEveryone') await p.deleteForEveryone(id);
    else if (a === 'deleteForMe') await p.deleteForMe(id);
    else if (a === 'react') p.react(id, arg === null ? null : z.string().parse(arg));
    else { // forward a copy into another active conversation (text, or the verified local file)
      const m = p.message(id), to = Id.parse(arg);
      if (!m || m.deleted) throw new Error('That message is no longer here.');
      if (m.kind === 'text' && m.text) p.sendText(to, m.text);
      else if (m.transfer) { const path = m.mine ? p.outgoingBytesLocal(m.transfer.id) : p.filePath(m.transfer.id); if (!path) throw new Error('This file is not on this computer.'); await offer(to, path, m.transfer.name, m.transfer.mime); }
    }
    void rt.tick();
  });
  handle('people:autoDownload', (raw) => p.autoDownload(raw === undefined ? undefined : raw === null ? null : z.object({ on: z.boolean(), maxBytes: z.number().int(), kinds: z.array(z.enum(['image', 'video', 'audio', 'document'])) }).parse(raw)));
  handle('people:pushRelay', (url) => { const r = url === undefined ? p.pushRelay() : p.pushRelay(z.string().max(200).nullable().parse(url)); void push.tick(); return { relay: r, status: push.status }; });
  handle('people:wakeCall', (k, callId, kind) => { const ok = p.wakeForCall(Key.parse(k), Id.parse(callId), z.enum(['call', 'call.cancel']).parse(kind ?? 'call')); if (ok) void push.tick(); return ok; });
  handle('people:retry', (msgId) => { p.retryMessage(Id.parse(msgId)); void rt.tick(); });
  handle('people:read', (id) => { p.markRead(Id.parse(id)); void rt.tick(); });
  handle('people:clear', (id) => p.clearHistory(Id.parse(id)));
  handle('people:remove', async (id) => { await p.removeConversation(Id.parse(id)); void rt.tick(); });
  // ---- files & voice notes ----
  const offer = async (convId: string, path: string, name: string, mime: string, voiceMs?: number) => { const t = await p.offerFile(convId, path, { name, mime, voiceMs }); void rt.tick(); return t; };
  handle('people:sendFile', async (id, rawPaths) => {
    const convId = Id.parse(id);
    let paths = rawPaths === undefined ? null : z.array(z.string().max(4096)).max(10).parse(rawPaths);
    if (!paths) { const win = BrowserWindow.getFocusedWindow(); const r = win ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }) : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] }); if (r.canceled) return []; paths = r.filePaths; }
    const out = [];
    for (const path of paths) { if (!(await stat(path)).isFile()) continue; out.push(await offer(convId, path, basename(path), mimeOf(path))); }
    return out;
  });
  handle('people:sendVoice', async (id, bytes, mime, ms) => {
    const convId = Id.parse(id), m = z.enum(VOICE_MIME).parse(mime), buf = Buffer.from(z.instanceof(Uint8Array).parse(bytes));
    const tmp = join(o.dataDir, 'people', 'voice-out'); await mkdir(tmp, { recursive: true });
    const path = join(tmp, `${randomUUID()}.${m === 'audio/webm' ? 'webm' : m === 'audio/ogg' ? 'ogg' : 'm4a'}`);
    await writeFile(path, buf);
    try { return await offer(convId, path, 'Voice message', m, z.number().int().positive().parse(ms)); } finally { await rm(path, { force: true }); }
  });
  /** Receiving needs room for the file plus a margin; refuse up front instead of failing half-way. */
  const roomFor = async (id: string) => {
    const t = p.transfer(id); if (!t || t.direction !== 'in') return;
    const s = await statfs(o.dataDir).catch(() => null), free = s ? s.bavail * s.bsize : Infinity, need = t.size - t.received + 64 * 1024 * 1024;
    if (free < need) throw new Error(`Not enough free disk space to receive “${t.name}” (needs ${Math.ceil(need / 1e6)} MB, ${Math.floor(free / 1e6)} MB free). Free some space and try again.`);
  };
  handle('people:file', async (action, tid) => { const id = Id.parse(tid), a = z.enum(['accept', 'decline', 'cancel', 'retry']).parse(action); if (a === 'accept' || a === 'retry') await roomFor(id); if (a === 'accept') p.acceptFile(id); else if (a === 'decline') p.declineFile(id); else if (a === 'retry') p.retryDownload(id); else return p.cancelFile(id).then(() => void rt.tick()); void rt.tick(); });
  /** Re-verified on every use: the stored bytes must still hash to what was agreed. */
  const verified = async (tid: string) => {
    const t = p.transfer(Id.parse(tid)), path = t && (t.direction === 'out' ? p.outgoingBytesLocal(t.id) : p.filePath(t.id));
    if (!t || !path) throw new Error('This file is not available on this device.');
    if ((await sha256File(path)) !== t.sha256) throw new Error('This file failed verification.');
    return { path, name: t.name, sha256: t.sha256, mime: t.mime, size: t.size };
  };
  handle('people:voiceBytes', async (tid) => { const f = await verified(z.string().parse(tid)); if (f.size > 10 * 1024 * 1024 || !(VOICE_MIME as readonly string[]).includes(f.mime)) throw new Error('Not a voice message.'); return new Uint8Array(await readFile(f.path)); });
  handle('people:preview', async (tid): Promise<FilePreview> => {
    const { path, name } = await verified(z.string().parse(tid)), kind = previewKind(name), size = (await stat(path)).size;
    if (kind === 'text' && size <= TEXT_PREVIEW_BYTES) { const text = await readFile(path, 'utf8'); if (!text.includes('\0')) return { kind: 'text', text }; }
    if (kind === 'image' && size <= IMAGE_PREVIEW_BYTES) { const bytes = await readFile(path), mime = previewImageMime(bytes); if (mime) return { kind: 'image', uri: `data:${mime};base64,${bytes.toString('base64')}` }; }
    return { kind: 'metadata', reason: 'No embedded preview for this file or size. Use a viewer or save a copy.' };
  });
  handle('people:save', async (tid) => {
    const f = await verified(z.string().parse(tid)), win = BrowserWindow.getFocusedWindow();
    const r = win ? await dialog.showSaveDialog(win, { title: 'Save a verified copy', defaultPath: f.name }) : await dialog.showSaveDialog({ defaultPath: f.name });
    if (r.canceled || !r.filePath) return null;
    await copyFile(f.path, r.filePath, constants.COPYFILE_EXCL);
    if ((await sha256File(r.filePath)) !== f.sha256) { await rm(r.filePath, { force: true }); throw new Error('The file changed while saving. No copy was kept.'); }
    return { name: basename(r.filePath) };
  });
  handle('people:openWith', async (tid) => {
    const f = await verified(z.string().parse(tid));
    if (!canOpen(f.name)) throw new Error('This file type can contain code. Save a copy instead.');
    if (process.platform === 'win32') return windowsOpenWith(f.path);
    if (process.platform === 'darwin') {
      const win = BrowserWindow.getFocusedWindow(); if (!win) return;
      const sel = await dialog.showOpenDialog(win, { title: 'Choose a viewer application', defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }] });
      const viewer = sel.filePaths[0]; if (sel.canceled || !viewer || extname(viewer).toLowerCase() !== '.app') return;
      await promisify(execFile)('/usr/bin/open', ['-a', viewer, f.path]); return;
    }
    const err = await shell.openPath(f.path); if (err) throw new Error(err);
  });
  // ---- calls: the renderer owns the WebRTC connection; signaling is signed and sent live here ----
  handle('people:nearbyAlerts', (on) => p.nearbyAlerts(z.boolean().optional().parse(on)));
  handle('people:attempt', (k, id) => { p.queueCallAttempt(Key.parse(k), Id.parse(id)); void rt.tick(); });
  handle('people:signal', async (k, body) => {
    const key = Key.parse(k), b = z.object({ kind: z.string() }).passthrough().parse(body) as PeerBody;
    if (!b.kind.startsWith('call.')) throw new Error('Not a call signal.');
    return rt.sendLive(p.callSignal(key, b as Extract<PeerBody, { kind: `call.${string}` }>));
  });
  // ---- optical (animated QR) transfer: encoded here so the sender's identity signature uses the keystore key ----
  const optical = new Map<string, ReturnType<typeof encodeTransfer>>();
  handle('people:opticalStart', async (rawTo, rawPath) => {
    const to = rawTo ? parseReceiveCode(z.string().max(300).parse(rawTo)) : null;
    if (rawTo && !to) throw new Error('That is not a CLAN receive code.');
    let path = rawPath === undefined || rawPath === null ? null : z.string().max(4096).parse(rawPath);
    if (!path) { const win = BrowserWindow.getFocusedWindow(); const r = win ? await dialog.showOpenDialog(win, { properties: ['openFile'] }) : await dialog.showOpenDialog({ properties: ['openFile'] }); if (r.canceled || !r.filePaths[0]) return null; path = r.filePaths[0]; }
    const st = await stat(path);
    if (!st.isFile()) throw new Error('Choose a file.');
    if (st.size > QRX_MAX_BYTES) throw new Error(`That file is ${Math.round(st.size / 1e5) / 10} MB. QR transfer is limited to ${QRX_MAX_BYTES / 1024 / 1024} MB — share it over a direct connection instead.`);
    const tx = encodeTransfer({ bytes: new Uint8Array(await readFile(path)), name: basename(path), mime: mimeOf(path) }, { blockSize: st.size > 64_000 ? 600 : 400, to: to ?? undefined, signer });
    if (optical.size > 4) optical.delete(optical.keys().next().value!);
    optical.set(tx.id, tx);
    return { id: tx.id, name: tx.info.name, size: tx.info.size, mode: tx.meta.mode, minFrames: tx.minFrames, to: to?.name ?? null };
  });
  handle('people:opticalFrames', (id, from, count) => {
    const tx = optical.get(z.string().regex(/^[0-9a-f]{16}$/).parse(id)); if (!tx) throw new Error('That transfer was stopped.');
    const f = z.number().int().min(0).parse(from), n = z.number().int().min(1).max(200).parse(count);
    return Array.from({ length: n }, (_, i) => tx.frame(f + i));
  });
  handle('people:opticalStop', (id) => { optical.delete(z.string().parse(id)); });
  handle('people:opticalReceipt', (id, text) => {
    const tx = optical.get(z.string().parse(id)); if (!tx) throw new Error('That transfer was stopped.');
    const r = verifyAck(z.string().max(600).parse(text), { id: tx.id, sha256: tx.info.sha256 });
    if (!r) return null;
    const c0 = p.contact(r.key);
    return { key: r.key, name: c0?.name ?? null, fingerprint: keyFingerprint(r.key) };
  });
  handle('people:opticalAck', (id, sha) => ackCode({ id: z.string().regex(/^[0-9a-f]{16}$/).parse(id), sha256: z.string().regex(/^[0-9a-f]{64}$/).parse(sha), signer }));
  const opticalFile = async (bytes: unknown, name: unknown) => {
    const b = Buffer.from(z.instanceof(Uint8Array).parse(bytes));
    if (b.length > QRX_MAX_BYTES) throw new Error('Too large.');
    const safe = z.string().max(200).parse(name).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').slice(0, 120) || 'file';
    return { b, safe };
  };
  handle('people:opticalSave', async (bytes, name) => {
    const { b, safe } = await opticalFile(bytes, name);
    const win = BrowserWindow.getFocusedWindow();
    const r = win ? await dialog.showSaveDialog(win, { defaultPath: safe }) : await dialog.showSaveDialog({ defaultPath: safe });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, b);
    return { name: basename(r.filePath) };
  });
  handle('people:opticalInbox', async (bytes, name, mime) => {
    const { b, safe } = await opticalFile(bytes, name);
    const tmp = join(o.dataDir, 'people', 'optical'); await mkdir(tmp, { recursive: true });
    const path = join(tmp, `${randomUUID()}-${safe}`); await writeFile(path, b);
    try { await c.capture.capture({ kind: 'user', userId: c.me }, { kind: 'file', path, name: safe, mime: z.string().max(120).parse(mime) }); } finally { await rm(path, { force: true }); }
  });
  handle('people:deviceOffers', () => p.deviceOffers());
  handle('people:deviceOffer', (action, from, key) => { const a = z.enum(['accept', 'decline']).parse(action); if (a === 'accept') p.acceptDeviceOffer(Key.parse(from), Key.parse(key)); else p.declineDeviceOffer(Key.parse(from), Key.parse(key)); void rt.tick(); });
  handle('people:armMedia', (kind) => armMedia(z.enum(['microphone', 'camera']).parse(kind)));
  handle('people:logCall', (raw) => p.logCall(z.object({ id: z.string().max(64), peerKey: Key, direction: z.enum(['in', 'out']), connectedAt: z.number().int().nullable().optional(), endedAt: z.number().int().nullable().optional(), outcome: z.string().max(40).optional() }).parse(raw)));
  return { rt, close: () => { clearInterval(networkTimer); return rt.stop(); } };
}

const MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg' };
const mimeOf = (path: string) => MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';

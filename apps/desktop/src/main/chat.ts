// Chat, Capture and notifications for the desktop shell (main process). The renderer never chooses a user, a path or a
// host address: chat history goes through the session's own pinned transport, files through dialogs / real dropped files,
// and everything the renderer passes in is validated here.
import { app, BrowserWindow, dialog, Notification, shell, type IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { pinnedTransport, sha256File, uniquePath } from '@classroom/client/node';
import { ChatHandle, ClientMessage, safeFileName, type ChatMessageView, type ChatThreadView, type ResourceView, type ShareResult } from '@classroom/protocol';
import { ChatEvents, fetchLinkMeta, parseIntake, type ClanApp } from '@clan/core';
import type { RunningServer } from '@classroom/server';
import type { Trust } from './trust.ts';
import type { StudentFiles } from './student.ts';

const Conn = z.object({ url: z.string().regex(/^https:\/\/[\w.:[\]-]+$/), token: z.string().min(16).max(128), sessionId: z.uuid() });
/** Only the chat endpoints are reachable through this bridge. */
const ChatPath = z.string().max(200).regex(/^\/api\/chat\/(threads|direct|threads\/[0-9a-f-]{36}\/messages(\?(before|after|limit)=\d{1,15}(&(before|after|limit)=\d{1,15}){0,2})?)$/);
const Paths = z.array(z.string().min(3).max(4096).refine(isAbsolute)).max(20);
const Target = z.union([z.literal('clan'), ChatHandle]);
const Thread = z.object({ id: z.uuid(), kind: z.enum(['group', 'direct']), clanId: z.uuid(), with: z.object({ handle: ChatHandle, name: z.string().max(80), here: z.boolean() }).nullable(),
  lastSeq: z.number().int(), readSeq: z.number().int(), unread: z.number().int(), updatedAt: z.number() });
const Message = z.object({ id: z.uuid(), threadId: z.uuid(), seq: z.number().int().positive(), author: ChatHandle, authorName: z.string().max(80), body: z.string().max(4000),
  replyTo: z.uuid().nullable(), attachment: z.any().nullable(), createdAt: z.number(), editedAt: z.number().nullable(),
  removed: z.object({ by: z.enum(['author', 'host']), at: z.number() }).nullable(), reactions: z.array(z.object({ reaction: z.string().max(8), by: z.array(ChatHandle).max(500) })).max(6) });

export function registerChat(o: { clan: ClanApp; server: () => RunningServer | null; trust: Trust; files: StudentFiles }) {
  const { clan } = o;
  const me = { kind: 'user' as const, userId: clan.me };
  const handle = (ch: string, f: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => ipcMain.handle(ch, (e, ...a) => f(e, ...a));
  const win = () => BrowserWindow.getAllWindows()[0];

  /** The paired session's pinned route (members) or this device's own running server (host). */
  const route = (raw: unknown) => {
    const c = Conn.parse(raw);
    const s = o.server();
    if (s && s.url === c.url && (s.classroom.id === c.sessionId || c.token === s.classroom.teacherToken)) return { c, transport: pinnedTransport({ certificate: s.tls.certificate, spkiSha256: s.tls.spkiSha256 }), base: s.url, host: s };
    const t = o.trust.session(c.sessionId);
    if (!t) throw new Error('Not connected to that CLAN.');
    return { c, transport: t.transport, base: t.url, host: null };
  };

  handle('chat:http', async (_e, raw, req) => {
    const r = route(raw);
    const q = z.object({ method: z.enum(['GET', 'POST']), path: ChatPath, body: z.object({ to: ChatHandle }).optional() }).parse(req);
    const res = await r.transport.fetch(r.base + q.path, { method: q.method, headers: { authorization: `Bearer ${r.c.token}`, ...(q.body ? { 'content-type': 'application/json' } : {}) }, body: q.body ? JSON.stringify(q.body) : undefined });
    const b = await res.json().catch(() => ({})) as { message?: string };
    if (!res.ok) throw new Error(b.message ?? `Chat request failed (${res.status})`);
    return b;
  });

  // Teacher moderation uses the actual running host; renderer paths and principals are never trusted.
  handle('chat:pendingShares', () => {
    const host = o.server(); if (!host) throw new Error('Not hosting a CLAN.');
    return host.shares.pending({ role: 'teacher' });
  });
  handle('chat:reviewShare', (_e, id, accept) => {
    const host = o.server(); if (!host) throw new Error('Not hosting a CLAN.');
    return host.shares.decide({ role: 'teacher' }, z.uuid().parse(id), z.boolean().parse(accept));
  });

  // Durable Outbox (this device): a message is kept until the host acknowledged it, and retried with the same id.
  const Send = ClientMessage.refine((m) => m.t === 'chat.send');
  handle('chat:outboxAdd', (_e, clanId, payload) => clan.chat.queue(z.uuid().parse(clanId), Send.parse(payload) as never));
  handle('chat:outbox', (_e, clanId) => clan.chat.outbox(z.uuid().parse(clanId)));
  handle('chat:outboxSent', (_e, id) => clan.chat.sent(z.uuid().parse(id)));

  /** Member devices keep what the host delivered (offline reading, notifications). The host's own store is the authority. */
  handle('chat:ingest', (_e, t, mine, list) => clan.chat.ingest(Thread.parse(t) as ChatThreadView, ChatHandle.parse(mine), z.array(Message).max(200).parse(list) as ChatMessageView[]));
  handle('chat:setMe', (_e, clanId, h) => clan.chat.setMe(z.uuid().parse(clanId), ChatHandle.parse(h)));
  handle('chat:local', (_e, clanId) => clan.chat.localThreads(me, z.uuid().parse(clanId)));
  handle('chat:localPage', (_e, threadId, before) => clan.chat.localPage(me, z.uuid().parse(threadId), { before: before === undefined ? undefined : z.number().int().parse(before) }));
  handle('chat:received', () => clan.chat.receivedFiles(me).map((m) => ({ ...m, clanName: clan.clans.get(m.clanId)?.name ?? 'CLAN' })));

  /** Send files to the CLAN table or one CLANmate. Same resource/transfer system either way; only the audience differs. */
  const send = async (raw: unknown, paths: string[], to: string): Promise<ShareResult[]> => {
    const r = route(raw);
    for (const p of paths) if (!(await stat(p)).isFile()) throw new Error('Only files can be sent.');
    if (r.host) {
      const out: ResourceView[] = [];
      for (const p of paths) out.push(await r.host.shareFile(p, to, basename(p)));
      return out;
    }
    return o.files.share({ ...r.c, classTitle: '' }, paths, to);
  };
  handle('chat:sendDropped', (_e, raw, paths, to) => send(raw, Paths.parse(paths), Target.parse(to)));
  handle('chat:sendPicked', async (e, raw, to) => {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const pick = w ? await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'] }) : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return pick.canceled ? [] : send(raw, pick.filePaths.slice(0, 20), Target.parse(to));
  });
  /** The host keeps files members send it in its own store; this saves a verified copy to Downloads. */
  handle('chat:hostSave', async (_e, id) => {
    const s = o.server();
    if (!s) throw new Error('No active CLAN.');
    const f = s.resources.openForDownload({ role: 'teacher' }, z.uuid().parse(id));
    const dir = join((!app.isPackaged && process.env.CLASSROOM_DOWNLOADS_DIR) || join(app.getPath('downloads'), 'CLAN'), safeFileName(s.classroom.title));
    await mkdir(dir, { recursive: true });
    const dest = await uniquePath(dir, f.name);
    await copyFile(f.path, dest);
    if ((await sha256File(dest)) !== f.sha256) throw new Error('The copy does not match (checksum).');
    shell.showItemInFolder(dest);
    return { name: basename(dest) };
  });

  // ---- notifications ----
  clan.notifications.onNotice = (n) => {
    const w = win();
    w?.webContents.send('notify', n);
    if (n.alert && !w?.isFocused() && Notification.isSupported()) new Notification({ title: n.title, body: n.body, silent: false }).show();
  };
  const ctx = (patch: Partial<typeof clan.notifications.context>) => { clan.notifications.context = { ...clan.notifications.context, ...patch }; };
  app.on('browser-window-focus', () => ctx({ foreground: true }));
  app.on('browser-window-blur', () => ctx({ foreground: false }));
  handle('notify:context', (_e, raw) => ctx(z.object({ viewing: z.uuid().nullable().optional(), focus: z.boolean().optional() }).parse(raw)));
  handle('notify:list', () => clan.notifications.list(me, { unreadOnly: true }));
  handle('notify:readThread', (_e, id) => clan.notifications.markThreadRead(me, z.uuid().parse(id)));
  handle('notify:prefs', () => clan.notifications.prefs(me));
  handle('notify:setPrefs', (_e, raw) => clan.notifications.setPrefs(me, z.object({ groups: z.boolean(), direct: z.boolean(), files: z.boolean(), previews: z.boolean() }).partial().parse(raw)));

  // ---- Capture Inbox ----
  const enrich = async () => { for (const it of clan.saved.pendingMeta()) clan.saved.applyMeta(it.id, await fetchLinkMeta(it.url)); };
  const later = () => { void enrich().catch(() => {}); };
  const captured = (item: unknown) => { win()?.webContents.send('capture:added', item); later(); return item; };
  const Into = z.object({ courseId: z.uuid(), topicId: z.uuid().nullable().optional() }).optional();
  handle('capture:add', async (_e, raw, into) => captured(await clan.capture.capture(me, z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('note'), title: z.string().max(200).optional(), body: z.string().max(100_000).optional() }),
    z.object({ kind: z.literal('link'), url: z.string().max(2048), title: z.string().max(300).optional(), note: z.string().max(5000).optional(), tags: z.array(z.string()).max(20).optional(), collectionId: z.uuid().optional() }),
    z.object({ kind: z.literal('text'), text: z.string().max(20_000) }),
  ]).parse(raw), Into.parse(into))));
  const captureFiles = async (paths: string[], into?: z.infer<typeof Into>) => {
    const out = [];
    for (const p of paths) { if ((await stat(p)).isFile()) out.push(captured(await clan.capture.capture(me, { kind: 'file', path: p, name: basename(p) }, into))); }
    return out.length;
  };
  handle('capture:dropped', (_e, paths) => captureFiles(Paths.parse(paths)));
  handle('capture:pick', async (e, into) => {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const pick = w ? await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'] }) : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return pick.canceled ? 0 : captureFiles(pick.filePaths.slice(0, 20), Into.parse(into));
  });
  handle('capture:inbox', () => clan.capture.inbox(me));
  handle('capture:file', (_e, id, raw) => clan.capture.file(me, z.uuid().parse(id), z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('collection'), collectionId: z.uuid() }), z.object({ kind: z.literal('clan'), clanId: z.uuid() }),
    z.object({ kind: z.literal('course'), courseId: z.uuid(), topicId: z.uuid().nullable().optional() }), z.object({ kind: z.literal('done') }),
  ]).parse(raw)));

  // clan://capture?url=…|text=… from other apps or the browser. Parsed strictly; only links and text, into the Inbox.
  const intake = async (raw: string) => {
    const input = parseIntake(raw);
    if (!input) return;
    await clan.share.share(me, input, { kind: 'inbox' }).then((r) => captured(r)).catch(() => {});
  };
  if (!process.env.CLASSROOM_USER_DATA) app.setAsDefaultProtocolClient('clan'); // tests never register a handler system-wide
  app.on('open-url', (e, url) => { e.preventDefault(); void intake(url); });
  for (const a of process.argv) if (a.startsWith('clan://')) void intake(a);
  // Files dropped on the Dock icon / "Open with CLAN" go to the Inbox (a real file the user handed over).
  app.on('open-file', (e, path) => { e.preventDefault(); if (isAbsolute(path)) void captureFiles([path]).catch(() => {}); });
  later();
  setInterval(later, 10 * 60_000).unref();

  return {
    /** Host started a session: this device's place in its conversations, and typed events for person-scoped files. */
    hosted(s: RunningServer) {
      const hc = s.chat;
      if (!hc) return;
      clan.chat.setMe(hc.clanKey, hc.hostHandle);
      s.resources.on('direct', (resourceId: string, audience: string[], by: string | null) => {
        const sender = by ?? hc.hostHandle, to = audience.filter((h) => h !== sender);
        clan.bus.publish(ChatEvents.ResourceSentToMember, 'chat', { clanId: hc.clanKey, resourceId, threadId: to.length === 1 ? clan.chat.directThread(hc.clanKey, sender, to[0]!).id : '', by: sender, to });
      });
    },
  };
}

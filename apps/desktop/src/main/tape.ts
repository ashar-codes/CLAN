// Study Tape recording (main process). The renderer captures (explicit source pick, optional mic) with MediaRecorder and
// streams 1-second chunks here; they are appended to a `.part` file (never held in memory), disk space is watched, and
// stopping moves the file into the Resource Store (no second copy). A crash leaves the `.part` + the tape row: the next
// start finalizes it as "recovered". Playback goes through `clan-media://<refId>` with Range support, only for this
// person's own readable media/image files.
import { app, BrowserWindow, ipcMain, powerMonitor, protocol, systemPreferences } from 'electron';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { statfs, writeFile } from 'node:fs/promises';
import { ChunkWriter, CRITICAL_DISK, diskLevel, LOW_DISK } from './chunkWriter.ts';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { ClanApp } from '@clan/core';

const Id = z.uuid();
type Live = { tapeId: string; w: ChunkWriter; path: string; startedAt: number; mime: string };
let micArmedUntil = 0;
/** The microphone is granted only right after the student started a tape with “Microphone” ticked. */
export const micArmed = () => Date.now() < micArmedUntil;
let camArmedUntil = 0;
/** The camera is granted only right after the student pressed “Scan with camera” (video only, never with audio). */
export const camArmed = () => Date.now() < camArmedUntil;
/** Arms the microphone or camera for the next request (15 s), asking macOS first. Throws if the OS refuses. */
export async function armMedia(kind: 'microphone' | 'camera') {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus(kind) !== 'granted' && !(await systemPreferences.askForMediaAccess(kind)))
    throw new Error(`CLAN may not use the ${kind} (System Settings › Privacy & Security › ${kind === 'camera' ? 'Camera' : 'Microphone'}).`);
  if (kind === 'camera') camArmedUntil = Date.now() + 15_000; else micArmedUntil = Date.now() + 15_000;
}

/** Must run before app ready. */
export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'clan-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
}

export function registerTapes(c: ClanApp) {
  const me = { kind: 'user' as const, userId: c.me };
  const handle = (ch: string, f: (...a: unknown[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => f(...a));
  const dir = join(app.getPath('userData'), 'recordings');
  mkdirSync(dir, { recursive: true });
  let live: Live | null = null;
  const tell = (m: object) => BrowserWindow.getAllWindows()[0]?.webContents.send('rec:problem', m);
  const free = async () => { try { const s = await statfs(dir); return s.bavail * s.bsize; } catch { return Infinity; } };

  // ---- recovery of tapes a crash left behind ----
  void (async () => {
    for (const t of c.recordings.interrupted(me)) {
      try {
        if (t.partPath && existsSync(t.partPath) && statSync(t.partPath).size > 0) await c.recordings.finish(me, t.id, { path: t.partPath, mime: 'video/webm', durationMs: Math.max(0, statSync(t.partPath).mtimeMs - t.startedAt), endReason: 'recovered after CLAN closed unexpectedly', recovered: true });
        else c.recordings.fail(me, t.id, 'nothing was recorded before CLAN closed');
      } catch { c.recordings.fail(me, t.id, 'could not recover the recording'); }
    }
  })();

  handle('rec:check', async () => ({ freeBytes: await free(), low: LOW_DISK, critical: CRITICAL_DISK, mic: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted', systemAudio: process.platform === 'win32' }));
  handle('rec:start', async (raw) => {
    const o = z.object({ title: z.string().trim().min(1).max(160), source: z.enum(['screen', 'window', 'test']), mic: z.boolean(), systemAudio: z.boolean(), othersConsent: z.boolean(), mime: z.string().max(80),
      courseId: Id.nullable().optional(), lectureId: Id.nullable().optional(), topicId: Id.nullable().optional(), studySessionId: Id.nullable().optional() }).parse(raw);
    if (live) throw new Error('A recording is already running.');
    if (await free() < CRITICAL_DISK) throw new Error('Not enough free disk space to record (less than 512 MB).');
    if (o.mic) await armMedia('microphone');
    const path = join(dir, `${crypto.randomUUID()}.webm.part`);
    const tape = c.recordings.start(me, { ...o, partPath: path });
    const w = await ChunkWriter.open(path, () => tell({ tapeId: tape.id, kind: 'write_failed', message: 'CLAN could not write the recording to disk. It stopped; what was recorded is kept.' }));
    live = { tapeId: tape.id, w, path, startedAt: tape.startedAt, mime: o.mime };
    return tape;
  });
  /** Appended strictly in order; a write failure stops accepting data and tells the window (the partial file is kept). */
  handle('rec:chunk', (tapeId, data) => {
    const l = live; if (!l || l.tapeId !== tapeId) return 'no recording';
    return l.w.append(Buffer.from(z.instanceof(Uint8Array).parse(data)));
  });
  handle('rec:stop', async (tapeId, raw) => {
    const o = z.object({ durationMs: z.number().min(0).max(48 * 3600_000), reason: z.string().max(120) }).parse(raw);
    const l = live; if (!l || l.tapeId !== Id.parse(tapeId)) throw new Error('No recording is running.');
    live = null;
    await l.w.close();
    if (!l.w.bytes) { c.recordings.fail(me, l.tapeId, o.reason === 'stopped' ? 'nothing was recorded' : o.reason); return c.recordings.get(me, l.tapeId); }
    return c.recordings.finish(me, l.tapeId, { path: l.path, mime: l.mime, durationMs: o.durationMs, endReason: l.w.failed ? 'disk write failed' : o.reason });
  });
  handle('rec:active', () => { const t = c.recordings.active(me); return t && live?.tapeId === t.id ? { ...t, bytes: live.w.bytes } : null; });
  // disk watch while recording
  setInterval(async () => {
    const l = live; if (!l) return;
    c.recordings.progress(me, l.tapeId, l.w.bytes);
    const f = await free(), level = diskLevel(f);
    if (level === 'critical') tell({ tapeId: l.tapeId, kind: 'disk_critical', freeBytes: f, message: 'Disk almost full — the recording was stopped and saved.' });
    else if (level === 'low') tell({ tapeId: l.tapeId, kind: 'disk_low', freeBytes: f, message: `Disk space is low (${(f / 1024 ** 3).toFixed(1)} GB left).` });
  }, 10_000).unref();
  powerMonitor.on('suspend', () => { if (live) try { c.recordings.mark(me, live.tapeId, { kind: 'marker', atMs: Date.now() - live.startedAt, text: 'Computer went to sleep' }); } catch { /* best effort */ } });
  powerMonitor.on('resume', () => { if (live) try { c.recordings.mark(me, live.tapeId, { kind: 'marker', atMs: Date.now() - live.startedAt, text: 'Resumed after sleep' }); } catch { /* best effort */ } });

  // ---- timeline ----
  handle('rec:mark', (tapeId, raw) => c.recordings.mark(me, Id.parse(tapeId), z.object({ kind: z.enum(['important', 'note', 'bookmark', 'marker']), atMs: z.number().min(0), text: z.string().max(4000).optional() }).parse(raw)));
  /** A frame the student explicitly captured: stored as a personal image Resource and pinned to its moment. */
  handle('rec:screenshot', async (tapeId, atMs, png) => {
    const id = Id.parse(tapeId), at = z.number().min(0).parse(atMs), bytes = Buffer.from(z.instanceof(Uint8Array).parse(png));
    if (bytes.length > 20 * 1024 * 1024 || bytes.subarray(1, 4).toString() !== 'PNG') throw new Error('Not a PNG frame.');
    const p = join(dir, `${crypto.randomUUID()}.png`); await writeFile(p, bytes);
    const t = c.recordings.get(me, id); if (!t) throw new Error('Study Tape not found.');
    const f = await c.files.ingest(me, p, `${t.title} · ${Math.floor(at / 60000)}m${String(Math.floor(at / 1000) % 60).padStart(2, '0')}s.png`, { kind: 'personal', ownerId: c.me }, 'image/png');
    return c.recordings.mark(me, id, { kind: 'screenshot', atMs: at, refId: f.refId });
  });
  handle('rec:editEvent', (id, text) => c.recordings.editEvent(me, Id.parse(id), z.string().parse(text)));
  handle('rec:removeEvent', (id) => c.recordings.removeEvent(me, Id.parse(id)));
  handle('rec:toNote', (id) => c.recordings.toNote(me, Id.parse(id)));

  // ---- library ----
  handle('rec:list', (raw) => c.recordings.list(me, z.object({ courseId: Id.optional(), lectureId: Id.optional() }).parse(raw ?? {})));
  handle('rec:get', (id) => { const t = c.recordings.get(me, Id.parse(id)); return t && { tape: t, events: c.recordings.events(me, t.id) }; });
  handle('rec:link', (id, raw) => c.recordings.link(me, Id.parse(id), z.object({ courseId: Id.nullable(), topicId: Id.nullable().optional(), lectureId: Id.nullable().optional() }).parse(raw)));
  /** Explicit sharing: the CLAN gets a reference to the same file (never a copy); the tape itself stays personal. */
  handle('rec:share', (id, clanId) => {
    const t = c.recordings.get(me, Id.parse(id)); if (!t?.refId) throw new Error('Nothing to share yet.');
    return c.files.share(me, t.refId, { kind: 'clan', clanId: Id.parse(clanId) });
  });
  handle('rec:rename', (id, title) => c.recordings.rename(me, Id.parse(id), z.string().parse(title)));
  handle('rec:remove', (id) => { const refs = c.recordings.remove(me, Id.parse(id)); for (const r of refs) try { c.files.remove(me, r); } catch { /* already gone */ } });

  // ---- playback: Range-capable, own readable media only ----
  protocol.handle('clan-media', (req) => {
    const refId = new URL(req.url).hostname;
    const f = z.uuid().safeParse(refId).success ? c.files.get(me, refId) : null;
    const o = f && c.store.object(f.objectId);
    if (!f || !o || !/^(video|audio|image)\//.test(f.mime || o.mime)) return new Response('Not found', { status: 404 });
    const size = o.size, type = (f.mime || o.mime).split(';')[0]!;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
    if (!m) return new Response(Readable.toWeb(createReadStream(o.location)) as ReadableStream, { status: 200, headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes' } });
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    return new Response(Readable.toWeb(createReadStream(o.location, { start, end })) as ReadableStream, { status: 206, headers: { 'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' } });
  });
  /** On quit with a tape running: close the file so the part is complete up to the last chunk (recovered on next start). */
  app.on('before-quit', () => { if (live) void live.w.close(); });
}

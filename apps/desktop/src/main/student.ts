// Student-side file transfers for the desktop app. Lives in the main process because it touches the filesystem.
// The renderer only ever passes opaque ids (resource ids, pick ids); it can never name a local path.
import { app, dialog, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsOpenWith } from './open-with.ts';
import { partPaths, sha256File, uploadShareResult, uploadSubmission } from '@classroom/client/node';
import { completedFileReader, PeerAgent } from '@classroom/client/peer';
import { api, IMAGE_PREVIEW_BYTES, TEXT_PREVIEW_BYTES, previewImageMime, previewKind, type FilePreview, type PeerInfo } from '@classroom/client';
import { candidateInterfaces } from '@classroom/server';
import { safeFileName, verifyReceipt, type Receipt, type ResourceView, type ShareResult, type SignedManifest } from '@classroom/protocol';
import type { Conn, FileState, StoredReceipt } from '../shared.ts';
import type { Trust } from './trust.ts';
type Job = { conn: Conn; resource: ResourceView; ctl?: AbortController; state: FileState; hostOnly?: boolean };

// "Open" hands a file to the OS default viewer. Allowed only for formats without macros/active content in their
// normal form. Legacy (.doc/.xls/.ppt) and macro-enabled Office formats (.docm/.xlsm/.pptm/.dotm/.xlam/.ppam…),
// executables, scripts, archives, HTML and everything unknown are "Show in folder" only. A matching SHA-256 proves
// the file is the teacher's copy (integrity), not that it is safe to open; opening still runs the viewer app and
// inherits its vulnerabilities.
const SAFE_TO_OPEN = new Set(['pdf', 'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a',
  'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods']);
export const canOpen = (path: string) => SAFE_TO_OPEN.has(extname(path).slice(1).toLowerCase());
const CONCURRENCY = 2;

const via = (teacher: boolean, peers: number) => [peers ? `${peers} peer${peers > 1 ? 's' : ''}` : '', teacher ? 'teacher' : ''].filter(Boolean).join(' + ') || 'teacher';
const json = <T>(p: string, fallback: T): Promise<T> => readFile(p, 'utf8').then(JSON.parse, () => fallback);
const exists = (p: string) => access(p).then(() => true, () => false);

export class StudentFiles {
  private jobs = new Map<string, Job>();
  private picks = new Map<string, { path: string; name: string; size: number }>();
  private win: () => BrowserWindow | undefined;
  private trust: Trust;
  private hostFile: (sessionId: string, id: string) => { path: string; name: string; sha256: string } | null;
  private dataDir = app.getPath('userData');

  // ---- data plane (Milestone 2.75) ----
  private agents = new Map<string, PeerAgent>();
  private tokens = new Map<string, string>();
  private peerAssist = new Map<string, boolean>();
  private cache = new Map<string, { manifest?: SignedManifest; sources?: PeerInfo[] }>(); // for teacher outages
  private offeredCompleted = new Set<string>();
  sharing = true; // "Share with classmates" (student can pause seeding)

  constructor(win: () => BrowserWindow | undefined, trust: Trust, hostFile: (sessionId: string, id: string) => { path: string; name: string; sha256: string } | null = () => null) { this.win = win; this.trust = trust; this.hostFile = hostFile; }

  /** Serve only on the interface that reaches the teacher (same subnet), never on other networks. */
  private classroomInterface(teacherHost: string) {
    const prefix = teacherHost.split('.').slice(0, 3).join('.') + '.';
    const ifs = candidateInterfaces();
    return (ifs.find((i) => i.address.startsWith(prefix)) ?? ifs[0])?.address ?? '127.0.0.1';
  }

  private agent(c: Conn): PeerAgent {
    this.tokens.set(c.sessionId, c.token);
    let a = this.agents.get(c.sessionId);
    if (!a) {
      const route = this.route(c);
      const host = new URL(route.url).hostname;
      const limit = app.isPackaged ? 0 : Number(process.env.CLASSROOM_PEER_UPLOAD_LIMIT ?? 0); // bytes/s; used by tests to slow a peer down
      a = new PeerAgent({
        transport: route.transport, url: route.url, token: () => this.tokens.get(c.sessionId)!, sessionId: c.sessionId,
        teacherKey: route.binding.teacherPublicKey, device: this.trust.device(), host: host === '127.0.0.1' ? host : this.classroomInterface(host),
        destDir: this.destDir(c), canSeed: true, limits: limit > 0 ? { maxBytesPerSec: limit } : undefined,
      });
      a.paused = !this.sharing;
      this.agents.set(c.sessionId, a);
      void a.start().catch(() => {});
    }
    return a;
  }

  /** Control-plane updates forwarded by the renderer (class.state / peer.revoked). */
  async peerState(c: Conn, s: { peerAssist: boolean; revoked: string[] }) {
    const a = this.agent(c);
    const was = this.peerAssist.get(c.sessionId);
    this.peerAssist.set(c.sessionId, s.peerAssist);
    a.deny(s.revoked);
    if (s.peerAssist) await (was ? a.ensureEndorsed() : a.endorse()).catch(() => {}); // retried later if still pending
  }

  setSharing(on: boolean) { this.sharing = on; for (const a of this.agents.values()) a.paused = !on; }

  async stopAll() { await Promise.all([...this.agents.values()].map((a) => a.stop())); this.agents.clear(); }

  /** The paired session's own URL + pinned transport; renderer-supplied URLs are never used. */
  private route(c: Conn) {
    const s = this.trust.session(c.sessionId);
    if (!s) throw new Error('This class is no longer paired on this device. Join again with the code.');
    return s;
  }

  private destDir(c: Conn) {
    const root = (!app.isPackaged && process.env.CLASSROOM_DOWNLOADS_DIR) || join(app.getPath('downloads'), 'CLAN');
    return join(root, safeFileName(c.classTitle));
  }
  private completedPath() { return join(this.dataDir, 'downloads.json'); }
  private async completed(): Promise<Record<string, { path: string; sha256: string }>> { return json(this.completedPath(), {}); }

  private emit(s: FileState) { this.win()?.webContents.send('student:file', s); }
  private set(job: Job, patch: Partial<FileState>) {
    job.state = { ...job.state, ...patch };
    this.emit(job.state);
  }

  /** Current state of each resource, reconstructed from memory + disk (survives app restarts). */
  async status(c: Conn, resources: ResourceView[]): Promise<FileState[]> {
    const done = await this.completed();
    return Promise.all(resources.map(async (r) => {
      const job = this.jobs.get(r.id);
      if (job) return job.state;
      const d = done[`${c.sessionId}:${r.id}`];
      if (d && d.sha256 === r.sha256 && (await exists(d.path))) {
        void this.offerCompleted(c, r, d.path);
        return { resourceId: r.id, state: 'completed', bytes: r.size, size: r.size, canOpen: canOpen(d.path) } satisfies FileState;
      }
      const p = partPaths(this.destDir(c), r.id);
      const part = await stat(p.part).then((s) => s.size, () => 0);
      return { resourceId: r.id, state: part > 0 ? 'paused' : 'not_started', bytes: part, size: r.size } satisfies FileState;
    }));
  }

  /** Seed files completed earlier (e.g. before an app restart) when peer assistance is on. */
  private async offerCompleted(c: Conn, r: ResourceView, path: string) {
    const key = `${c.sessionId}:${r.id}`;
    if (!this.peerAssist.get(c.sessionId) || this.offeredCompleted.has(key)) return;
    this.offeredCompleted.add(key);
    try {
      const route = this.route(c);
      const m = await api<SignedManifest>(route.transport, route.url, c.token, `/api/resources/${r.id}/manifest`);
      const reader = await completedFileReader(path, m.payload);
      this.agent(c).offer(m, { read: (i) => reader.read(i), have: reader.have });
    } catch { this.offeredCompleted.delete(key); }
  }

  /** `hostOnly`: files sent to one person (and chat attachments) come straight from the host — peers never hold them. */
  download(c: Conn, r: ResourceView, hostOnly = false) {
    const cur = this.jobs.get(r.id);
    if (cur && ['queued', 'downloading', 'verifying'].includes(cur.state.state)) return;
    const job: Job = { conn: c, resource: r, hostOnly: hostOnly || !!r.direct, state: { resourceId: r.id, state: 'queued', bytes: cur?.state.bytes ?? 0, size: r.size } };
    this.jobs.set(r.id, job);
    this.emit(job.state);
    this.pump();
  }

  pause(resourceId: string) {
    const job = this.jobs.get(resourceId);
    if (!job) return;
    job.ctl?.abort();
    this.set(job, { state: 'paused' });
  }

  private pump() {
    const running = [...this.jobs.values()].filter((j) => j.state.state === 'downloading' || j.state.state === 'verifying').length;
    const next = [...this.jobs.values()].find((j) => j.state.state === 'queued');
    if (!next || running >= CONCURRENCY) return;
    void this.run(next).finally(() => this.pump());
    this.pump();
  }

  private async run(job: Job) {
    const ctl = new AbortController();
    job.ctl = ctl;
    this.set(job, { state: 'downloading', error: undefined });
    try {
      const agent = this.agent(job.conn);
      const key = `${job.conn.sessionId}:${job.resource.id}`;
      const cached = this.cache.get(key) ?? {};
      const peers = new Set<string>();
      let teacher = false;
      const out = await agent.acquire(job.resource, {
        peerAssist: !job.hostOnly && (this.peerAssist.get(job.conn.sessionId) ?? false), signal: ctl.signal,
        cachedManifest: cached.manifest, cachedSources: cached.sources,
        onSources: (src) => { this.cache.set(key, { ...this.cache.get(key), sources: src }); },
        onProgress: (p) => {
          for (const s of p.sources ?? []) if (s === 'teacher') teacher = true; else peers.add(s);
          this.set(job, { state: p.state, bytes: p.bytes, resumedFrom: p.resumedFrom || undefined, via: via(teacher, peers.size) });
        },
      });
      if (out.manifest) this.cache.set(key, { ...this.cache.get(key), manifest: out.manifest });
      this.offeredCompleted.add(key);
      const done = await this.completed();
      done[`${job.conn.sessionId}:${job.resource.id}`] = { path: out.path, sha256: job.resource.sha256! };
      await writeFile(this.completedPath(), JSON.stringify(done));
      this.set(job, {
        state: 'completed', bytes: job.resource.size, canOpen: canOpen(out.path),
        via: out.stats.mode === 'swarm' ? `${via(out.stats.teacherBytes > 0, out.stats.sources.filter((x) => x.kind === 'peer' && x.chunks > 0).length)} · teacher-signed ✓` : 'teacher',
      });
    } catch (e) {
      if (ctl.signal.aborted) return this.set(job, { state: 'paused' });
      this.set(job, { state: 'failed', error: (e as Error).message });
    }
  }

  private async pathOf(c: Pick<Conn, 'sessionId'>, resourceId: string) {
    const d = (await this.completed())[`${c.sessionId}:${resourceId}`];
    if (!d || !(await exists(d.path))) throw new Error('File not found. Download it again.');
    return d.path;
  }
  async show(c: Pick<Conn, 'sessionId'>, resourceId: string) { shell.showItemInFolder(await this.pathOf(c, resourceId)); }
  private async verified(c: Pick<Conn, 'sessionId'>, resourceId: string) {
    const hosted = this.hostFile(c.sessionId, resourceId);
    if (hosted) {
      if ((await sha256File(hosted.path)) !== hosted.sha256) throw new Error('The hosted file failed verification.');
      return hosted;
    }
    const p = await this.pathOf(c, resourceId);
    const d = (await this.completed())[`${c.sessionId}:${resourceId}`]!;
    if ((await sha256File(p)) !== d.sha256) throw new Error('This file changed after download. Download it again before opening or saving it.');
    return { path: p, name: basename(p), sha256: d.sha256 };
  }
  async preview(c: Pick<Conn, 'sessionId'>, id: string): Promise<FilePreview> {
    const { path, name } = await this.verified(c, id), kind = previewKind(name), size = (await stat(path)).size;
    if (kind === 'text' && size <= TEXT_PREVIEW_BYTES) {
      const text = await readFile(path, 'utf8');
      if (!text.includes('\0')) return { kind: 'text', text };
    }
    if (kind === 'image' && size <= IMAGE_PREVIEW_BYTES) {
      const bytes = await readFile(path), mime = previewImageMime(bytes);
      if (mime) return { kind: 'image', uri: `data:${mime};base64,${bytes.toString('base64')}` };
    }
    return { kind: 'metadata', reason: 'No embedded preview for this file or size. Use a viewer or save a copy.' };
  }
  async save(c: Pick<Conn, 'sessionId'>, id: string) {
    const file = await this.verified(c, id), win = this.win();
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, { title: 'Save a verified copy', defaultPath: file.name });
    if (result.canceled || !result.filePath) return null;
    await copyFile(file.path, result.filePath, constants.COPYFILE_EXCL);
    if ((await sha256File(result.filePath)) !== file.sha256) { await rm(result.filePath, { force: true }); throw new Error('The file changed while saving. No copy was kept.'); }
    return { name: basename(result.filePath) };
  }
  async openWith(c: Pick<Conn, 'sessionId'>, id: string) {
    const { path, name } = await this.verified(c, id);
    if (!canOpen(name)) throw new Error('This file type can contain code. Save it or show it in its folder.');
    if (process.platform === 'win32') {
      await windowsOpenWith(path);
    } else if (process.platform === 'darwin') {
      const win = this.win(); if (!win) return;
      const selected = await dialog.showOpenDialog(win, { title: 'Choose a viewer application', defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }] });
      if (selected.canceled) return;
      const viewer = selected.filePaths[0];
      if (!viewer || extname(viewer).toLowerCase() !== '.app' || !(await stat(viewer)).isDirectory()) throw new Error('Choose an installed application.');
      await promisify(execFile)('/usr/bin/open', ['-a', viewer, path]);
    } else await this.open(c, id);
  }
  async open(c: Pick<Conn, 'sessionId'>, resourceId: string) {
    const { path: p } = await this.verified(c, resourceId);
    if (!canOpen(p)) throw new Error('This type of file is not opened directly (it can contain macros or run code). Use Show in folder.');
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  }

  /** Member sharing files (dropped/picked paths, resolved in main): the whole CLAN ('clan') or one CLANmate (handle). */
  async share(c: Conn, paths: string[], to: string): Promise<ShareResult[]> {
    const route = this.route(c);
    const out: ShareResult[] = [];
    for (const path of paths) {
      const st = await stat(path);
      if (!st.isFile()) throw new Error('Only files can be sent.');
      // Same file to the same place: same key, so a retry (or a crash-restart) can never create a second copy.
      const pending = await json<Record<string, string>>(this.pendingPath(), {});
      const k = `share:${c.sessionId}:${to}:${path}:${st.size}:${st.mtimeMs}`;
      pending[k] ??= randomUUID();
      await writeFile(this.pendingPath(), JSON.stringify(pending));
      out.push(await uploadShareResult({ transport: route.transport, url: route.url, token: c.token, path, to, idempotencyKey: pending[k]!,
        onProgress: (sent, size) => this.win()?.webContents.send('chat:upload', { sent, size, name: path.split(/[\\/]/).pop() }) }));
      delete pending[k];
      await writeFile(this.pendingPath(), JSON.stringify(pending));
    }
    return out;
  }

  // ---- submissions ----
  async pick(e: IpcMainInvokeEvent, allowed: string[]) {
    const win = this.win();
    const opts = { properties: ['openFile' as const], filters: allowed.length ? [{ name: 'Allowed files', extensions: allowed }] : [] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    void e;
    const path = r.filePaths[0];
    if (r.canceled || !path) return null;
    const st = await stat(path);
    if (!st.isFile()) throw new Error('Choose a file.');
    const pickId = randomUUID();
    const name = path.split(/[\\/]/).pop()!;
    this.picks.set(pickId, { path, name, size: st.size });
    return { pickId, name, size: st.size };
  }

  private pendingPath() { return join(this.dataDir, 'pending-uploads.json'); }
  private receiptsDir() { return join(this.dataDir, 'receipts'); }

  async submit(c: Conn, assignmentId: string, pickId: string): Promise<StoredReceipt> {
    const pick = this.picks.get(pickId);
    if (!pick) throw new Error('Choose the file again.');
    // The same intended submission (same class, assignment, file and size) reuses its idempotency key, even across
    // app restarts, so a retry can never create a duplicate.
    const pending = await json<Record<string, string>>(this.pendingPath(), {});
    const k = `${c.sessionId}:${assignmentId}:${pick.path}:${pick.size}`;
    pending[k] ??= randomUUID();
    await writeFile(this.pendingPath(), JSON.stringify(pending));
    const route = this.route(c);
    const receipt = await uploadSubmission({
      transport: route.transport, url: route.url, token: c.token, assignmentId, path: pick.path, fileName: pick.name, idempotencyKey: pending[k]!,
      onProgress: (sent, size) => this.win()?.webContents.send('student:upload', { assignmentId, sent, size }),
    });
    await mkdir(this.receiptsDir(), { recursive: true });
    // Kept even if verification fails (it is evidence), but never presented as verified.
    await writeFile(join(this.receiptsDir(), `${receipt.payload.submissionId}.json`), JSON.stringify(receipt, null, 2), { flag: 'w' });
    delete pending[k];
    await writeFile(this.pendingPath(), JSON.stringify(pending));
    this.picks.delete(pickId);
    return this.check(receipt, route.binding.teacherPublicKey);
  }

  /** Verified only against a teacher key this device learned through a PAKE-authenticated pairing. */
  check(receipt: Receipt, expectedTeacherKey?: string): StoredReceipt {
    const anchors = this.trust.pairedTeacherKeys();
    const key = expectedTeacherKey ?? (anchors.has(receipt.teacherPublicKey) ? receipt.teacherPublicKey : undefined);
    if (!key) return { receipt, verified: false, reason: 'signed by a teacher key this device never paired with' };
    const r = verifyReceipt(receipt, { trustedTeacherKey: key });
    return r.ok ? { receipt, verified: true } : { receipt, verified: false, reason: r.reason };
  }

  /** Locally stored receipts (durable, independent of the teacher). */
  async receipts(sessionId?: string): Promise<StoredReceipt[]> {
    const files = await readdir(this.receiptsDir()).catch(() => [] as string[]);
    const all = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => json<Receipt | null>(join(this.receiptsDir(), f), null)));
    return all.filter((r): r is Receipt => !!r?.payload && (!sessionId || r.payload.sessionId === sessionId))
      .map((r) => this.check(r)).sort((a, b) => b.receipt.payload.submittedAt - a.receipt.payload.submittedAt);
  }
}

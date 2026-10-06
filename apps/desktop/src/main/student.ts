// Student-side file transfers for the desktop app. Lives in the main process because it touches the filesystem.
// The renderer only ever passes opaque ids (resource ids, pick ids); it can never name a local path.
import { app, dialog, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { downloadResource, partPaths, uploadSubmission } from '@classroom/client/node';
import { safeFileName, type Receipt, type ResourceView } from '@classroom/protocol';
import type { FileState } from '../shared.ts';

type Conn = { url: string; token: string; sessionId: string; classTitle: string };
type Job = { conn: Conn; resource: ResourceView; ctl?: AbortController; state: FileState };

// Formats that are opened by viewer apps, never executed. Everything else is "show in folder" only.
const SAFE_TO_OPEN = new Set(['pdf', 'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'odp', 'ods', 'rtf']);
const CONCURRENCY = 2;

const json = <T>(p: string, fallback: T): Promise<T> => readFile(p, 'utf8').then(JSON.parse, () => fallback);
const exists = (p: string) => access(p).then(() => true, () => false);

export class StudentFiles {
  private jobs = new Map<string, Job>();
  private picks = new Map<string, { path: string; name: string; size: number }>();
  private win: () => BrowserWindow | undefined;
  private dataDir = app.getPath('userData');

  constructor(win: () => BrowserWindow | undefined) { this.win = win; }

  private destDir(c: Conn) {
    const root = process.env.CLASSROOM_DOWNLOADS_DIR ?? join(app.getPath('downloads'), 'Classroom LAN');
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
      if (d && d.sha256 === r.sha256 && (await exists(d.path))) return { resourceId: r.id, state: 'completed', bytes: r.size, size: r.size, canOpen: SAFE_TO_OPEN.has(extname(d.path).slice(1).toLowerCase()) } satisfies FileState;
      const p = partPaths(this.destDir(c), r.id);
      const part = await stat(p.part).then((s) => s.size, () => 0);
      return { resourceId: r.id, state: part > 0 ? 'paused' : 'not_started', bytes: part, size: r.size } satisfies FileState;
    }));
  }

  download(c: Conn, r: ResourceView) {
    const cur = this.jobs.get(r.id);
    if (cur && ['queued', 'downloading', 'verifying'].includes(cur.state.state)) return;
    const job: Job = { conn: c, resource: r, state: { resourceId: r.id, state: 'queued', bytes: cur?.state.bytes ?? 0, size: r.size } };
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
      const out = await downloadResource({
        url: job.conn.url, token: job.conn.token, resource: job.resource, destDir: this.destDir(job.conn), signal: ctl.signal,
        onProgress: (p) => this.set(job, { state: p.state, bytes: p.bytes, resumedFrom: p.resumedFrom || undefined }),
      });
      const done = await this.completed();
      done[`${job.conn.sessionId}:${job.resource.id}`] = { path: out.path, sha256: job.resource.sha256! };
      await writeFile(this.completedPath(), JSON.stringify(done));
      this.set(job, { state: 'completed', bytes: job.resource.size, canOpen: SAFE_TO_OPEN.has(extname(out.path).slice(1).toLowerCase()) });
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
  async open(c: Pick<Conn, 'sessionId'>, resourceId: string) {
    const p = await this.pathOf(c, resourceId);
    if (!SAFE_TO_OPEN.has(extname(p).slice(1).toLowerCase())) throw new Error('This type of file is not opened automatically. Use Show in folder.');
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
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

  async submit(c: Conn, assignmentId: string, pickId: string): Promise<Receipt> {
    const pick = this.picks.get(pickId);
    if (!pick) throw new Error('Choose the file again.');
    // The same intended submission (same class, assignment, file and size) reuses its idempotency key, even across
    // app restarts, so a retry can never create a duplicate.
    const pending = await json<Record<string, string>>(this.pendingPath(), {});
    const k = `${c.sessionId}:${assignmentId}:${pick.path}:${pick.size}`;
    pending[k] ??= randomUUID();
    await writeFile(this.pendingPath(), JSON.stringify(pending));
    const receipt = await uploadSubmission({
      url: c.url, token: c.token, assignmentId, path: pick.path, fileName: pick.name, idempotencyKey: pending[k]!,
      onProgress: (sent, size) => this.win()?.webContents.send('student:upload', { assignmentId, sent, size }),
    });
    await mkdir(this.receiptsDir(), { recursive: true });
    await writeFile(join(this.receiptsDir(), `${receipt.submissionId}.json`), JSON.stringify(receipt, null, 2), { flag: 'w' });
    delete pending[k];
    await writeFile(this.pendingPath(), JSON.stringify(pending));
    this.picks.delete(pickId);
    return receipt;
  }

  /** Locally stored receipts (durable, independent of the teacher). */
  async receipts(sessionId?: string): Promise<Receipt[]> {
    const files = await readdir(this.receiptsDir()).catch(() => [] as string[]);
    const all = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => json<Receipt | null>(join(this.receiptsDir(), f), null)));
    return all.filter((r): r is Receipt => !!r && (!sessionId || r.sessionId === sessionId)).sort((a, b) => b.submittedAt - a.submittedAt);
  }
}

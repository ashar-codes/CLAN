import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { extensionOf, safeFileName, TransferState, type ResourceView, type StudentTransfer, type TeacherResourceView, type TransferStats } from '@classroom/protocol';
import type { Classroom, Principal } from './classroom.ts';
import type { Db } from './db.ts';
import { ApiError, mimeFor, type Limits, type Storage } from './storage.ts';

type Row = {
  id: string; original_name: string; safe_name: string; mime: string; size: number; sha256: string | null;
  added_at: number; status: 'importing' | 'ready' | 'failed' | 'removed'; available: number; pushed: number;
};

const view = (r: Row): ResourceView => ({
  id: r.id, name: r.safe_name, size: r.size, sha256: r.sha256, mime: r.mime, addedAt: r.added_at,
  status: r.status as ResourceView['status'], available: !!r.available, pushed: !!r.pushed,
});

/**
 * Classroom files. Bytes live in managed storage under `resources/<uuid>`; the original name is metadata only.
 * Emits 'changed' (list/transfer state changed), 'push' (resourceId), 'progress' (resourceId, bytes, size).
 */
export class Resources extends EventEmitter {
  private db: Db; private classroom: Classroom; private storage: Storage; private limits: Limits;
  private active = new Map<string, number>(); // memberId|teacher -> open downloads
  private activeTotal = 0;
  private served = 0;
  private failed = 0;
  private window: { t: number; bytes: number }[] = [];

  constructor(db: Db, classroom: Classroom, storage: Storage, limits: Limits) {
    super();
    this.db = db; this.classroom = classroom; this.storage = storage; this.limits = limits;
  }

  /** Teacher-only, in-process: copy a local file into managed storage while hashing it. */
  async importFile(src: string, displayName = basename(src)): Promise<ResourceView> {
    const st = await stat(src);
    if (!st.isFile()) throw new ApiError(400, 'not_a_file', 'Only regular files can be added.');
    const count = (this.db.prepare("SELECT count(*) n FROM resources WHERE session_id = ? AND status != 'removed'").get(this.classroom.id) as { n: number }).n;
    if (count >= this.limits.maxResourcesPerSession) throw new ApiError(429, 'too_many', 'This class has too many files.');
    await this.storage.ensureSpace(st.size, this.limits.diskReserveBytes);

    const id = randomUUID();
    const original = displayName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'file';
    const safe = safeFileName(original);
    this.db.prepare("INSERT INTO resources (id, session_id, original_name, safe_name, mime, size, added_at, status) VALUES (?,?,?,?,?,?,?, 'importing')")
      .run(id, this.classroom.id, original, safe, mimeFor(extensionOf(safe)), st.size, Date.now());
    this.emit('changed');

    const part = this.storage.tmp(id);
    const hash = createHash('sha256');
    let done = 0, lastEmit = 0;
    try {
      await pipeline(
        createReadStream(src),
        new Transform({
          transform: (chunk: Buffer, _e, cb) => {
            hash.update(chunk);
            done += chunk.length;
            if (Date.now() - lastEmit > 100) { lastEmit = Date.now(); this.emit('progress', id, done, st.size); }
            cb(null, chunk);
          },
        }),
        createWriteStream(part, { flags: 'wx' }),
      );
      if (done !== st.size) throw new ApiError(409, 'changed', 'The file changed while it was being added. Try again.');
      await rename(part, this.storage.resource(id));
    } catch (e) {
      await rm(part, { force: true });
      this.db.prepare("UPDATE resources SET status = 'failed' WHERE id = ?").run(id);
      this.emit('changed');
      throw e;
    }
    this.db.prepare("UPDATE resources SET status = 'ready', sha256 = ?, size = ? WHERE id = ?").run(hash.digest('hex'), done, id);
    this.emit('progress', id, done, done);
    this.classroom.log('resource.added', null, { resourceId: id, name: safe, size: done });
    this.emit('changed');
    return view(this.row(id)!);
  }

  private row(id: string) {
    return this.db.prepare('SELECT * FROM resources WHERE id = ? AND session_id = ?').get(id, this.classroom.id) as Row | undefined;
  }

  private mustRow(id: string) {
    const r = this.row(id);
    if (!r || r.status === 'removed') throw new ApiError(404, 'not_found', 'No such file in this class.');
    return r;
  }

  /** Students only see ready + available files. */
  listForStudent(): ResourceView[] {
    return (this.db.prepare("SELECT * FROM resources WHERE session_id = ? AND status = 'ready' AND available = 1 ORDER BY added_at").all(this.classroom.id) as Row[]).map(view);
  }

  listForTeacher(): TeacherResourceView[] {
    const rows = this.db.prepare("SELECT * FROM resources WHERE session_id = ? AND status IN ('importing','ready','failed') ORDER BY added_at").all(this.classroom.id) as Row[];
    const members = this.classroom.roster().filter((m) => m.status === 'approved');
    const tr = this.db.prepare(`SELECT t.resource_id, t.member_id, t.state, t.bytes, t.updated_at FROM transfers t JOIN resources r ON r.id = t.resource_id WHERE r.session_id = ?`)
      .all(this.classroom.id) as { resource_id: string; member_id: string; state: TransferState; bytes: number; updated_at: number }[];
    const byKey = new Map(tr.map((t) => [`${t.resource_id}:${t.member_id}`, t]));
    return rows.map((r) => {
      const counts = Object.fromEntries(TransferState.options.map((s) => [s, 0])) as Record<TransferState, number>;
      const students: StudentTransfer[] = members.map((m) => {
        const t = byKey.get(`${r.id}:${m.id}`);
        const st: StudentTransfer = { memberId: m.id, fullName: m.fullName, state: t?.state ?? 'not_started', bytes: t?.bytes ?? 0, updatedAt: t?.updated_at ?? null };
        counts[st.state]++;
        return st;
      });
      return { ...view(r), counts, students };
    });
  }

  setAvailable(id: string, available: boolean) {
    const r = this.mustRow(id);
    this.db.prepare('UPDATE resources SET available = ?, pushed = CASE WHEN ? THEN pushed ELSE 0 END WHERE id = ?').run(available ? 1 : 0, available ? 1 : 0, r.id);
    this.classroom.log(available ? 'resource.shown' : 'resource.hidden', null, { resourceId: id, name: r.safe_name });
    this.emit('changed');
  }

  /** Marks a download instruction for every approved student; they fetch through the normal endpoint. */
  push(id: string) {
    const r = this.mustRow(id);
    if (r.status !== 'ready') throw new ApiError(409, 'not_ready', 'The file is still being added.');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE resources SET available = 1, pushed = 1 WHERE id = ?').run(id);
      const up = this.db.prepare(`INSERT INTO transfers (resource_id, member_id, state, bytes, updated_at) VALUES (?, ?, 'queued', 0, ?)
        ON CONFLICT (resource_id, member_id) DO UPDATE SET state = 'queued', updated_at = excluded.updated_at WHERE transfers.state IN ('not_started','failed')`);
      for (const m of this.classroom.roster()) if (m.status === 'approved') up.run(id, m.id, now);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.classroom.log('resource.pushed', null, { resourceId: id, name: r.safe_name });
    this.emit('push', id);
    this.emit('changed');
  }

  /** Withdraws the file from the class and deletes the managed copy. Students' own copies are untouched. */
  async remove(id: string) {
    const r = this.mustRow(id);
    this.db.prepare("UPDATE resources SET status = 'removed', removed_at = ? WHERE id = ?").run(Date.now(), r.id);
    this.classroom.log('resource.removed', null, { resourceId: id, name: r.safe_name });
    this.emit('changed');
    // Path comes from the validated UUID, never from metadata. On Windows an open download may hold the file;
    // the startup sweep retries.
    await rm(this.storage.resource(r.id), { force: true }).catch(() => {});
  }

  /** Authorize + locate a download. Same 404 for missing, other-class and hidden: no enumeration oracle. */
  openForDownload(p: Principal, id: string) {
    const r = this.row(id);
    if (!r || r.status !== 'ready' || (p.role === 'student' && !r.available)) throw new ApiError(404, 'not_found', 'No such file in this class.');
    return { path: this.storage.resource(r.id), size: r.size, sha256: r.sha256!, name: r.safe_name };
  }

  report(memberId: string, resourceId: string, state: TransferState, bytes: number) {
    const r = this.row(resourceId);
    if (!r || r.status !== 'ready' || !r.available) return;
    this.db.prepare(`INSERT INTO transfers (resource_id, member_id, state, bytes, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT (resource_id, member_id) DO UPDATE SET state = excluded.state, bytes = excluded.bytes, updated_at = excluded.updated_at`)
      .run(resourceId, memberId, state, Math.min(bytes, r.size), Date.now());
    this.emit('changed');
  }

  // ---- live transfer accounting ----
  begin(key: string) {
    const n = this.active.get(key) ?? 0;
    if (this.activeTotal >= this.limits.maxDownloadsTotal || n >= this.limits.maxDownloadsPerMember) return false;
    this.active.set(key, n + 1);
    this.activeTotal++;
    return true;
  }
  end(key: string, ok: boolean) {
    const n = (this.active.get(key) ?? 1) - 1;
    if (n <= 0) this.active.delete(key); else this.active.set(key, n);
    this.activeTotal--;
    if (!ok) this.failed++;
  }
  count(bytes: number) {
    this.served += bytes;
    const t = Math.floor(Date.now() / 1000);
    const last = this.window[this.window.length - 1];
    if (last?.t === t) last.bytes += bytes; else this.window.push({ t, bytes });
    while (this.window.length && this.window[0]!.t < t - 5) this.window.shift();
  }
  stats(activeUploads: number): TransferStats {
    const t = Math.floor(Date.now() / 1000);
    const recent = this.window.filter((w) => w.t >= t - 5 && w.t < t);
    return {
      activeDownloads: this.activeTotal, activeUploads,
      bytesPerSec: recent.reduce((a, w) => a + w.bytes, 0) / 5,
      servedBytes: this.served, failedDownloads: this.failed,
    };
  }

  /** Startup: delete bytes for removed resources (e.g. a Windows file lock prevented it earlier). */
  async sweepRemoved() {
    const rows = this.db.prepare("SELECT id FROM resources WHERE status = 'removed'").all() as { id: string }[];
    for (const r of rows) await rm(this.storage.resource(r.id), { force: true }).catch(() => {});
    this.db.prepare("UPDATE resources SET status = 'failed' WHERE status = 'importing'").run();
  }
}

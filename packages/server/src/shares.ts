// Members sharing files: the same resumable, idempotent upload protocol as submissions (init → PUT at Upload-Offset →
// verify size + SHA-256), then the bytes become an ordinary CLAN resource — for the whole CLAN ('clan', the table) or for
// one CLANmate (audience = sender + recipient handles). Peers, manifests and downloads then work exactly as for host files.
import { randomUUID } from 'node:crypto';
import { rm, truncate } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { ShareUploadInit, ShareUploadStatus } from '@classroom/protocol';
import type { Classroom } from './classroom.ts';
import type { Db } from './db.ts';
import type { Resources } from './resources.ts';
import { ApiError, appendBody, hashFile, sizeOf, type Limits, type Storage } from './storage.ts';

type Row = { id: string; member_id: string; idempotency_key: string; file_name: string; size: number; sha256: string; target: string; state: ShareUploadStatus['state']; error: string | null; resource_id: string | null };

export class Shares {
  private writing = new Map<string, string>();
  private db: Db; private classroom: Classroom; private storage: Storage; private limits: Limits; private resources: Resources;
  /** Resolves the audience for a target: 'clan' → null, a handle → [sender, recipient] (throws if not allowed). */
  audience: (memberId: string, target: string) => string[] | null = () => { throw new ApiError(503, 'chat_unavailable', 'Sending to one person is not available here.'); };
  senderHandle: (memberId: string) => string | null = () => null;

  constructor(db: Db, classroom: Classroom, storage: Storage, limits: Limits, resources: Resources) {
    this.db = db; this.classroom = classroom; this.storage = storage; this.limits = limits; this.resources = resources;
  }
  get active() { return this.writing.size; }

  private must(memberId: string, id: string) {
    const r = this.db.prepare('SELECT * FROM share_uploads WHERE id = ? AND member_id = ? AND session_id = ?').get(id, memberId, this.classroom.id) as Row | undefined;
    if (!r) throw new ApiError(404, 'not_found', 'No such upload.');
    return r;
  }

  async init(memberId: string, req: ShareUploadInit): Promise<ShareUploadStatus> {
    const prev = this.db.prepare('SELECT * FROM share_uploads WHERE member_id = ? AND idempotency_key = ?').get(memberId, req.idempotencyKey) as Row | undefined;
    if (prev) {
      if (prev.file_name !== req.fileName || prev.size !== req.size || prev.sha256 !== req.sha256 || prev.target !== req.to) throw new ApiError(409, 'key_reused', 'This upload key was already used for a different file.');
      if (prev.state === 'failed') { await rm(this.storage.tmp(prev.id), { force: true }); this.db.prepare("UPDATE share_uploads SET state = 'uploading', error = NULL WHERE id = ?").run(prev.id); }
      return this.status(memberId, prev.id);
    }
    this.audience(memberId, req.to); // authorization before any bytes
    if (req.size > this.limits.maxSubmissionBytes) throw new ApiError(413, 'too_large', 'That file is too large to share.');
    const pending = (this.db.prepare("SELECT count(*) n FROM share_uploads WHERE member_id = ? AND state = 'uploading'").get(memberId) as { n: number }).n;
    if (pending >= this.limits.maxPendingUploadsPerMember) throw new ApiError(429, 'too_many_pending', 'Finish your other uploads first.');
    await this.storage.ensureSpace(req.size, this.limits.diskReserveBytes);
    const id = randomUUID(), t = Date.now();
    this.db.prepare("INSERT INTO share_uploads (id, session_id, member_id, idempotency_key, file_name, size, sha256, target, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'uploading', ?, ?)")
      .run(id, this.classroom.id, memberId, req.idempotencyKey, req.fileName, req.size, req.sha256, req.to, t, t);
    return this.status(memberId, id);
  }

  async status(memberId: string, id: string): Promise<ShareUploadStatus> {
    const u = this.must(memberId, id);
    const offset = u.state === 'complete' ? u.size : await sizeOf(this.storage.tmp(u.id));
    const resource = u.resource_id ? this.resources.listForStudent({ role: 'student', memberId }).find((r) => r.id === u.resource_id) ?? null : null;
    return { uploadId: u.id, offset, size: u.size, state: u.state, error: u.error, resource };
  }

  async append(memberId: string, id: string, offset: number, body: Readable, onChunk?: () => void): Promise<ShareUploadStatus> {
    const u = this.must(memberId, id);
    if (u.state === 'complete') { body.resume(); return this.status(memberId, id); }
    if (u.state === 'failed') throw new ApiError(409, 'failed', u.error ?? 'Upload failed; start again.');
    if (this.writing.has(id)) throw new ApiError(409, 'busy', 'This upload is already in progress.');
    if (this.writing.size >= this.limits.maxUploadsTotal || [...this.writing.values()].filter((m) => m === memberId).length >= this.limits.maxUploadsPerMember) throw new ApiError(429, 'busy', 'Too many uploads right now. Retrying shortly.');
    const part = this.storage.tmp(id);
    let have = await sizeOf(part);
    if (offset === 0 && have > 0) { await truncate(part, 0); have = 0; }
    if (offset !== have) throw new ApiError(409, 'offset_mismatch', 'Upload offset does not match.', { offset: have });
    this.writing.set(id, memberId);
    try {
      let received: number | null;
      try { received = await appendBody(part, u.size - have, body, onChunk); } catch (e) { await this.fail(id, (e as Error).message); throw e; }
      if (received === null || have + received < u.size) return await this.status(memberId, id);
      if ((await hashFile(part)) !== u.sha256 || (await sizeOf(part)) !== u.size) {
        await this.fail(id, 'The file arrived damaged (checksum mismatch). Please send it again.');
        throw new ApiError(422, 'hash_mismatch', 'The file arrived damaged (checksum mismatch). Please send it again.');
      }
      const r = await this.resources.importFile(part, u.file_name, { audience: this.audience(memberId, u.target), sharedBy: this.senderHandle(memberId), owner: memberId });
      await rm(part, { force: true });
      this.db.prepare("UPDATE share_uploads SET state = 'complete', resource_id = ?, updated_at = ? WHERE id = ?").run(r.id, Date.now(), id);
      return await this.status(memberId, id);
    } finally { this.writing.delete(id); }
  }

  private async fail(id: string, error: string) {
    await rm(this.storage.tmp(id), { force: true });
    this.db.prepare("UPDATE share_uploads SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, Date.now(), id);
  }
}

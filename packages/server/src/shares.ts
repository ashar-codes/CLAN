// Members sharing files: the same resumable, idempotent upload protocol as submissions (init → PUT at Upload-Offset →
// verify size + SHA-256), then the bytes become an ordinary CLAN resource — for the whole CLAN ('clan', the table) or for
// one CLANmate (audience = sender + recipient handles). Peers, manifests and downloads then work exactly as for host files.
import { randomUUID } from 'node:crypto';
import { rm, truncate } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { PendingShare, ShareUploadInit, ShareUploadStatus } from '@classroom/protocol';
import type { Classroom, Principal } from './classroom.ts';
import type { Db } from './db.ts';
import type { Resources } from './resources.ts';
import { ApiError, appendBody, hashFile, sizeOf, type Limits, type Storage } from './storage.ts';

type Row = { id: string; member_id: string; idempotency_key: string; file_name: string; size: number; sha256: string; target: string; state: ShareUploadStatus['state']; error: string | null; resource_id: string | null; approval: ShareUploadStatus['approval'] | null };

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

  private approved(memberId: string) {
    if (this.classroom.info().ended || this.classroom.status(memberId) !== 'approved') throw new ApiError(403, 'forbidden', 'Only an approved member may share files.');
  }
  private host(p: Principal) {
    if (p.role !== 'teacher' || !this.classroom.can(p, 'MANAGE_PERMISSIONS')) throw new ApiError(403, 'forbidden', 'Only the host can review shared files.');
  }
  pending(p: Principal): PendingShare[] {
    this.host(p);
    return (this.db.prepare("SELECT u.id uploadId, m.full_name memberName, u.file_name fileName, u.size, u.target FROM share_uploads u JOIN members m ON m.id = u.member_id WHERE u.session_id = ? AND u.approval = 'pending' ORDER BY u.created_at").all(this.classroom.id)) as PendingShare[];
  }

  private must(memberId: string, id: string) {
    const r = this.db.prepare('SELECT * FROM share_uploads WHERE id = ? AND member_id = ? AND session_id = ?').get(id, memberId, this.classroom.id) as Row | undefined;
    if (!r) throw new ApiError(404, 'not_found', 'No such upload.');
    return r;
  }

  async init(memberId: string, req: ShareUploadInit): Promise<ShareUploadStatus> {
    this.approved(memberId);
    this.audience(memberId, req.to); // recheck permissions even when resuming an existing key
    const prev = this.db.prepare('SELECT * FROM share_uploads WHERE member_id = ? AND idempotency_key = ?').get(memberId, req.idempotencyKey) as Row | undefined;
    if (prev) {
      if (prev.file_name !== req.fileName || prev.size !== req.size || prev.sha256 !== req.sha256 || prev.target !== req.to) throw new ApiError(409, 'key_reused', 'This upload key was already used for a different file.');
      if (prev.approval === 'rejected') return this.status(memberId, prev.id);
      if (prev.state === 'failed') { await rm(this.storage.tmp(prev.id), { force: true }); this.db.prepare("UPDATE share_uploads SET state = 'uploading', error = NULL WHERE id = ?").run(prev.id); }
      return this.status(memberId, prev.id);
    }
    if (req.size > this.limits.maxSubmissionBytes) throw new ApiError(413, 'too_large', 'That file is too large to share.');
    const pending = (this.db.prepare("SELECT count(*) n FROM share_uploads WHERE member_id = ? AND (state = 'uploading' OR approval = 'pending')").get(memberId) as { n: number }).n;
    if (pending >= this.limits.maxPendingUploadsPerMember) throw new ApiError(429, 'too_many_pending', 'Finish your other uploads first.');
    const total = (this.db.prepare("SELECT count(*) n FROM share_uploads WHERE session_id = ? AND (state = 'uploading' OR approval = 'pending')").get(this.classroom.id) as { n: number }).n;
    if (total >= this.limits.maxResourcesPerSession) throw new ApiError(429, 'too_many_pending', 'The host needs to review pending files first.');
    await this.storage.ensureSpace(req.size, this.limits.diskReserveBytes);
    // The space check yields: another request may have consumed a slot or changed authority meanwhile.
    this.approved(memberId);
    this.audience(memberId, req.to);
    const raced = this.db.prepare('SELECT id FROM share_uploads WHERE member_id = ? AND idempotency_key = ?').get(memberId, req.idempotencyKey);
    if (raced) return this.init(memberId, req);
    const remaining = (this.db.prepare("SELECT count(*) n FROM share_uploads WHERE member_id = ? AND (state = 'uploading' OR approval = 'pending')").get(memberId) as { n: number }).n;
    const sessionPending = (this.db.prepare("SELECT count(*) n FROM share_uploads WHERE session_id = ? AND (state = 'uploading' OR approval = 'pending')").get(this.classroom.id) as { n: number }).n;
    if (remaining >= this.limits.maxPendingUploadsPerMember || sessionPending >= this.limits.maxResourcesPerSession) throw new ApiError(429, 'too_many_pending', 'Finish or review pending files first.');
    const id = randomUUID(), t = Date.now();
    this.db.prepare("INSERT INTO share_uploads (id, session_id, member_id, idempotency_key, file_name, size, sha256, target, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'uploading', ?, ?)")
      .run(id, this.classroom.id, memberId, req.idempotencyKey, req.fileName, req.size, req.sha256, req.to, t, t);
    return this.status(memberId, id);
  }

  async status(memberId: string, id: string): Promise<ShareUploadStatus> {
    this.approved(memberId);
    const u = this.must(memberId, id);
    const offset = u.state === 'complete' ? u.size : await sizeOf(this.storage.tmp(u.id));
    const resource = u.resource_id ? this.resources.listForStudent({ role: 'student', memberId }).find((r) => r.id === u.resource_id) ?? null : null;
    return { uploadId: u.id, offset, size: u.size, state: u.state, error: u.error, resource, ...(u.approval ? { approval: u.approval } : {}) };
  }

  async append(memberId: string, id: string, offset: number, body: Readable, onChunk?: () => void): Promise<ShareUploadStatus> {
    this.approved(memberId);
    const existing = this.must(memberId, id);
    this.audience(memberId, existing.target);
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
      this.approved(memberId);
      this.audience(memberId, u.target);
      if (this.classroom.info().fileSharingPolicy === 'approval') {
        this.db.prepare("UPDATE share_uploads SET state = 'complete', approval = 'pending', updated_at = ? WHERE id = ?").run(Date.now(), id);
        this.classroom.log('share.requested', memberId, { uploadId: id });
      } else await this.publish(u, false);
      return await this.status(memberId, id);
    } finally { this.writing.delete(id); }
  }

  private async publish(u: Row, reviewed: boolean) {
    const validate = () => {
      this.approved(u.member_id);
      this.audience(u.member_id, u.target);
      if (!reviewed && this.classroom.info().fileSharingPolicy === 'approval') throw new ApiError(409, 'approval_required', 'The sharing rule changed; retry to request approval.');
    };
    validate();
    const r = await this.resources.importFile(this.storage.tmp(u.id), u.file_name, { audience: this.audience(u.member_id, u.target), sharedBy: this.senderHandle(u.member_id), owner: u.member_id, validate, expectedSha256: u.sha256 });
    this.db.prepare("UPDATE share_uploads SET state = 'complete', resource_id = ?, approval = ?, updated_at = ? WHERE id = ?").run(r.id, reviewed ? 'approved' : null, Date.now(), u.id);
    await rm(this.storage.tmp(u.id), { force: true });
  }

  async decide(p: Principal, id: string, accept: boolean): Promise<ShareUploadStatus> {
    this.host(p);
    const u = this.db.prepare('SELECT * FROM share_uploads WHERE id = ? AND session_id = ?').get(id, this.classroom.id) as Row | undefined;
    if (!u) throw new ApiError(404, 'not_found', 'No such pending upload.');
    if (this.writing.has(id)) throw new ApiError(409, 'busy', 'This upload is being reviewed.');
    if (u.approval === 'approved') return this.status(u.member_id, id);
    if (u.approval !== 'pending') throw new ApiError(409, 'not_pending', 'This upload is not pending review.');
    this.writing.set(id, u.member_id);
    try {
      if (!accept) {
        await this.fail(id, 'The teacher declined this file.');
        this.db.prepare("UPDATE share_uploads SET approval = 'rejected' WHERE id = ?").run(id);
        return { uploadId: id, offset: 0, size: u.size, state: 'failed', error: 'The teacher declined this file.', resource: null, approval: 'rejected' };
      }
      await this.publish(u, true);
      this.classroom.log('share.approved', u.member_id, { uploadId: id });
      return await this.status(u.member_id, id);
    } finally { this.writing.delete(id); }
  }

  private async fail(id: string, error: string) {
    await rm(this.storage.tmp(id), { force: true });
    this.db.prepare("UPDATE share_uploads SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, Date.now(), id);
  }
}

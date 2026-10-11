import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, rename, rm, truncate } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import {
  AssignmentInput, canonicalBytes, extensionOf, keyFingerprint, safeFileName, type ReceiptPayload,
  type AssignmentView, type Receipt, type StudentAssignmentView, type SubmissionState, type TeacherAssignmentView, type UploadInit, type UploadStatus,
} from '@classroom/protocol';
import type { Classroom } from './classroom.ts';
import type { Db } from './db.ts';
import { ApiError, appendBody, hashFile, sizeOf, type Limits, type Storage } from './storage.ts';

type ARow = { id: string; title: string; instructions: string; due_at: number | null; allowed_ext: string; max_bytes: number; mode: 'individual' | 'group'; created_at: number; closed_at: number | null };
type URow = { id: string; assignment_id: string; member_id: string; idempotency_key: string; file_name: string; size: number; sha256: string; state: UploadStatus['state']; error: string | null; submission_id: string | null; updated_at: number };
type SRow = { id: string; assignment_id: string; member_id: string; device_id: string; version: number; file_name: string; safe_name: string; stored_path: string; size: number; sha256: string; submitted_at: number; late: number; receipt: string | null };
/** Teacher application-identity signer (Ed25519). Distinct from the TLS key. */
export type ReceiptSigner = { publicKey: string; sign(bytes: Uint8Array): string };

const aview = (r: ARow): AssignmentView => ({
  id: r.id, title: r.title, instructions: r.instructions, dueAt: r.due_at, allowedExtensions: JSON.parse(r.allowed_ext),
  maxBytes: r.max_bytes, mode: r.mode, createdAt: r.created_at, closed: r.closed_at !== null,
});

/**
 * Assignments and resumable, idempotent submissions.
 * Upload model (tus-like): init -> PUT bytes at Upload-Offset (repeatable) -> server verifies size + SHA-256 ->
 * atomic rename into submissions/<session>/<submission>/<safe name> -> receipt. Emits 'changed'.
 */
export class Assignments extends EventEmitter {
  private db: Db; private classroom: Classroom; private storage: Storage; private limits: Limits;
  private now: () => number;
  private writing = new Map<string, string>(); // uploadId -> memberId while a PUT is streaming
  private signer: ReceiptSigner;

  constructor(db: Db, classroom: Classroom, storage: Storage, limits: Limits, signer: ReceiptSigner, now = Date.now) {
    super();
    this.db = db; this.classroom = classroom; this.storage = storage; this.limits = limits; this.signer = signer; this.now = now;
  }

  get activeUploads() { return this.writing.size; }

  create(input: unknown): AssignmentView {
    const a = AssignmentInput.parse(input);
    if (a.maxBytes > this.limits.maxSubmissionBytes) throw new ApiError(400, 'too_large', `Maximum allowed size is ${this.limits.maxSubmissionBytes} bytes.`);
    const n = (this.db.prepare('SELECT count(*) n FROM assignments WHERE session_id = ?').get(this.classroom.id) as { n: number }).n;
    if (n >= this.limits.maxAssignmentsPerSession) throw new ApiError(429, 'too_many', 'Too many assignments in this class.');
    const id = randomUUID();
    this.db.prepare('INSERT INTO assignments (id, session_id, title, instructions, due_at, allowed_ext, max_bytes, mode, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, this.classroom.id, a.title, a.instructions, a.dueAt, JSON.stringify([...new Set(a.allowedExtensions)]), a.maxBytes, a.mode, this.now());
    this.classroom.log('assignment.published', null, { assignmentId: id, title: a.title });
    this.emit('changed');
    return aview(this.mustAssignment(id));
  }

  close(id: string) {
    this.mustAssignment(id);
    this.db.prepare('UPDATE assignments SET closed_at = coalesce(closed_at, ?) WHERE id = ?').run(this.now(), id);
    this.classroom.log('assignment.closed', null, { assignmentId: id });
    this.emit('changed');
  }

  private mustAssignment(id: string) {
    const r = this.db.prepare('SELECT * FROM assignments WHERE id = ? AND session_id = ?').get(id, this.classroom.id) as ARow | undefined;
    if (!r) throw new ApiError(404, 'not_found', 'No such assignment in this class.');
    return r;
  }

  private mustUpload(memberId: string, uploadId: string) {
    const u = this.db.prepare('SELECT * FROM uploads WHERE id = ? AND member_id = ? AND session_id = ?').get(uploadId, memberId, this.classroom.id) as URow | undefined;
    if (!u) throw new ApiError(404, 'not_found', 'No such upload.');
    return u;
  }

  /** Start (or, with the same idempotency key, resume / re-fetch) a submission. */
  async init(memberId: string, req: UploadInit): Promise<UploadStatus> {
    const existing = this.db.prepare('SELECT * FROM uploads WHERE member_id = ? AND idempotency_key = ?').get(memberId, req.idempotencyKey) as URow | undefined;
    if (existing) {
      const same = existing.assignment_id === req.assignmentId && existing.file_name === req.fileName && existing.size === req.size && existing.sha256 === req.sha256;
      if (!same) throw new ApiError(409, 'key_reused', 'This submission attempt was already used for a different file.');
      if (existing.state === 'failed') {
        // Explicit retry of a failed attempt: start the bytes over.
        await rm(this.storage.tmp(existing.id), { force: true });
        this.db.prepare("UPDATE uploads SET state = 'uploading', error = NULL, updated_at = ? WHERE id = ?").run(this.now(), existing.id);
      }
      return this.status(memberId, existing.id);
    }

    const a = this.mustAssignment(req.assignmentId);
    if (a.closed_at !== null) throw new ApiError(409, 'closed', 'This assignment is closed.');
    if (a.mode === 'group') throw new ApiError(400, 'group_unsupported', 'Group submissions are not available yet.');
    const allowed = JSON.parse(a.allowed_ext) as string[];
    const ext = extensionOf(req.fileName);
    if (allowed.length && !allowed.includes(ext)) throw new ApiError(415, 'bad_type', `Allowed file types: ${allowed.map((e) => '.' + e).join(', ')}`);
    if (req.size > a.max_bytes) throw new ApiError(413, 'too_large', `This assignment accepts files up to ${a.max_bytes} bytes.`);
    const pending = (this.db.prepare("SELECT count(*) n FROM uploads WHERE member_id = ? AND state = 'uploading'").get(memberId) as { n: number }).n;
    if (pending >= this.limits.maxPendingUploadsPerMember) throw new ApiError(429, 'too_many_pending', 'Finish or cancel your other uploads first.');
    await this.storage.ensureSpace(req.size, this.limits.diskReserveBytes);

    const id = randomUUID();
    try {
      this.db.prepare("INSERT INTO uploads (id, session_id, assignment_id, member_id, idempotency_key, file_name, size, sha256, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'uploading', ?, ?)")
        .run(id, this.classroom.id, a.id, memberId, req.idempotencyKey, req.fileName, req.size, req.sha256, this.now(), this.now());
    } catch (e) {
      // Two concurrent inits with one key: the loser answers with the winner's upload.
      if (String(e).includes('UNIQUE')) return this.init(memberId, req);
      throw e;
    }
    this.emit('changed');
    return this.status(memberId, id);
  }

  async status(memberId: string, uploadId: string): Promise<UploadStatus> {
    const u = this.mustUpload(memberId, uploadId);
    const offset = u.state === 'complete' ? u.size : await sizeOf(this.storage.tmp(u.id));
    return { uploadId: u.id, offset, size: u.size, state: u.state, error: u.error, receipt: u.submission_id ? this.receipt(u.submission_id) : null };
  }

  /**
   * Append bytes at `offset`. offset must equal the bytes already received, or 0 to restart.
   * An interrupted stream keeps what arrived, so the client can resume from GET status.
   */
  async append(memberId: string, uploadId: string, offset: number, body: Readable, onChunk?: () => void): Promise<UploadStatus> {
    const u = this.mustUpload(memberId, uploadId);
    if (u.state === 'complete') { body.resume(); return this.status(memberId, uploadId); }
    if (u.state === 'failed') throw new ApiError(409, 'failed', u.error ?? 'Upload failed; start again.');
    if (this.writing.has(uploadId)) throw new ApiError(409, 'busy', 'This upload is already in progress.');
    const memberActive = [...this.writing.values()].filter((m) => m === memberId).length;
    if (this.writing.size >= this.limits.maxUploadsTotal || memberActive >= this.limits.maxUploadsPerMember) throw new ApiError(429, 'busy', 'Too many uploads right now. Retrying shortly.');

    const part = this.storage.tmp(uploadId);
    let have = await sizeOf(part);
    if (offset === 0 && have > 0) { await truncate(part, 0); have = 0; }
    if (offset !== have) throw new ApiError(409, 'offset_mismatch', 'Upload offset does not match.', { offset: have });

    this.writing.set(uploadId, memberId);
    this.emit('changed');
    try {
      let received: number | null;
      try { received = await appendBody(part, u.size - have, body, onChunk); } catch (e) {
        await this.fail(u.id, (e as Error).message); // overrun: declared size was a lie
        throw e;
      }
      if (received === null || have + received < u.size) return await this.status(memberId, uploadId); // disconnect: keep partial for resume
      // Still holding the `writing` lock, so a concurrent PUT can't finalize twice.
      return await this.finalize(u);
    } finally {
      this.writing.delete(uploadId);
      this.db.prepare('UPDATE uploads SET updated_at = ? WHERE id = ?').run(this.now(), uploadId);
      this.emit('changed');
    }
  }

  private async fail(uploadId: string, error: string) {
    await rm(this.storage.tmp(uploadId), { force: true });
    this.db.prepare("UPDATE uploads SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, this.now(), uploadId);
    this.emit('changed');
  }

  private async finalize(u: URow): Promise<UploadStatus> {
    const part = this.storage.tmp(u.id);
    const [size, sha] = [await sizeOf(part), await hashFile(part)];
    if (size !== u.size || sha !== u.sha256) {
      await this.fail(u.id, 'The file arrived damaged (checksum mismatch). Please submit again.');
      throw new ApiError(422, 'hash_mismatch', 'The file arrived damaged (checksum mismatch). Please submit again.');
    }
    const a = this.mustAssignment(u.assignment_id);
    const member = this.classroom.member(u.member_id)!;
    const id = randomUUID();
    const safe = safeFileName(u.file_name);
    const dir = this.storage.submissionDir(this.classroom.id, id);
    const dest = this.storage.submissionFile(this.classroom.id, id, safe);
    await mkdir(dir, { recursive: true });
    await rename(part, dest);
    const at = this.now();
    const late = a.due_at !== null && at > a.due_at ? 1 : 0;
    this.db.exec('BEGIN');
    try {
      const version = (this.db.prepare('SELECT coalesce(max(version), 0) + 1 v FROM submissions WHERE assignment_id = ? AND member_id = ?').get(a.id, u.member_id) as { v: number }).v;
      this.db.prepare('INSERT INTO submissions (id, session_id, assignment_id, member_id, device_id, upload_id, version, file_name, safe_name, stored_path, size, sha256, submitted_at, late) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, this.classroom.id, a.id, u.member_id, member.deviceId, u.id, version, u.file_name.replace(/[\u0000-\u001f\u007f]/g, ''), safe, this.storage.rel(dest), size, sha, at, late);
      this.db.prepare("UPDATE uploads SET state = 'complete', submission_id = ?, updated_at = ? WHERE id = ?").run(id, at, u.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      await rename(dest, part).catch(() => {});
      throw e;
    }
    this.receipt(id); // sign + persist now so the receipt is immutable from the moment of acceptance
    this.classroom.log('submission.accepted', u.member_id, { name: member.fullName, assignmentId: a.id, title: a.title, late: !!late });
    this.emit('changed');
    return this.status(u.member_id, u.id);
  }

  /**
   * Signed receipt. Signed once when the submission is accepted and stored verbatim, so idempotent re-fetches return
   * byte-identical receipts. (Pre-2.5 submissions are signed on first request.)
   */
  receipt(submissionId: string): Receipt {
    const s = this.db.prepare('SELECT * FROM submissions WHERE id = ? AND session_id = ?').get(submissionId, this.classroom.id) as SRow;
    if (s.receipt) return JSON.parse(s.receipt) as Receipt;
    const a = this.mustAssignment(s.assignment_id);
    const m = this.classroom.member(s.member_id)!;
    const payload: ReceiptPayload = {
      type: 'classroom-lan/receipt', v: 1, receiptId: randomUUID(), submissionId: s.id, assignmentId: a.id, assignmentTitle: a.title,
      sessionId: this.classroom.id, courseTitle: this.classroom.title, memberId: m.id, studentKeyFingerprint: s.device_id,
      fullName: m.fullName, rollNo: m.rollNo, version: s.version, submittedAt: s.submitted_at, late: !!s.late,
      fileName: s.safe_name, size: s.size, sha256: s.sha256, status: 'accepted', teacherKeyFingerprint: keyFingerprint(this.signer.publicKey),
    };
    const receipt: Receipt = { payload, alg: 'Ed25519', signature: this.signer.sign(canonicalBytes(payload)), teacherPublicKey: this.signer.publicKey };
    this.db.prepare('UPDATE submissions SET receipt = ? WHERE id = ? AND receipt IS NULL').run(JSON.stringify(receipt), s.id);
    return JSON.parse((this.db.prepare('SELECT receipt FROM submissions WHERE id = ?').get(s.id) as { receipt: string }).receipt);
  }

  /** Absolute path of a stored submission, for the teacher's "show in folder". */
  submissionPath(submissionId: string) {
    const s = this.db.prepare('SELECT stored_path FROM submissions WHERE id = ? AND session_id = ?').get(submissionId, this.classroom.id) as { stored_path: string } | undefined;
    if (!s) throw new ApiError(404, 'not_found', 'No such submission.');
    return this.storage.abs(s.stored_path);
  }

  private rows() {
    return this.db.prepare('SELECT * FROM assignments WHERE session_id = ? ORDER BY created_at').all(this.classroom.id) as ARow[];
  }

  private latest(assignmentId: string, memberId: string) {
    return this.db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND member_id = ? ORDER BY version DESC LIMIT 1').get(assignmentId, memberId) as SRow | undefined;
  }

  listForStudent(memberId: string): StudentAssignmentView[] {
    return this.rows().map((a) => {
      const s = this.latest(a.id, memberId);
      return { ...aview(a), latest: s ? this.receipt(s.id) : null };
    });
  }

  listForTeacher(): TeacherAssignmentView[] {
    const members = this.classroom.roster();
    return this.rows().map((a) => {
      const counts: Record<SubmissionState, number> = { submitted: 0, late: 0, missing: 0, uploading: 0, failed: 0 };
      const students = members
        .filter((m) => m.status === 'approved' || this.latest(a.id, m.id))
        .map((m) => {
          const s = this.latest(a.id, m.id);
          const lastUpload = this.db.prepare('SELECT * FROM uploads WHERE assignment_id = ? AND member_id = ? ORDER BY updated_at DESC LIMIT 1').get(a.id, m.id) as URow | undefined;
          let state: SubmissionState = s ? (s.late ? 'late' : 'submitted') : 'missing';
          if (lastUpload?.state === 'uploading' && (this.writing.has(lastUpload.id) || this.now() - lastUpload.updated_at < 120_000)) state = s ? state : 'uploading';
          else if (!s && lastUpload?.state === 'failed') state = 'failed';
          counts[state]++;
          return { memberId: m.id, fullName: m.fullName, rollNo: m.rollNo, state, submissionId: s?.id ?? null, submittedAt: s?.submitted_at ?? null, fileName: s?.safe_name ?? null, size: s?.size ?? null, version: s?.version ?? null };
        });
      return { ...aview(a), counts, students };
    });
  }

  /** Startup: in-flight uploads from previous runs can't continue (their sessions ended). */
  async sweep() {
    this.db.prepare("UPDATE uploads SET state = 'failed', error = 'Interrupted: the class ended before the upload finished.' WHERE state = 'uploading' AND session_id != ?").run(this.classroom.id);
    // Quarantined shares awaiting host review are durable (they survive the session and restarts); keep their bytes.
    const pending = new Set((this.db.prepare("SELECT id FROM share_uploads WHERE state = 'complete' AND approval = 'pending'").all() as { id: string }[]).map((r) => r.id));
    await this.storage.sweepTmp((id) => pending.has(id));
  }
}

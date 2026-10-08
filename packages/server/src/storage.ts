import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { safeFileName } from '@classroom/protocol';

/** Tunables. Defaults are documented in docs/FILE_TRANSFER.md. */
export type Limits = {
  /** Concurrent file-content responses, whole server / per student. */
  maxDownloadsTotal: number;
  maxDownloadsPerMember: number;
  /** Content requests per student per minute (stops range-request floods). */
  downloadRequestsPerMinute: number;
  maxUploadsTotal: number;
  maxUploadsPerMember: number;
  /** Ceiling the teacher may set for an assignment's max file size. */
  maxSubmissionBytes: number;
  /** Unfinished uploads a student may hold at once (each reserves temp disk). */
  maxPendingUploadsPerMember: number;
  /** Always leave this much disk free on the teacher machine. */
  diskReserveBytes: number;
  maxResourcesPerSession: number;
  maxAssignmentsPerSession: number;
  /** Idle socket timeout for transfers; a stalled student frees its slot. */
  transferIdleMs: number;
  /** Unfinished OPAQUE pairing attempts per source address at once. */
  pairInflightPerSource: number;
  /** Manifest chunk size for new resources (see BENCHMARKS.md for how it was chosen). */
  chunkSize: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxDownloadsTotal: 128,
  maxDownloadsPerMember: 4,
  downloadRequestsPerMinute: 120,
  maxUploadsTotal: 32,
  maxUploadsPerMember: 2,
  maxSubmissionBytes: 2 * 1024 ** 3,
  maxPendingUploadsPerMember: 5,
  diskReserveBytes: 1024 ** 3,
  maxResourcesPerSession: 1000,
  maxAssignmentsPerSession: 200,
  transferIdleMs: 60_000,
  pairInflightPerSource: 4,
  chunkSize: 1024 * 1024,
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ApiError extends Error {
  status: number; code: string; extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}

/**
 * Managed storage root. Every path is built from server-generated UUIDs (validated) plus, for submissions,
 * a sanitized name — never from a raw client string — and re-checked to be inside the root.
 */
export class Storage {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  async init() {
    await Promise.all(['resources', 'submissions', 'tmp'].map((d) => mkdir(join(this.root, d), { recursive: true })));
  }

  private inside(...parts: string[]) {
    const p = resolve(this.root, ...parts);
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error('path escapes storage root');
    return p;
  }

  private id(id: string) {
    if (!UUID_RE.test(id)) throw new Error('invalid id');
    return id;
  }

  resource(id: string) { return this.inside('resources', this.id(id)); }
  tmp(id: string) { return this.inside('tmp', `${this.id(id)}.part`); }
  submissionDir(sessionId: string, submissionId: string) { return this.inside('submissions', this.id(sessionId), this.id(submissionId)); }
  submissionFile(sessionId: string, submissionId: string, safeName: string) {
    if (safeName !== safeFileName(safeName)) throw new Error('unsafe name');
    return this.inside('submissions', this.id(sessionId), this.id(submissionId), safeName);
  }
  /** Relative form stored in the DB; resolved back through `inside`. */
  rel(abs: string) { return relative(this.root, abs).split(sep).join('/'); }
  abs(rel: string) { return this.inside(...rel.split('/')); }

  async freeBytes() {
    const s = await statfs(this.root);
    return s.bavail * s.bsize;
  }

  async ensureSpace(bytes: number, reserve: number) {
    const free = await this.freeBytes();
    if (free - bytes < reserve) throw new ApiError(507, 'disk_full', 'The teacher computer is low on disk space.');
  }

  /** Remove temp files left by a crash. Called on startup. */
  async sweepTmp(keep: (id: string) => boolean) {
    for (const f of await readdir(join(this.root, 'tmp'))) {
      const id = f.replace(/\.part$/, '');
      if (!keep(id)) await rm(join(this.root, 'tmp', f), { force: true });
    }
  }
}

/**
 * The resumable upload step shared by submissions and shares: append a request body to `part`, refusing more than `room`
 * bytes. Returns the bytes received, or null when the client went away (the partial stays for resume).
 */
export async function appendBody(part: string, room: number, body: Readable, onChunk?: () => void): Promise<number | null> {
  let received = 0;
  try {
    await pipeline(body, new Transform({
      transform(chunk: Buffer, _e, cb) {
        onChunk?.();
        received += chunk.length;
        if (received > room) return cb(new ApiError(413, 'too_large', 'More bytes than declared.'));
        cb(null, chunk);
      },
    }), createWriteStream(part, { flags: 'a' }));
    return received;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return null;
  }
}

export async function sizeOf(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

export function hashFile(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
  });
}

/**
 * Single byte range only (RFC 9110 §14.1.2). Returns null when there is no Range header.
 * Anything malformed, multi-range, or unsatisfiable is 'invalid' -> 416. Strict on purpose.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (header === undefined) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number, end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** attachment with ASCII fallback + RFC 5987 UTF-8 name. Input is already safeFileName'd; we still strip quotes/CRLF. */
export function contentDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
};
/** Informational only (shown in UI). Downloads are always served as application/octet-stream. */
export const mimeFor = (ext: string) => MIME[ext] ?? 'application/octet-stream';

/** Fixed-window per-key request counter. */
export class RateLimit {
  private hits = new Map<string, { n: number; reset: number }>();
  private max: number; private windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  take(key: string): boolean {
    const t = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= t) { e = { n: 0, reset: t + this.windowMs }; this.hits.set(key, e); }
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    return ++e.n <= this.max;
  }
}

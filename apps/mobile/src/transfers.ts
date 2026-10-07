// Mobile student transfers. NOT validated on a device, and NOT reachable in this build (no mobile pairing yet —
// see native.ts). All network I/O goes through the pinned native transport; Expo is used only for local files.
import { Directory, File, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { initUpload, resourceContentPath, TransferError, uploadStatus } from '@classroom/client';
import { safeFileName, UPLOAD_CONTENT_TYPE, verifyReceipt, type Receipt, type ResourceView, type TransferState } from '@classroom/protocol';
import type { PinnedNativeTransport } from './native';

export type Conn = { url: string; token: string; sessionId: string; classTitle: string; transport: PinnedNativeTransport; teacherPublicKey: string };
export type FileState = { resourceId: string; state: TransferState; bytes: number; size: number; error?: string; uri?: string; resumedFrom?: number };
export type StoredReceipt = { receipt: Receipt; verified: boolean; reason?: string };

const root = () => new Directory(Paths.document, 'Classroom LAN');
const classDir = (c: Conn) => new Directory(root(), safeFileName(c.classTitle));
const partialDir = (c: Conn) => new Directory(classDir(c), '.partial');
const indexFile = () => new File(root(), 'downloads.json');
const receiptsDir = () => new Directory(root(), 'receipts');
const pendingFile = () => new File(root(), 'pending-uploads.json');

const ensure = (d: Directory) => { if (!d.exists) d.create({ intermediates: true }); return d; };
const readJson = <T>(f: File, fallback: T): T => { try { return f.exists ? JSON.parse(f.textSync()) : fallback; } catch { return fallback; } };
const writeJson = (f: File, v: unknown) => { ensure(f.parentDirectory); f.write(JSON.stringify(v)); };

type Index = Record<string, { uri: string; sha256: string }>;
const key = (c: Conn, id: string) => `${c.sessionId}:${id}`;

/** Streaming SHA-256: 1 MB reads, never the whole file in memory. */
export function sha256File(uri: string): string {
  const h = sha256.create();
  const fh = new File(uri).open();
  try {
    for (;;) {
      const chunk = fh.readBytes(1 << 20);
      if (chunk.length === 0) break;
      h.update(chunk);
    }
  } finally { fh.close(); }
  return bytesToHex(h.digest());
}

function uniqueFile(dir: Directory, name: string): File {
  const safe = safeFileName(name);
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 0; ; i++) {
    const f = new File(dir, i ? `${base} (${i})${ext}` : safe);
    if (!f.exists) return f;
  }
}

const active = new Map<string, AbortController>();

export function fileStates(c: Conn, resources: ResourceView[]): FileState[] {
  const idx = readJson<Index>(indexFile(), {});
  return resources.map((r) => {
    const e = idx[key(c, r.id)];
    if (e && e.sha256 === r.sha256 && new File(e.uri).exists) return { resourceId: r.id, state: 'completed', bytes: r.size, size: r.size, uri: e.uri };
    if (active.has(r.id)) return { resourceId: r.id, state: 'downloading', bytes: 0, size: r.size };
    const part = new File(partialDir(c), `${r.id}.part`);
    return { resourceId: r.id, state: part.exists && (part.size ?? 0) > 0 ? 'paused' : 'not_started', bytes: part.exists ? part.size ?? 0 : 0, size: r.size };
  });
}

/** Resumable download: `.partial/<id>.part` + meta, Range from the bytes on disk, SHA-256 verify, then move. */
export async function download(c: Conn, r: ResourceView, onState: (s: FileState) => void): Promise<void> {
  if (active.has(r.id) || !r.sha256) return;
  const report = (state: TransferState, bytes: number, extra: Partial<FileState> = {}) => onState({ resourceId: r.id, state, bytes, size: r.size, ...extra });
  const part = new File(ensure(partialDir(c)), `${r.id}.part`);
  const meta = new File(partialDir(c), `${r.id}.json`);
  if (readJson<{ sha256?: string }>(meta, {}).sha256 !== r.sha256 && part.exists) part.delete();
  writeJson(meta, { sha256: r.sha256, size: r.size });
  if (!part.exists) part.create();
  const have = part.size ?? 0;
  const ctl = new AbortController();
  active.set(r.id, ctl);
  report('downloading', have, { resumedFrom: have || undefined });
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${c.token}`, ...(have ? { range: `bytes=${have}-`, 'if-range': `"${r.sha256}"` } : {}) };
    const total = await c.transport.downloadToFile(c.url + resourceContentPath(r.id), headers, part.uri, have, (b) => report('downloading', b), ctl.signal);
    if (total !== r.size) throw new TransferError('incomplete', 'Connection ended early.');
    report('verifying', r.size);
    if (sha256File(part.uri) !== r.sha256) {
      part.delete();
      throw new TransferError('hash_mismatch', 'The download was damaged (checksum mismatch) and was discarded.');
    }
    const dest = uniqueFile(classDir(c), r.name);
    part.move(dest);
    meta.delete();
    const idx = readJson<Index>(indexFile(), {});
    idx[key(c, r.id)] = { uri: dest.uri, sha256: r.sha256 };
    writeJson(indexFile(), idx);
    report('completed', r.size, { uri: dest.uri });
  } catch (e) {
    if (ctl.signal.aborted) report('paused', part.size ?? 0);
    else report('failed', part.exists ? part.size ?? 0 : 0, { error: (e as Error).message });
  } finally {
    active.delete(r.id);
  }
}

export function pause(r: ResourceView) { active.get(r.id)?.abort(); }

/** Stable idempotency key per intended submission, persisted before upload starts. */
export function idempotencyKeyFor(k: string, newKey: () => string): string {
  const p = readJson<Record<string, string>>(pendingFile(), {});
  p[k] ??= newKey();
  writeJson(pendingFile(), p);
  return p[k]!;
}
export function clearIdempotencyKey(k: string) {
  const p = readJson<Record<string, string>>(pendingFile(), {});
  delete p[k];
  writeJson(pendingFile(), p);
}

/** Idempotent, resumable submission over the pinned transport; the receipt is verified before it's shown as such. */
export async function submit(c: Conn, assignmentId: string, file: { uri: string; name: string; size: number }, idempotencyKey: string,
  onProgress: (sent: number, size: number) => void): Promise<StoredReceipt> {
  const sha = sha256File(file.uri);
  let st = await initUpload(c.transport, c.url, c.token, { assignmentId, fileName: file.name, size: file.size, sha256: sha, idempotencyKey });
  for (let attempt = 0; !st.receipt; attempt++) {
    if (st.state === 'failed') throw new TransferError('failed', st.error ?? 'Upload failed.');
    try {
      const res = await c.transport.uploadFromFile(`${c.url}/api/uploads/${st.uploadId}`,
        { authorization: `Bearer ${c.token}`, 'content-type': UPLOAD_CONTENT_TYPE, 'upload-offset': String(st.offset) }, file.uri, st.offset, (s) => onProgress(s, file.size));
      const body = JSON.parse(res.body || '{}');
      if (res.status >= 200 && res.status < 300) { st = body; continue; }
      if (res.status !== 409 && res.status !== 429) throw new TransferError(body.code ?? 'http_' + res.status, body.message ?? `Upload failed (${res.status})`, res.status);
    } catch (e) {
      if (e instanceof TransferError || attempt >= 10) throw e;
    }
    await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** attempt)));
    st = await uploadStatus(c.transport, c.url, c.token, st.uploadId);
  }
  const receipt = st.receipt!;
  new File(ensure(receiptsDir()), `${receipt.payload.submissionId}.json`).write(JSON.stringify(receipt));
  return check(receipt, c.teacherPublicKey);
}

export function check(receipt: Receipt, trustedTeacherKey: string): StoredReceipt {
  const r = verifyReceipt(receipt, { trustedTeacherKey });
  return r.ok ? { receipt, verified: true } : { receipt, verified: false, reason: r.reason };
}

export function receipts(c: Conn): StoredReceipt[] {
  const d = receiptsDir();
  if (!d.exists) return [];
  return d.list().filter((x): x is File => x instanceof File && x.name.endsWith('.json'))
    .map((f) => readJson<Receipt | null>(f, null)).filter((r): r is Receipt => !!r?.payload && r.payload.sessionId === c.sessionId)
    .map((r) => check(r, c.teacherPublicKey)).sort((a, b) => b.receipt.payload.submittedAt - a.receipt.payload.submittedAt);
}

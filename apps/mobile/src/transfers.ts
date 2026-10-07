// Mobile student transfers (Expo). NOT yet validated on a device — see docs/TESTING.md.
// Downloads: expo-file-system DownloadResumable (native Range resume), then streaming SHA-256 verification, then
// move to the final name. Uploads: same idempotent upload protocol as desktop; uploadAsync can't start at an offset,
// so a retry re-sends from byte 0 (Upload-Offset: 0 restarts server-side) but never creates a duplicate.
import * as Legacy from 'expo-file-system/legacy';
import { Directory, File, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { initUpload, resourceContentPath, TransferError, uploadStatus } from '@classroom/client';
import { safeFileName, UPLOAD_CONTENT_TYPE, type Receipt, type ResourceView, type TransferState } from '@classroom/protocol';

export type Conn = { url: string; token: string; sessionId: string; classTitle: string };
export type FileState = { resourceId: string; state: TransferState; bytes: number; size: number; error?: string; uri?: string };

const root = () => new Directory(Paths.document, 'Classroom LAN');
const classDir = (c: Conn) => new Directory(root(), safeFileName(c.classTitle));
const partialDir = (c: Conn) => new Directory(classDir(c), '.partial');
const indexFile = () => new File(root(), 'downloads.json');
const receiptsDir = () => new Directory(root(), 'receipts');

const ensure = (d: Directory) => { if (!d.exists) d.create({ intermediates: true }); return d; };
const readJson = <T>(f: File, fallback: T): T => { try { return f.exists ? JSON.parse(f.textSync()) : fallback; } catch { return fallback; } };
const writeJson = (f: File, v: unknown) => { ensure(f.parentDirectory); f.write(JSON.stringify(v)); };

type Index = Record<string, { uri?: string; sha256: string; pause?: Legacy.DownloadPauseState }>;
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

const active = new Map<string, Legacy.DownloadResumable>();

export function fileStates(c: Conn, resources: ResourceView[]): FileState[] {
  const idx = readJson<Index>(indexFile(), {});
  return resources.map((r) => {
    const e = idx[key(c, r.id)];
    if (e?.uri && e.sha256 === r.sha256 && new File(e.uri).exists) return { resourceId: r.id, state: 'completed', bytes: r.size, size: r.size, uri: e.uri };
    if (active.has(r.id)) return { resourceId: r.id, state: 'downloading', bytes: 0, size: r.size };
    return { resourceId: r.id, state: e?.pause && e.sha256 === r.sha256 ? 'paused' : 'not_started', bytes: 0, size: r.size };
  });
}

export async function download(c: Conn, r: ResourceView, onState: (s: FileState) => void): Promise<void> {
  if (active.has(r.id) || !r.sha256) return;
  const report = (state: TransferState, bytes: number, extra: Partial<FileState> = {}) => onState({ resourceId: r.id, state, bytes, size: r.size, ...extra });
  const idx = readJson<Index>(indexFile(), {});
  const prev = idx[key(c, r.id)];
  const part = new File(ensure(partialDir(c)), `${r.id}.part`);
  const resume = prev?.pause && prev.sha256 === r.sha256 ? prev.pause.resumeData : undefined;
  if (!resume && part.exists) part.delete();
  let last = 0;
  const task = Legacy.createDownloadResumable(c.url + resourceContentPath(r.id), part.uri, { headers: { authorization: `Bearer ${c.token}` } }, (p) => {
    if (Date.now() - last > 250) { last = Date.now(); report('downloading', p.totalBytesWritten); }
  }, resume);
  active.set(r.id, task);
  report('downloading', 0);
  try {
    const res = resume ? await task.resumeAsync() : await task.downloadAsync();
    if (!res) return; // paused
    if (res.status !== 200 && res.status !== 206) throw new TransferError('http_' + res.status, `Download failed (${res.status})`);
    report('verifying', r.size);
    if (part.size !== r.size || sha256File(part.uri) !== r.sha256) {
      part.delete();
      throw new TransferError('hash_mismatch', 'The download was damaged (checksum mismatch) and was discarded.');
    }
    const dest = uniqueFile(classDir(c), r.name);
    part.move(dest);
    idx[key(c, r.id)] = { uri: dest.uri, sha256: r.sha256 };
    writeJson(indexFile(), idx);
    report('completed', r.size, { uri: dest.uri });
  } catch (e) {
    report('failed', 0, { error: (e as Error).message });
  } finally {
    active.delete(r.id);
  }
}

export async function pause(c: Conn, r: ResourceView, onState: (s: FileState) => void) {
  const task = active.get(r.id);
  if (!task) return;
  const state = await task.pauseAsync();
  active.delete(r.id);
  const idx = readJson<Index>(indexFile(), {});
  idx[key(c, r.id)] = { sha256: r.sha256!, pause: state };
  writeJson(indexFile(), idx);
  onState({ resourceId: r.id, state: 'paused', bytes: 0, size: r.size });
}

/** Idempotent submission. `idempotencyKey` must be reused for retries of the same intended submission. */
export async function submit(c: Conn, assignmentId: string, file: { uri: string; name: string; size: number }, idempotencyKey: string,
  onProgress: (sent: number, size: number) => void): Promise<Receipt> {
  const sha = sha256File(file.uri);
  let st = await initUpload(c.url, c.token, { assignmentId, fileName: file.name, size: file.size, sha256: sha, idempotencyKey });
  for (let attempt = 0; !st.receipt; attempt++) {
    if (st.state === 'failed') throw new TransferError('failed', st.error ?? 'Upload failed.');
    const task = Legacy.createUploadTask(`${c.url}/api/uploads/${st.uploadId}`, file.uri, {
      httpMethod: 'PUT', uploadType: Legacy.FileSystemUploadType.BINARY_CONTENT,
      headers: { authorization: `Bearer ${c.token}`, 'content-type': UPLOAD_CONTENT_TYPE, 'upload-offset': '0' },
    }, (p) => onProgress(p.totalBytesSent, file.size));
    try {
      const res = await task.uploadAsync();
      const body = res ? JSON.parse(res.body || '{}') : {};
      if (res && res.status >= 200 && res.status < 300) { st = body; continue; }
      if (res && res.status !== 409 && res.status !== 429) throw new TransferError(body.code ?? 'http_' + res.status, body.message ?? `Upload failed (${res.status})`, res.status);
    } catch (e) {
      if (e instanceof TransferError || attempt >= 10) throw e;
    }
    await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** attempt)));
    st = await uploadStatus(c.url, c.token, st.uploadId);
  }
  const receipt = st.receipt!;
  new File(ensure(receiptsDir()), `${receipt.submissionId}.json`).write(JSON.stringify(receipt));
  return receipt;
}

export function receipts(sessionId: string): Receipt[] {
  const d = receiptsDir();
  if (!d.exists) return [];
  return d.list().filter((x): x is File => x instanceof File && x.name.endsWith('.json'))
    .map((f) => readJson<Receipt | null>(f, null)).filter((r): r is Receipt => !!r && r.sessionId === sessionId)
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

const pendingFile = () => new File(root(), 'pending-uploads.json');
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

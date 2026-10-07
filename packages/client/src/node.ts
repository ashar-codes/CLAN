// Node implementation of resumable downloads and uploads (desktop main process, tests, benchmarks).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, X509Certificate, type Hash, type KeyObject } from 'node:crypto';
import type { PeerCertificate } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import WebSocket from 'ws';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile, access } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { safeFileName, UPLOAD_CONTENT_TYPE, type Receipt, type ResourceView, type TransferState, type UploadStatus } from '@classroom/protocol';
import { b64u, type TlsBinding } from '@classroom/protocol';
import { assertSecureUrl, initUpload, resourceContentPath, sleep, TransferError, uploadStatus, type DeviceSigner, type Transport, type WebSocketLike } from './index.ts';

// ---- Pinned TLS transport (Node / Electron main) ----

export const spkiSha256OfDer = (der: Buffer) => createHash('sha256').update(new X509Certificate(der).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

/**
 * Trusts exactly the classroom certificate from the PAKE-authenticated binding (as the only CA, so normal chain
 * validation still runs) AND requires the server's SPKI to equal the pinned hash. Host names/IPs are not trusted or
 * checked: the pin is the identity, so the teacher's address may change without weakening anything.
 */
export function pinnedTransport(pin: Pick<TlsBinding, 'certificate' | 'spkiSha256'>): Transport {
  const der = Buffer.from(pin.certificate, 'base64');
  const ca = new X509Certificate(der).toString();
  if (spkiSha256OfDer(der) !== pin.spkiSha256) throw new TransferError('mitm', 'Pinned certificate does not match its pin.');
  const checkServerIdentity = (_host: string, cert: PeerCertificate) =>
    cert.raw && spkiSha256OfDer(cert.raw) === pin.spkiSha256 ? undefined : new TransferError('pin_mismatch', 'The classroom certificate does not match the securely paired one.');
  const tls = { ca, checkServerIdentity, minVersion: 'TLSv1.3' as const, rejectUnauthorized: true };
  const dispatcher = new Agent({ connect: tls });
  return {
    fetch: (url, init) => { assertSecureUrl(url); return undiciFetch(url, { ...(init as object), dispatcher }) as unknown as Promise<Response>; },
    // @types/ws mistypes checkServerIdentity (boolean); at runtime ws hands these to Node's tls.connect.
    openWebSocket: (url) => { assertSecureUrl(url); return new WebSocket(url, { ...tls, maxPayload: 1 << 20 } as unknown as WebSocket.ClientOptions) as unknown as WebSocketLike; },
  };
}

// ---- Ed25519 device identity (Node crypto; callers decide where the private key is stored) ----

export function newEd25519(): { privatePkcs8: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privatePkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), publicKey: rawEd25519Public(publicKey) };
}
/** Raw 32-byte public key from a KeyObject (the last 32 bytes of the Ed25519 SPKI DER), base64url. */
export const rawEd25519Public = (k: KeyObject) => b64u.encode(new Uint8Array(k.export({ type: 'spki', format: 'der' }).subarray(-32)));
export function nodeSigner(privatePkcs8: string): DeviceSigner {
  const key = createPrivateKey({ key: Buffer.from(privatePkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  return { publicKey: rawEd25519Public(createPublicKey(key)), sign: (bytes) => b64u.encode(new Uint8Array(edSign(null, bytes, key))) };
}

export type Progress = { state: TransferState; bytes: number; size: number; resumedFrom: number };

const exists = (p: string) => access(p).then(() => true, () => false);

export async function sha256File(path: string, h: Hash = createHash('sha256')): Promise<string> {
  await pipeline(createReadStream(path), new Transform({ transform(c, _e, cb) { h.update(c); cb(); } }));
  return h.digest('hex');
}

/** "name.pdf", "name (1).pdf", ... — never overwrites an existing file. */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const safe = safeFileName(name);
  const ext = extname(safe), base = safe.slice(0, safe.length - ext.length);
  for (let i = 0; ; i++) {
    const p = join(dir, i ? `${base} (${i})${ext}` : safe);
    if (!(await exists(p))) return p;
  }
}

export const partPaths = (destDir: string, resourceId: string) => {
  if (!/^[0-9a-f-]{36}$/.test(resourceId)) throw new TransferError('invalid', 'Bad resource id');
  const dir = join(destDir, '.partial');
  return { dir, part: join(dir, `${resourceId}.part`), meta: join(dir, `${resourceId}.json`) };
};

/**
 * Download with resume. Partial bytes live in <destDir>/.partial/<id>.part next to a meta file recording the
 * expected SHA-256; the final file appears (atomic rename) only after size + hash verification.
 * Aborting via `signal` leaves the partial for a later resume.
 */
export async function downloadResource(o: {
  transport: Transport; url: string; token: string; resource: Pick<ResourceView, 'id' | 'name' | 'size' | 'sha256'>; destDir: string;
  signal?: AbortSignal; onProgress?: (p: Progress) => void; maxRetries?: number;
}): Promise<{ path: string; resumedFrom: number }> {
  assertSecureUrl(o.url);
  const { resource: r } = o;
  if (!r.sha256) throw new TransferError('not_ready', 'File is not ready yet.');
  const { dir, part, meta } = partPaths(o.destDir, r.id);
  await mkdir(dir, { recursive: true });

  // A partial for a different version of the file is useless: discard it.
  const m = await readFile(meta, 'utf8').then(JSON.parse, () => null);
  if (!m || m.sha256 !== r.sha256 || m.size !== r.size) await rm(part, { force: true });
  await writeFile(meta, JSON.stringify({ sha256: r.sha256, size: r.size, name: r.name }));

  let have = await stat(part).then((s) => s.size, () => 0);
  if (have > r.size) { await rm(part, { force: true }); have = 0; }
  const resumedFrom = have;
  let hash = createHash('sha256');
  if (have > 0) await pipeline(createReadStream(part), new Transform({ transform(c, _e, cb) { hash.update(c); cb(); } }));
  const report = (state: TransferState) => o.onProgress?.({ state, bytes: have, size: r.size, resumedFrom });
  report('downloading');

  for (let attempt = 0; ; attempt++) {
    if (have === r.size) break;
    const headers: Record<string, string> = { authorization: `Bearer ${o.token}` };
    if (have > 0) { headers.range = `bytes=${have}-`; headers['if-range'] = `"${r.sha256}"`; }
    const res = await o.transport.fetch(o.url + resourceContentPath(r.id), { headers, signal: o.signal });
    if (res.status === 429 && attempt < (o.maxRetries ?? 50)) {
      await res.body?.cancel();
      await sleep(Number(res.headers.get('retry-after') ?? 1) * 1000 * (0.5 + Math.random()), o.signal);
      continue;
    }
    if (res.status === 416 && have > 0 && attempt < 3) { await res.body?.cancel(); await rm(part, { force: true }); have = 0; hash = createHash('sha256'); continue; }
    if (res.status !== 200 && res.status !== 206) {
      const b = await res.json().catch(() => ({}));
      throw new TransferError(b.code ?? 'http_' + res.status, b.message ?? `Download failed (${res.status})`, res.status);
    }
    if (res.status === 200 && have > 0) { await rm(part, { force: true }); have = 0; hash = createHash('sha256'); } // server sent whole file
    if (res.status === 206 && !res.headers.get('content-range')?.startsWith(`bytes ${have}-`)) throw new TransferError('bad_range', 'Server sent an unexpected range.');
    if (!res.body) throw new TransferError('empty', 'Empty response.');

    let last = 0;
    await pipeline(
      Readable.fromWeb(res.body as never, { signal: o.signal }),
      new Transform({
        transform(c: Buffer, _e, cb) {
          have += c.length;
          if (have > r.size) return cb(new TransferError('too_long', 'Server sent more bytes than expected.'));
          hash.update(c);
          if (Date.now() - last > 200) { last = Date.now(); report('downloading'); }
          cb(null, c);
        },
      }),
      createWriteStream(part, { flags: 'a' }),
      { signal: o.signal },
    );
    if (have < r.size) throw new TransferError('incomplete', 'Connection ended early.');
  }

  report('verifying');
  if (hash.digest('hex') !== r.sha256) {
    await rm(part, { force: true });
    throw new TransferError('hash_mismatch', 'The download was damaged (checksum mismatch) and was discarded.');
  }
  await mkdir(o.destDir, { recursive: true });
  const path = await uniquePath(o.destDir, r.name);
  await rename(part, path);
  await rm(meta, { force: true });
  report('completed');
  return { path, resumedFrom };
}

/**
 * Resumable, idempotent submission upload. Reuse `idempotencyKey` for retries of the same intended submission
 * (including after an app restart) — the server then returns the same receipt instead of a duplicate.
 */
export async function uploadSubmission(o: {
  transport: Transport; url: string; token: string; assignmentId: string; path: string; fileName?: string; idempotencyKey: string;
  signal?: AbortSignal; onProgress?: (sent: number, size: number) => void; maxRetries?: number;
}): Promise<Receipt> {
  assertSecureUrl(o.url);
  const t = o.transport;
  const size = (await stat(o.path)).size;
  const sha256 = await sha256File(o.path);
  let st: UploadStatus = await initUpload(t, o.url, o.token, { assignmentId: o.assignmentId, fileName: o.fileName ?? basename(o.path), size, sha256, idempotencyKey: o.idempotencyKey });
  for (let attempt = 0; ; attempt++) {
    if (st.receipt) return st.receipt;
    if (st.state === 'failed') throw new TransferError('failed', st.error ?? 'Upload failed.');
    o.onProgress?.(st.offset, size);
    let sent = st.offset;
    try {
      const body = createReadStream(o.path, { start: st.offset }).pipe(new Transform({ transform(c, _e, cb) { sent += c.length; o.onProgress?.(sent, size); cb(null, c); } }));
      const res = await t.fetch(`${o.url}/api/uploads/${st.uploadId}`, {
        method: 'PUT', body: Readable.toWeb(body) as never, duplex: 'half', signal: o.signal,
        headers: { authorization: `Bearer ${o.token}`, 'content-type': UPLOAD_CONTENT_TYPE, 'upload-offset': String(st.offset) },
      } as RequestInit);
      const b = await res.json().catch(() => ({}));
      if (res.ok) { st = b; continue; }
      if (res.status === 409 && b.code === 'offset_mismatch') { st = { ...st, offset: b.offset }; continue; }
      if ((res.status === 429 || res.status === 409) && attempt < (o.maxRetries ?? 30)) { await sleep(1000, o.signal); st = await uploadStatus(t, o.url, o.token, st.uploadId); continue; }
      throw new TransferError(b.code ?? 'http_' + res.status, b.message ?? `Upload failed (${res.status})`, res.status);
    } catch (e) {
      if (e instanceof TransferError || o.signal?.aborted || attempt >= (o.maxRetries ?? 30)) throw e;
      // Network drop: ask the server how much it kept and continue from there.
      await sleep(Math.min(5000, 300 * 2 ** Math.min(attempt, 4)), o.signal);
      st = await uploadStatus(t, o.url, o.token, st.uploadId).catch(() => st);
    }
  }
}

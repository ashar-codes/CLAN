// Node implementation of the peer-assisted data plane (desktop main process, tests, simulator):
// chunk store on disk, the peer server (HTTPS, pinned identity endorsed by the teacher), and acquireResource(),
// which picks teacher-direct streaming or swarm acquisition and lets a download switch between them.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import {
  bitfield, b64u, keyFingerprint, verifyManifest, type ManifestPayload, type PeerCapability, type PeerEndorsement, type ResourceView, type SignedManifest,
} from '@classroom/protocol';
import { api, sleep, TransferError, type Transport } from './index.ts';
import type { DeviceSigner } from './pairing.ts';
import type { ResourceTransport } from './transports.ts';
import { acquireChunks, doneBitfield, peerAuthHeader, peerSource, teacherSource, verifyPeerAuth, type AcquireResult, type ChunkStore, type PeerInfo, type Source } from './swarm.ts';
import { downloadResource, partPaths, pinnedTransport, uniquePath, type Progress } from './node.ts';
import { createClassroomTls, type ClassroomTls } from './tls.ts';

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * Chunks live in the same `.partial/<id>.part` file the streaming downloader uses (written at chunk offsets); the
 * meta file additionally records which chunks are VERIFIED. Only verified chunks are ever served to peers.
 */
export class FsChunkStore implements ChunkStore {
  readonly chunkCount: number;
  private done: Uint8Array;
  private fh: FileHandle | null = null;
  private opening: Promise<FileHandle> | null = null;
  private servingPath: string | null = null;
  private readFh: FileHandle | null = null;
  private readOpening: Promise<FileHandle> | null = null;
  private paths: ReturnType<typeof partPaths>;
  private m: ManifestPayload;
  private saving: Promise<void> = Promise.resolve();

  private constructor(m: ManifestPayload, paths: ReturnType<typeof partPaths>, done: Uint8Array) {
    this.m = m; this.paths = paths; this.done = done; this.chunkCount = m.chunks.length;
  }

  /** Opens (or adopts) the partial for this resource. A streaming partial's verified prefix becomes done chunks. */
  static async open(destDir: string, m: ManifestPayload): Promise<FsChunkStore> {
    const paths = partPaths(destDir, m.resourceId);
    await mkdir(paths.dir, { recursive: true });
    const meta = await readFile(paths.meta, 'utf8').then(JSON.parse, () => null) as { sha256?: string; size?: number; done?: string } | null;
    let done: Uint8Array = bitfield.empty(m.chunks.length);
    if (!meta || meta.sha256 !== m.sha256 || meta.size !== m.size) {
      await rm(paths.part, { force: true });
    } else if (meta.done) {
      done = b64u.decode(meta.done);
    } else {
      // Adopt a contiguous streaming partial: every whole chunk inside it is verified by hash before it counts.
      const have = await stat(paths.part).then((s) => s.size, () => 0);
      const fh = await open(paths.part, 'r').catch(() => null);
      for (let i = 0; fh && i < m.chunks.length; i++) {
        const len = Math.min(m.chunkSize, m.size - i * m.chunkSize);
        if ((i * m.chunkSize) + len > have) break;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, i * m.chunkSize);
        if (sha256Hex(buf) === m.chunks[i]) bitfield.set(done, i); else break;
      }
      await fh?.close();
    }
    const s = new FsChunkStore(m, paths, done);
    await s.persist();
    return s;
  }

  isDone(i: number) { return bitfield.has(this.done, i); }
  doneCount() { return bitfield.count(this.done, this.chunkCount); }

  async write(i: number, bytes: Uint8Array) {
    const fh = await this.handle();
    await fh.write(bytes, 0, bytes.length, i * this.m.chunkSize);
    bitfield.set(this.done, i);
    this.schedulePersist(); // the mark always follows the data; a crash only means re-fetching a few chunks
  }

  /** Batch verified-chunk marks (one metadata write per 250 ms instead of per chunk). */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private schedulePersist() {
    this.persistTimer ??= setTimeout(() => { this.persistTimer = null; void this.persist(); }, 250);
  }

  /**
   * Serve a verified chunk. A paused/aborted partial keeps seeding its verified chunks; after finalize, reads come from
   * the final file (no gap where a peer would be told "don't have"). Reads never create files.
   */
  async read(i: number): Promise<Uint8Array | null> {
    if (!this.isDone(i)) return null;
    let fh: FileHandle;
    try {
      if (!this.servingPath && this.fh) fh = this.fh;
      else {
        this.readOpening ??= open(this.servingPath ?? this.paths.part, 'r');
        fh = this.readFh ??= await this.readOpening;
      }
    } catch { this.readOpening = null; return null; }
    const len = Math.min(this.m.chunkSize, this.m.size - i * this.m.chunkSize);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, i * this.m.chunkSize);
    return buf;
  }

  /** One shared handle; concurrent first writes must not open the file twice. */
  private handle(): Promise<FileHandle> {
    this.opening ??= (async () => { await (await open(this.paths.part, 'a')).close(); return (this.fh = await open(this.paths.part, 'r+')); })();
    return this.opening;
  }

  private persist() {
    const body = JSON.stringify({ sha256: this.m.sha256, size: this.m.size, name: this.m.name, chunkSize: this.m.chunkSize, done: b64u.encode(this.done) });
    this.saving = this.saving.then(() => writeFile(this.paths.meta, body));
    return this.saving;
  }

  async close() { if (this.readOpening) { const fh = await this.readOpening.catch(() => null); await fh?.close().catch(() => {}); this.readFh = null; this.readOpening = null; } if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; await this.persist(); } await this.saving; if (this.opening) await (await this.opening).close(); this.fh = null; this.opening = null; }

  /** All chunks verified: check the whole-file SHA-256, then atomically move into place. */
  async finalize(destDir: string): Promise<string> {
    await this.close();
    const h = createHash('sha256');
    await pipeline(createReadStream(this.paths.part), new Transform({ transform(c, _e, cb) { h.update(c); cb(); } }));
    if (h.digest('hex') !== this.m.sha256) {
      await rm(this.paths.part, { force: true }); await rm(this.paths.meta, { force: true });
      throw new TransferError('hash_mismatch', 'The assembled file failed verification and was discarded.');
    }
    const dest = await uniquePath(destDir, this.m.name);
    await rename(this.paths.part, dest);
    this.servingPath = dest;
    await rm(this.paths.meta, { force: true });
    return dest;
  }

  /** Switch to teacher streaming: keep only the verified contiguous prefix, in the streaming downloader's meta format. */
  async toStreamingPrefix() {
    await this.close();
    let k = 0;
    while (k < this.chunkCount && this.isDone(k)) k++;
    const bytes = Math.min(this.m.size, k * this.m.chunkSize);
    if (bytes === 0) await rm(this.paths.part, { force: true }); else await truncate(this.paths.part, bytes);
    await writeFile(this.paths.meta, JSON.stringify({ sha256: this.m.sha256, size: this.m.size, name: this.m.name }));
  }
}

// ---- peer server ----

export type PeerServerLimits = { maxConcurrent: number; requestsPerMinute: number; maxBytesPerSec: number };
export const DEFAULT_PEER_LIMITS: PeerServerLimits = { maxConcurrent: 4, requestsPerMinute: 1200, maxBytesPerSec: 0 };

export type PeerServer = { url: string; port: number; uploadedBytes(): number; close(): Promise<void> };

/**
 * Serves verified chunks (and manifests) of resources this device holds to OTHER approved members of the same class.
 * Authentication: teacher-signed capability + holder proof (verifyPeerAuth). TLS identity endorsed by the teacher.
 */
export async function startPeerServer(o: {
  host: string; port?: number; tls: ClassroomTls; sessionId: string; teacherKey: string; selfFingerprint: string;
  lookup(resourceId: string): { manifest: SignedManifest; read(i: number): Promise<Uint8Array | null>; have(): Uint8Array } | null;
  isDenied(fp: string): boolean; paused?(): boolean; limits?: Partial<PeerServerLimits>;
}): Promise<PeerServer> {
  const limits = { ...DEFAULT_PEER_LIMITS, ...o.limits };
  let active = 0, uploaded = 0, throttle: Promise<void> = Promise.resolve();
  const hits = new Map<string, { n: number; reset: number }>();
  const verified = new Map<string, ReturnType<typeof verifyPeerAuth>>();
  const srv: Server = createServer({ cert: o.tls.certPem, key: o.tls.keyPem, minVersion: 'TLSv1.3' }, async (req, res) => {
    const send = (code: number, body?: unknown) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      if (req.method !== 'GET') return send(405);
      const m = /^\/peer\/v1\/(chunk|manifest|have)\/([0-9a-f-]{36})(?:\/(\d{1,7}))?$/.exec(req.url ?? '');
      if (!m) return send(404);
      if (o.paused?.()) return send(503, { code: 'paused' });
      // Signature checks are cached per exact header until the capability expires; revocation is re-checked every time.
      const header = req.headers.authorization;
      let auth = header ? verified.get(header) : undefined;
      if (!auth || !auth.ok || auth.expiresAt <= Date.now()) {
        auth = verifyPeerAuth(header, { sessionId: o.sessionId, teacherKey: o.teacherKey, selfFingerprint: o.selfFingerprint, isDenied: o.isDenied });
        if (auth.ok && header) { if (verified.size > 2000) verified.clear(); verified.set(header, auth); }
      }
      if (auth.ok && o.isDenied(auth.holderFingerprint)) auth = { ok: false, status: 403, reason: 'revoked' };
      if (!auth.ok) return send(auth.status, { code: 'unauthorized', message: auth.reason });
      const t = Date.now();
      let h = hits.get(auth.holderFingerprint);
      if (!h || h.reset <= t) hits.set(auth.holderFingerprint, h = { n: 0, reset: t + 60_000 });
      if (++h.n > limits.requestsPerMinute) return send(429, { code: 'rate_limited' });
      const r = o.lookup(m[2]!);
      if (!r) return send(404, { code: 'not_found' });
      if (m[1] === 'manifest') return send(200, r.manifest);
      if (m[1] === 'have') return send(200, { chunks: b64u.encode(r.have()) });
      const i = Number(m[3]);
      if (!Number.isInteger(i) || i < 0 || i >= r.manifest.payload.chunks.length) return send(404, { code: 'not_found' });
      if (active >= limits.maxConcurrent) return send(429, { code: 'busy' });
      active++;
      try {
        const bytes = await r.read(i);
        if (!bytes) return send(404, { code: 'not_have' });
        if (limits.maxBytesPerSec > 0) { const wait = throttle.then(() => sleep((bytes.length / limits.maxBytesPerSec) * 1000)); throttle = wait; await wait; }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-store' });
        res.end(bytes);
        uploaded += bytes.length;
      } finally { active--; }
    } catch { send(500); }
  });
  srv.headersTimeout = 10_000;
  srv.requestTimeout = 60_000;
  await new Promise<void>((r) => srv.listen(o.port ?? 0, o.host, r));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `https://${o.host.includes(':') ? `[${o.host}]` : o.host}:${port}`, port, uploadedBytes: () => uploaded,
    close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

// ---- acquisition orchestrator ----

/** Files at or below this size come straight from the teacher (swarm coordination costs more than it saves). */
export const SMALL_FILE_BYTES = 4 * 1024 * 1024;

export type PeerContext = {
  device: DeviceSigner;
  teacherKey: string;
  sessionId: string;
  /** Teacher-issued capability (cached by the caller; refreshed before expiry). */
  capability(): Promise<PeerCapability>;
  /** Peer endorsements are pinned like the teacher: trust only the endorsed CA + leaf SPKI. */
  transportFor?(e: PeerEndorsement): Transport;
};

export type AcquireStats = AcquireResult & { mode: 'teacher-stream' | 'swarm'; teacherBytes: number; peerBytes: number };

/**
 * Get a resource. Teacher-only mode or small files: the robust streaming downloader (Range resume). Peer-assisted and
 * large: verify the teacher-signed manifest, then fetch chunks from peers and the teacher. Either path adopts the
 * other's partial, so switching modes mid-download keeps verified progress.
 */
export async function acquireResource(o: {
  transport: Transport; url: string; token: string; resource: Pick<ResourceView, 'id' | 'name' | 'size' | 'sha256'>; destDir: string;
  peerAssist: boolean; peers?: PeerContext; signal?: AbortSignal; onProgress?: (p: Progress & { sources?: string[] }) => void;
  /** Called when a chunk store is ready, so the caller can seed verified chunks while downloading. */
  onStore?(store: FsChunkStore, manifest: SignedManifest): void;
  smallFileBytes?: number; startOffset?: number; concurrency?: number; chunkTimeoutMs?: number; stallTimeoutMs?: number;
  /** Cached manifest/sources for when the teacher is unreachable. */
  cachedManifest?: SignedManifest; cachedSources?: PeerInfo[];
  onSources?(s: PeerInfo[]): void;
}): Promise<{ path: string; stats: AcquireStats; manifest?: SignedManifest }> {
  const r = o.resource;
  const swarm = o.peerAssist && !!o.peers && r.size > (o.smallFileBytes ?? SMALL_FILE_BYTES);
  if (!swarm) {
    if (o.cachedManifest) await (await FsChunkStore.open(o.destDir, o.cachedManifest.payload)).toStreamingPrefix();
    const out = await downloadResource({ transport: o.transport, url: o.url, token: o.token, resource: r, destDir: o.destDir, signal: o.signal, onProgress: o.onProgress });
    return { path: out.path, stats: { mode: 'teacher-stream', sources: [], retries: 0, corruptChunks: 0, failedChunks: 0, teacherBytes: r.size - out.resumedFrom, peerBytes: 0 } };
  }

  const pc = o.peers!;
  const manifest = await api<SignedManifest>(o.transport, o.url, o.token, `/api/resources/${r.id}/manifest`).catch((e) => {
    if (o.cachedManifest) return o.cachedManifest;
    throw e;
  });
  const v = verifyManifest(manifest, { trustedTeacherKey: pc.teacherKey, sessionId: pc.sessionId, resourceId: r.id });
  if (!v.ok || v.payload.sha256 !== r.sha256 || v.payload.size !== r.size) throw new TransferError('bad_manifest', `Resource manifest rejected: ${v.ok ? 'does not match the listed file' : v.reason}.`);
  const m = v.payload;
  const store = await FsChunkStore.open(o.destDir, m);
  o.onStore?.(store, manifest);
  const teacher = teacherSource(o.transport, o.url, o.token, m);
  let lastSources = o.cachedSources ?? [];
  // One signed proof per (capability, serving peer) — not per chunk.
  const authCache = new Map<string, { capId: string; header: string }>();
  const auth = async (servingFp: string) => {
    const cap = await pc.capability();
    const hit = authCache.get(servingFp);
    if (hit?.capId === cap.payload.capId) return hit.header;
    const header = await peerAuthHeader(cap, pc.device, servingFp);
    authCache.set(servingFp, { capId: cap.payload.capId, header });
    return header;
  };
  const transportFor = pc.transportFor ?? ((e: PeerEndorsement) => pinnedTransport({ certificate: e.payload.tlsCa, spkiSha256: e.payload.tlsSpkiSha256 }));
  const peerCache = new Map<string, Source & { setHave(b64: string): void }>(); // one source + TLS agent per peer identity
  let swarmSize = lastSources.length;
  const sources = async (): Promise<Source[]> => {
    try {
      const s = await api<{ peerAssist: boolean; sources: PeerInfo[]; swarm: number }>(o.transport, o.url, o.token, `/api/peer/sources/${r.id}`);
      lastSources = s.sources;
      swarmSize = s.swarm;
      o.onSources?.(s.sources);
    } catch {
      // Teacher unreachable: keep the last known peers, and ask THEM what they hold now (authenticated, pinned).
      lastSources = await Promise.all(lastSources.map(async (p) => {
        try {
          const t = transportFor(p.endorsement);
          const res = await t.fetch(`${p.url}/peer/v1/have/${r.id}`, { headers: { authorization: await auth(p.fingerprint) } });
          if (res.status === 200) { const b = await res.json() as { chunks: string }; return { ...p, have: b.chunks }; }
          await res.body?.cancel();
        } catch { /* peer gone too */ }
        return p;
      }));
    }
    const list: Source[] = [teacher];
    for (const info of lastSources) {
      if (info.fingerprint === keyFingerprint(pc.device.publicKey)) continue;
      const key = `${info.fingerprint}|${info.url}|${info.endorsement.payload.tlsSpkiSha256}`;
      let s = peerCache.get(key);
      if (!s) { s = peerSource({ info, teacherKey: pc.teacherKey, sessionId: pc.sessionId, transportFor, auth, m }) ?? undefined; if (s) peerCache.set(key, s); }
      else s.setHave(info.have);
      if (s) list.push(s);
    }
    return list;
  };
  const total = m.size;
  let have = 0;
  for (let i = 0; i < m.chunks.length; i++) if (store.isDone(i)) have += Math.min(m.chunkSize, m.size - i * m.chunkSize);
  const resumedFrom = have;
  o.onProgress?.({ state: 'downloading', bytes: have, size: total, resumedFrom });
  await sources();
  // My slice of the file: what I take from the teacher immediately. With S other peers, ~1/(S+1) of the chunks.
  const n = m.chunks.length;
  const start = (((o.startOffset ?? 0) % n) + n) % n;
  const slice = Math.max(1, Math.ceil(n / (swarmSize + 1)));
  const ownChunk = (i: number) => ((i - start + n) % n) < slice;
  let res: AcquireResult;
  try {
    res = await acquireChunks({
    manifest: m, store, sources, sha256: sha256Hex, preferPeers: true, signal: o.signal, ownChunk, refreshMs: 500,
    startOffset: o.startOffset, concurrency: o.concurrency, chunkTimeoutMs: o.chunkTimeoutMs, stallTimeoutMs: o.stallTimeoutMs,
    onChunk: (_i, s, n) => { have += n; o.onProgress?.({ state: 'downloading', bytes: have, size: total, resumedFrom, sources: [s.id] }); },
    });
  } catch (e) {
    await store.close(); // flush verified-chunk marks so a later attempt (either mode) keeps the progress
    throw e;
  }
  o.onProgress?.({ state: 'verifying', bytes: total, size: total, resumedFrom });
  const path = await store.finalize(o.destDir);
  o.onProgress?.({ state: 'completed', bytes: total, size: total, resumedFrom });
  const teacherBytes = res.sources.filter((s) => s.kind === 'teacher').reduce((a, s) => a + s.bytes, 0);
  return { path, manifest, stats: { mode: 'swarm', ...res, teacherBytes, peerBytes: res.sources.filter((s) => s.kind === 'peer').reduce((a, s) => a + s.bytes, 0) } };
}

/** What a completed local file can offer peers: every chunk (re-hashed lazily is unnecessary — the file was verified). */
export async function completedFileReader(path: string, m: ManifestPayload) {
  const fh = await open(path, 'r');
  return {
    async read(i: number) {
      const len = Math.min(m.chunkSize, m.size - i * m.chunkSize);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, i * m.chunkSize);
      return buf;
    },
    have: () => { const b = bitfield.empty(m.chunks.length); for (let i = 0; i < m.chunks.length; i++) bitfield.set(b, i); return b; },
    close: () => fh.close(),
  };
}

export { doneBitfield };

// ---- PeerAgent: one device's participation in the data plane (desktop main, tests, simulator) ----

export type AgentOptions = {
  transport: Transport; url: string; token(): string; sessionId: string; teacherKey: string; device: DeviceSigner;
  /** LAN address to serve on (only classroom interfaces — never anything internet-facing). */
  host: string; destDir: string;
  /** Platform capability + user/teacher choice. Downloading from peers works either way. */
  canSeed: boolean; limits?: Partial<PeerServerLimits>;
  transportFor?(e: PeerEndorsement): Transport;
};

/** The desktop/Node ResourceTransport: teacher-direct or peer-assisted, seeding what it verifies. */
export class PeerAgent implements ResourceTransport {
  private o: AgentOptions;
  private server: PeerServer | null = null;
  private tls: ClassroomTls | null = null;
  private offered = new Map<string, { manifest: SignedManifest; read(i: number): Promise<Uint8Array | null>; have(): Uint8Array }>();
  private denied = new Set<string>();
  private cap: PeerCapability | null = null;
  private announceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private endorsedUntil = 0;
  paused = false;
  readonly fingerprint: string;

  /** Deterministic per-device start chunk, so early downloaders fetch different chunks from the teacher and can trade. */
  private readonly spread: number;
  private readers: { close(): Promise<void> }[] = [];
  private stores = new Set<FsChunkStore>();

  constructor(o: AgentOptions) {
    this.o = o;
    this.fingerprint = keyFingerprint(o.device.publicKey);
    const b = b64u.decode(this.fingerprint);
    this.spread = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }

  private call<T>(path: string, body: unknown) {
    return api<T>(this.o.transport, this.o.url, this.o.token(), path, { method: 'POST', body: JSON.stringify(body) });
  }

  /** Start serving (if allowed) and get the teacher's endorsement of this peer's TLS identity. */
  async start() {
    if (!this.o.canSeed || this.server) return;
    this.tls = await createClassroomTls(`peer-${this.fingerprint.slice(0, 12)}`, Date.now(), 25 * 60 * 60_000);
    this.server = await startPeerServer({
      host: this.o.host, tls: this.tls, sessionId: this.o.sessionId, teacherKey: this.o.teacherKey, selfFingerprint: this.fingerprint,
      lookup: (id) => this.offered.get(id) ?? null, isDenied: (fp) => this.denied.has(fp), paused: () => this.paused, limits: this.o.limits,
    });
    this.statsTimer = setInterval(() => { void this.call('/api/peer/stats', { v: 1, uploadedBytes: this.uploadedBytes() }).catch(() => {}); }, 2000);
    this.statsTimer.unref?.();
    await this.endorse().catch(() => {}); // peer assistance may be off right now; retried by ensureEndorsed()
  }

  /** (Re)register with the teacher. Needed when peer assistance turns on and before the endorsement expires. */
  async endorse() {
    if (!this.server || !this.tls) return;
    const e = await this.call<PeerEndorsement>('/api/peer/endorse', { v: 1, tlsCa: this.tls.certificate, tlsSpkiSha256: this.tls.spkiSha256, port: this.server.port });
    this.endorsedUntil = e.payload.expiresAt;
    for (const id of this.offered.keys()) this.announce(id, 0);
  }
  /** Endorse if we never managed to (e.g. we were still pending approval) or the endorsement is about to expire. */
  async ensureEndorsed() { if (this.server && Date.now() > this.endorsedUntil - 5 * 60_000) await this.endorse(); }

  /** Revocations pushed by the teacher: refuse those devices immediately. */
  deny(fingerprints: string[]) { for (const f of fingerprints) this.denied.add(f); }

  uploadedBytes() { return this.server?.uploadedBytes() ?? 0; }
  get serving() { return !!this.server; }

  peerContext(): PeerContext {
    return {
      device: this.o.device, teacherKey: this.o.teacherKey, sessionId: this.o.sessionId, transportFor: this.o.transportFor,
      capability: async () => {
        if (!this.cap || this.cap.payload.expiresAt - Date.now() < 60_000) this.cap = await this.call<PeerCapability>('/api/peer/capability', {});
        return this.cap;
      },
    };
  }

  /** Offer a resource's verified chunks to peers and tell the teacher (debounced). */
  offer(manifest: SignedManifest, source: { read(i: number): Promise<Uint8Array | null>; have(): Uint8Array }) {
    this.offered.set(manifest.payload.resourceId, { manifest, ...source });
    this.announce(manifest.payload.resourceId, 0);
  }

  private announce(resourceId: string, delay = 150) {
    if (!this.server || this.announceTimers.has(resourceId)) return;
    this.announceTimers.set(resourceId, setTimeout(() => {
      this.announceTimers.delete(resourceId);
      const r = this.offered.get(resourceId);
      if (r) void this.ensureEndorsed().then(() => this.call('/api/peer/have', { v: 1, resourceId, chunks: b64u.encode(r.have()) })).catch(() => {});
    }, delay));
  }

  /** Acquire (peer-assisted when on), seeding verified chunks while downloading and the whole file afterwards. */
  async acquire(resource: Pick<ResourceView, 'id' | 'name' | 'size' | 'sha256'>, opts: { peerAssist: boolean; signal?: AbortSignal; onProgress?: Parameters<typeof acquireResource>[0]['onProgress']; startOffset?: number; cachedSources?: PeerInfo[]; cachedManifest?: SignedManifest; chunkTimeoutMs?: number; stallTimeoutMs?: number; smallFileBytes?: number; onSources?(s: PeerInfo[]): void }) {
    if (opts.peerAssist) await this.ensureEndorsed().catch(() => {}); // become a source as soon as we're approved
    const out = await acquireResource({
      transport: this.o.transport, url: this.o.url, token: this.o.token(), resource, destDir: this.o.destDir,
      peerAssist: opts.peerAssist, peers: this.peerContext(), signal: opts.signal, startOffset: opts.startOffset ?? this.spread,
      cachedSources: opts.cachedSources, cachedManifest: opts.cachedManifest, chunkTimeoutMs: opts.chunkTimeoutMs, stallTimeoutMs: opts.stallTimeoutMs, onSources: opts.onSources, smallFileBytes: opts.smallFileBytes,
      onStore: (store, manifest) => { this.stores.add(store); this.offer(manifest, { read: (i) => store.read(i), have: () => doneBitfield(store) }); },
      onProgress: (p) => { opts.onProgress?.(p); if (p.state === 'downloading') this.announce(resource.id); },
    });
    // Seed whatever we completed, including files that came by teacher streaming (when we are allowed to seed).
    const manifest = out.manifest ?? (this.server ? await api<SignedManifest>(this.o.transport, this.o.url, this.o.token(), `/api/resources/${resource.id}/manifest`).catch(() => null) : null);
    if (manifest) {
      out.manifest = manifest;
      const reader = await completedFileReader(out.path, manifest.payload);
      this.readers.push(reader);
      this.offer(manifest, { read: (i) => reader.read(i), have: reader.have });
    }
    return out;
  }

  async stop() {
    for (const t of this.announceTimers.values()) clearTimeout(t);
    if (this.statsTimer) clearInterval(this.statsTimer);
    await this.server?.close();
    this.server = null;
    await Promise.all([...this.stores].map((store) => store.close()));
    this.stores.clear();
    await Promise.all(this.readers.splice(0).map((r) => r.close().catch(() => {})));
  }
}

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline, Transform, type Readable } from 'node:stream';
import websocket from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import { generateKeyPairSync, sign as edSign, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import {
  b64u, BleRequest, ClientMessage, DIRECT_PACKAGE_TTL_MS, MESSAGE_CAPABILITY, type BleResponse, type DirectPackage, JoinRequest, PairAbort, PairFinish, PairStart, ReconnectChallengeRequest, ReconnectRequest, STUDENT_ONLY, TEACHER_ONLY,
  UPLOAD_CONTENT_TYPE, UploadInit, WS_CLOSE, ShareUploadInit, ChatHandle, hostSessionStatement, type AuthorityRecord, type HostResolution, type ServerMessage, type ResourceView,
} from '@classroom/protocol';
import { ChatRelay, type ChatStore } from './chat.ts';
import { WhiteboardRelay, type WhiteboardStore } from './whiteboard.ts';
import { Shares } from './shares.ts';
import { Pairing } from './pairing.ts';
import { PeerRegistry } from './peers.ts';
import { z } from 'zod';
import { logError } from './redact.ts';
import { createClassroomTls } from './tls.ts';
import { Assignments } from './assignments.ts';
import { Resources } from './resources.ts';
import { ApiError, contentDisposition, DEFAULT_LIMITS, parseRange, RateLimit, Storage, UUID_RE, type Limits } from './storage.ts';
import { Classroom, JoinError, type ClanSession, type NetworkMode, type Principal } from './classroom.ts';
import { MediaService } from './media.ts';
import { mediaIdentity, Presentations } from './presentation.ts';
import { WebSocket as UpstreamSocket } from 'ws';
import { openDb, type Db } from './db.ts';
import { advertise } from './discovery.ts';

export type ServerOptions = {
  title: string;
  /** CLAN this session hosts (type drives capabilities). Omitted → a classroom, as before. */
  clan?: ClanSession;
  /** Host's canonical display name; members see it only after pairing (never in discovery). */
  hostName?: string;
  /** Chat store (desktop host: @clan/core's Chat on the device database). Omitted → chat unavailable. */
  chat?: ChatStore;
  /** Whiteboard store (desktop host: @clan/core's Whiteboard). Omitted → no whiteboard. */
  whiteboard?: WhiteboardStore;
  /** Local SFU for screen sharing (desktop host: bundled livekit-server). Omitted → screen sharing unavailable. */
  media?: { binary: string; workDir: string; presenterGraceMs?: number };
  /** Direct network credentials: released, sealed, only inside a completed OPAQUE exchange. */
  direct?: Omit<DirectPackage, 'v' | 'sessionId' | 'bootstrapPort'>;
  /** Interface address to bind. Never 0.0.0.0 in the product: bind only the classroom interface. */
  host: string;
  port?: number;
  dbPath?: string;
  db?: Db;
  networkMode?: NetworkMode;
  /** Publish over DNS-SD. Off in tests. */
  advertise?: boolean;
  code?: string;
  /**
   * Teacher's long-lived secrets (desktop: decrypted from OS secure storage). Omitted -> ephemeral per run
   * (tests, CLI). `signingKey` signs receipts; `opaqueServerSetup` is the OPAQUE server setup.
   */
  identity?: TeacherIdentity;
  /** Managed file storage root (teacher app: <userData>/storage). Defaults to a fresh temp dir. */
  storageDir?: string;
  limits?: Partial<Limits>;
  /**
   * Persistent hosting (docs/PHASE_14_2_HOSTING_DESIGN.md): `assertWritable` throws unless this device still holds the
   * CLAN's current hosting epoch; it guards the session start and every authoritative write. Members receive the chain
   * and `sign` (the host device key) over this session's identity inside the authenticated session, to anchor the owner
   * and verify the session's host. Omitted → a legacy single-host CLAN, unchanged.
   */
  authority?: { assertWritable(): void; chain(): AuthorityRecord[]; sign(bytes: Uint8Array): string; resolutions?(): HostResolution[] };
};
/** Client messages that change nothing durable (ephemeral relays and reads); everything else is fenced. */
const UNFENCED = new Set<ClientMessage['t']>(['wb.sync', 'wb.cursor', 'chat.typing']);

export type TeacherIdentity = { signingKey: KeyObject; opaqueServerSetup: string };

export async function ephemeralIdentity(): Promise<TeacherIdentity> {
  await opaque.ready;
  return { signingKey: generateKeyPairSync('ed25519').privateKey, opaqueServerSetup: opaque.server.createSetup() };
}

export type RunningServer = {
  classroom: Classroom;
  peers: PeerRegistry;
  /** HTTPS base URL (everything after pairing). */
  url: string;
  /** Plaintext bootstrap URL: only /api/info and the OPAQUE pairing endpoints. Advertised over DNS-SD. */
  bootstrapUrl: string;
  tls: { certificate: string; spkiSha256: string; notAfter: number };
  teacherPublicKey: string;
  resources: Resources;
  presentations: Presentations;
  media: MediaService | null;
  chat: ChatRelay | null;
  whiteboard: WhiteboardRelay | null;
  shares: Shares;
  /** Host, in-process: add a file for the whole CLAN ('clan') or for one CLANmate (their chat handle). */
  shareFile(path: string, to: string, name?: string): Promise<ResourceView>;
  assignments: Assignments;
  storage: Storage;
  port: number;
  bootstrap(source: string, req: unknown): BleResponse;
  pairingStats(): { failed: number; throttled: { network: number; bluetooth: number } };
  close(): Promise<void>;
};

const AUTH_TIMEOUT_MS = 5000;
/** Seed a resource to a few peers when it spans at least this many chunks. */
const SEED_MIN_CHUNKS = 8;
const SEEDERS = 4;
const MAX_WS_MESSAGE = 64 * 1024;
const WS_MAX_PER_SECOND = 300;
/** Media signalling proxy bounds: concurrent sockets, and frames queued while the SFU side connects. */
const MEDIA_MAX_SOCKETS = 256, MEDIA_MAX_QUEUED = 64;
/** Splits items into batches whose JSON stays under `max` bytes. */
const sizedChunks = <T>(items: T[], max: number) => { const out: T[][] = []; let cur: T[] = [], n = 0; for (const it of items) { const b = JSON.stringify(it).length; if (cur.length && n + b > max) { out.push(cur); cur = []; n = 0; } cur.push(it); n += b; } if (cur.length) out.push(cur); return out; };

export async function startClassroomServer(opts: ServerOptions): Promise<RunningServer> {
  const db = opts.db ?? openDb(opts.dbPath ?? ':memory:');
  const fence = () => {
    if (!opts.authority) return;
    try { opts.authority.assertWritable(); } catch (e) { throw new ApiError(503, 'host_unavailable', (e as Error).message || 'This device is not the CLAN\'s current host.'); }
  };
  fence(); // never open a session for a CLAN this device does not currently host
  const classroom = new Classroom(db, opts.title, opts.networkMode ?? 'lan', { code: opts.code, clan: opts.clan, hostName: opts.hostName });
  const identity = opts.identity ?? (await ephemeralIdentity());
  const teacherPublicKey = b64u.encode(new Uint8Array(createPublicKey(identity.signingKey).export({ type: 'spki', format: 'der' }).subarray(-32)));
  const signer = { publicKey: teacherPublicKey, sign: (bytes: Uint8Array) => b64u.encode(new Uint8Array(edSign(null, bytes, identity.signingKey))) };
  const sessionAuthority = opts.authority && (() => {
    const chain = opts.authority!.chain(), head = chain[chain.length - 1]!;
    const resolutions = opts.authority!.resolutions?.() ?? [];
    return { chain, proof: opts.authority!.sign(hostSessionStatement({ clanId: head.clanId, epoch: head.epoch, sessionId: classroom.id, teacherPublicKey })), ...(resolutions.length ? { resolutions } : {}) };
  });
  const tls = await createClassroomTls(classroom.id);
  db.prepare('UPDATE sessions SET teacher_key = ?, tls_spki = ?, connectivity = ? WHERE id = ?').run(teacherPublicKey, tls.spkiSha256, opts.direct ? 'direct' : 'lan', classroom.id);
  let httpsPort = 0;
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const pairing = await Pairing.create(classroom, identity.opaqueServerSetup, classroom.code, () => ({
    httpsPort, spkiSha256: tls.spkiSha256, certificate: tls.certificate, teacherPublicKey, title: classroom.title,
  }));
  pairing.inflightPerSource = limits.pairInflightPerSource;
  let bootPort = 0;
  if (opts.direct) pairing.direct = () => ({ v: 1, sessionId: classroom.id, bootstrapPort: bootPort, ...opts.direct!, expiresAt: Math.min(opts.direct!.expiresAt, Date.now() + DIRECT_PACKAGE_TTL_MS) });
  const ownStorage = !opts.storageDir; // ephemeral storage (tests, CLI) is deleted on close
  const storage = new Storage(opts.storageDir ?? mkdtempSync(join(tmpdir(), 'classroom-storage-')));
  await storage.init();
  const resources = new Resources(db, classroom, storage, limits, signer);
  const peers = new PeerRegistry(classroom, signer);
  const media = opts.media ? new MediaService({ binary: opts.media.binary, host: opts.host, workDir: opts.media.workDir }) : null;
  const presentations = new Presentations(db, classroom, media, { hostName: opts.hostName, graceMs: opts.media?.presenterGraceMs });
  const assignments = new Assignments(db, classroom, storage, limits, signer);
  const chat = opts.chat ? new ChatRelay({ store: opts.chat, classroom, resources, teacherPublicKey, hostName: opts.hostName ?? null }) : null;
  resources.who = (p) => { try { return chat?.handleOf(p) ?? null; } catch { return null; } };
  const authorOf = (p: Principal) => { try { return chat?.handleOf(p) ?? (p.role === 'teacher' ? 'host' : p.memberId); } catch { return p.role === 'teacher' ? 'host' : p.memberId; } };
  const whiteboard = opts.whiteboard ? new WhiteboardRelay({ store: opts.whiteboard, classroom, resources, presentations, author: authorOf,
    name: (p) => (p.role === 'teacher' ? opts.hostName ?? 'Host' : classroom.member(p.memberId)?.fullName ?? 'Someone') }) : null;
  resources.nameOf = (h) => chat?.nameOfHandle(h) ?? 'Someone';
  const shares = new Shares(db, classroom, storage, limits, resources);
  resources.guard = assignments.guard = shares.guard = fence; // async writes re-check at their commit point
  if (chat) {
    shares.audience = (memberId, to) => chat.audience({ role: 'student', memberId }, to);
    shares.senderHandle = (memberId) => chat.handleOf({ role: 'student', memberId });
  } else shares.audience = (memberId, to) => {
    if (!classroom.can({ role: 'student', memberId }, 'SEND_FILES')) throw new ApiError(403, 'forbidden', 'You cannot share files in this CLAN.');
    if (to !== 'clan') throw new ApiError(503, 'chat_unavailable', 'Sending to one person is not available here.');
    return null;
  };
  await resources.sweepRemoved();
  await assignments.sweep();
  const downloadRate = new RateLimit(limits.downloadRequestsPerMinute, 60_000);

  // requestTimeout 0: large uploads on slow Wi-Fi are legitimate; stalls are caught by per-transfer idle watchdogs.
  // forceCloseConnections: ending the class must not wait out keep-alive sockets (72 s) that were mid-response.
  // HTTPS (TLS 1.3, per-session certificate) carries every classroom API. No CORS: clients are native apps.
  const app = Fastify({
    https: { cert: tls.certPem, key: tls.keyPem, minVersion: 'TLSv1.3' },
    bodyLimit: 16 * 1024, trustProxy: false, requestTimeout: 0, forceCloseConnections: true, logger: false,
  });
  // Native clients send no Origin; the Electron renderer sends file:// (or the local dev server). Web pages may not open sockets.
  const allowedOrigin = (o: string | undefined) => !o || o === 'file://' || o === 'null' || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o);
  await app.register(websocket, { options: { maxPayload: MAX_WS_MESSAGE, verifyClient: (info: { origin?: string }) => allowedOrigin(info.origin) } });
  // Plaintext bootstrap: OPAQUE only. Nothing here is secret or authorizes anything by itself.
  const boot = Fastify({ bodyLimit: 16 * 1024, trustProxy: false, forceCloseConnections: true, logger: false });

  for (const a of [app, boot] as unknown as FastifyInstance[]) {
    a.removeContentTypeParser('text/plain'); // JSON (and raw upload bytes on HTTPS) only
    a.addHook('onRequest', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
      if (req.method !== 'GET' && req.method !== 'HEAD') fence(); // joins, uploads, shares, reviews, leave: authoritative writes
    });
    a.setErrorHandler((err: Error, _req, reply) => {
      if (err instanceof ApiError || err instanceof JoinError || err.name === 'ChatError') {
        const e = err as ApiError;
        if (e.status === 429) reply.header('retry-after', Math.max(1, Math.ceil(((err as JoinError).retryAfterMs ?? 1000) / 1000)));
        return reply.code(e.status).send({ code: e.code, message: e.message, ...(e.extra ?? {}) });
      }
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status < 500) return reply.code(status).send({ code: 'invalid', message: 'Invalid request.' });
      logError('request failed', err);
      return reply.code(500).send({ code: 'internal', message: 'Something went wrong on the teacher computer.' });
    });
  }
  const parse = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, body: unknown): T => {
    const r = schema.safeParse(body);
    if (!r.success) throw new ApiError(400, 'invalid', r.error.issues[0]?.message ?? 'Invalid request');
    return r.data;
  };

  boot.get('/api/info', async () => ({ product: 'classroom-lan', protocol: 1, title: classroom.title, sessionId: classroom.id }));
  boot.post('/api/pair/start', async (req) => {
    const b = parse(PairStart, req.body);
    return pairing.start(req.ip, b.sessionId, b.startLoginRequest);
  });
  boot.post('/api/pair/abort', async (req, reply) => {
    const b = parse(PairAbort, req.body);
    pairing.abort(req.ip, b.pairingId);
    return reply.code(204).send();
  });
  boot.post('/api/pair/finish', async (req) => {
    const b = parse(PairFinish, req.body);
    return pairing.finish(req.ip, b.pairingId, b.finishLoginRequest);
  });

  // ---- HTTPS: join / reconnect ----
  app.post('/api/join', async (req) => {
    const b = parse(JoinRequest, req.body);
    pairing.verifyJoin(b);
    return { ...classroom.join(b.profile), classroom: classroom.info() };
  });
  const reconnectRate = new RateLimit(30, 60_000);
  app.post('/api/reconnect/challenge', async (req) => {
    if (!reconnectRate.take(req.ip)) throw new ApiError(429, 'rate_limited', 'Too many attempts.');
    const b = parse(ReconnectChallengeRequest, req.body);
    return pairing.reconnectChallenge(b.devicePublicKey);
  });
  app.post('/api/reconnect', async (req) => {
    const b = parse(ReconnectRequest, req.body);
    const fp = pairing.verifyReconnect(b.challengeId, b.devicePublicKey, b.signature);
    return { ...classroom.reconnect(fp), classroom: classroom.info() };
  });

  // Uploads are streamed straight to disk; never buffered by a body parser.
  app.addContentTypeParser(UPLOAD_CONTENT_TYPE, (_req, payload, done) => done(null, payload));

  /** Every file/assignment route goes through here: valid unexpired token, this session, approved (or teacher). */
  const auth = (req: FastifyRequest): Principal => {
    const m = /^Bearer ([\w-]{16,128})$/.exec(req.headers.authorization ?? '');
    const p = m ? classroom.authenticate(m[1]!) : null;
    if (!p || classroom.info().ended) throw new ApiError(401, 'unauthorized', 'Your session is not valid. Join the class again.');
    if (p.role === 'student' && classroom.status(p.memberId) !== 'approved') throw new ApiError(403, 'forbidden', 'You are not an active member of this class.');
    return p;
  };
  const studentOnly = (p: Principal) => {
    if (p.role !== 'student') throw new ApiError(403, 'forbidden', 'Students only.');
    return p.memberId;
  };
  // A member can relinquish only its own session rights. No caller-chosen member ID or host privilege.
  app.post('/api/member/leave', async (req) => {
    const memberId = studentOnly(auth(req));
    const body = parse(z.object({ clanId: z.uuid() }).strict(), req.body);
    const clanId = classroom.clan.id ?? classroom.id;
    if (body.clanId !== clanId) throw new ApiError(403, 'wrong_clan', 'This connection belongs to another CLAN.');
    classroom.setStatus(memberId, 'removed'); // existing removal path revokes tokens, peer/media rights and WSS
    return { clanId, sessionId: classroom.id, left: true };
  });
  const uuidParam = (req: FastifyRequest) => {
    const id = (req.params as { id: string }).id;
    if (!UUID_RE.test(id)) throw new ApiError(404, 'not_found', 'Not found.');
    return id;
  };
  /** Destroys a transfer that makes no progress for limits.transferIdleMs (frees its slot and fd). */
  const watchdog = (onIdle: () => void) => {
    let last = Date.now();
    const t = setInterval(() => { if (Date.now() - last > limits.transferIdleMs) { clearInterval(t); onIdle(); } }, Math.min(5000, limits.transferIdleMs));
    return { touch: () => { last = Date.now(); }, stop: () => clearInterval(t) };
  };

  app.get('/api/resources', async (req) => {
    const p = auth(req);
    return { resources: p.role === 'teacher' ? resources.listForTeacher() : resources.listForStudent(p) };
  });

  app.get('/api/resources/:id/content', async (req, reply) => {
    const p = auth(req);
    const id = uuidParam(req);
    const key = p.role === 'teacher' ? 'teacher' : p.memberId;
    if (!downloadRate.take(key)) throw new ApiError(429, 'rate_limited', 'Too many download requests. Slow down.');
    const f = resources.openForDownload(p, id);
    const etag = `"${f.sha256}"`;
    let range = parseRange(req.headers.range, f.size);
    // If-Range with a different version: ignore the range and send the whole current file (client restarts).
    if (range && range !== 'invalid' && req.headers['if-range'] !== undefined && req.headers['if-range'] !== etag) range = null;
    if (range === 'invalid') {
      reply.header('content-range', `bytes */${f.size}`);
      throw new ApiError(416, 'bad_range', 'Requested range not satisfiable.');
    }
    if (!resources.begin(key)) throw new ApiError(429, 'busy', 'The teacher computer is busy. Retrying shortly.');
    let finished = false;
    const file = createReadStream(f.path, range ? { start: range.start, end: range.end } : {});
    const dog = watchdog(() => { file.destroy(); reply.raw.destroy(); });
    // Count through a transform (not a 'data' listener) so backpressure and byte order are untouched.
    const stream = new Transform({ transform(c: Buffer, _e, cb) { dog.touch(); resources.count(c.length); cb(null, c); } });
    pipeline(file, stream, () => {});
    file.on('end', () => { finished = true; });
    reply.raw.on('close', () => { dog.stop(); file.destroy(); resources.end(key, finished); });
    reply
      .code(range ? 206 : 200)
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', contentDisposition(f.name))
      .header('accept-ranges', 'bytes')
      .header('etag', etag)
      .header('repr-digest', `sha-256=:${Buffer.from(f.sha256, 'hex').toString('base64')}:`)
      .header('content-length', range ? range.end - range.start + 1 : f.size);
    if (range) reply.header('content-range', `bytes ${range.start}-${range.end}/${f.size}`);
    return reply.send(stream);
  });

  // ---- data plane (Milestone 2.75): manifests, peer endorsement/capabilities/sources. Control stays here. ----
  app.get('/api/resources/:id/manifest', async (req) => resources.manifest(auth(req), uuidParam(req)));
  const b64 = (max: number) => z.string().max(max).regex(/^[A-Za-z0-9+/_=-]*$/);
  app.post('/api/peer/endorse', async (req) => {
    const memberId = studentOnly(auth(req));
    if (!classroom.info().peerAssist) throw new ApiError(409, 'peer_assist_off', 'Peer assistance is off.');
    const b = parse(z.object({ v: z.literal(1), tlsCa: b64(8192), tlsSpkiSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/), port: z.number().int().min(1).max(65535) }), req.body);
    const e = peers.endorse(memberId, b, req.ip);
    // Never assume P2P: the first time two members have peer servers, ask the newer one to reach the others.
    const targets = peers.urls(memberId);
    if (classroom.p2p === 'unknown' && !probe && targets.length) {
      probe = { id: randomUUID(), memberId, timer: setTimeout(() => { probe = null; }, 15_000) };
      for (const [ws, p] of sockets) if (p.role === 'student' && p.memberId === memberId) send(ws, { t: 'peer.probe', probeId: probe.id, targets });
    }
    return e;
  });
  app.post('/api/peer/capability', async (req) => peers.capability(studentOnly(auth(req))));
  app.post('/api/peer/have', async (req, reply) => {
    const memberId = studentOnly(auth(req));
    const b = parse(z.object({ v: z.literal(1), resourceId: z.uuid(), chunks: b64(16384) }), req.body);
    const m = resources.manifest({ role: 'student', memberId }, b.resourceId);
    peers.have(memberId, b.resourceId, b.chunks, m.payload.chunks.length);
    return reply.code(204).send();
  });
  app.post('/api/peer/stats', async (req, reply) => {
    const memberId = studentOnly(auth(req));
    peers.stats(memberId, parse(z.object({ v: z.literal(1), uploadedBytes: z.number().int().nonnegative() }), req.body).uploadedBytes);
    return reply.code(204).send();
  });
  app.get('/api/peer/sources/:id', async (req) => {
    const p = auth(req);
    const id = uuidParam(req);
    resources.manifest(p, id); // same visibility as the resource itself
    const on = classroom.info().peerAssist, me = p.role === 'student' ? p.memberId : '';
    return { peerAssist: on, sources: on ? peers.sources(id, me) : [], swarm: on ? peers.swarm(me) : 0 };
  });

  // Media credential: only after normal CLAN authentication; scoped to this session's random room and this member.
  app.post('/api/media/token', async (req) => {
    const p = auth(req);
    if (!media) throw new ApiError(503, 'media_unavailable', 'Screen sharing is not available on this host.');
    const identity = mediaIdentity(p);
    const name = p.role === 'teacher' ? (opts.hostName ?? 'Host') : classroom.member(p.memberId)!.fullName;
    try {
      const t = await media.token({ identity, name, canPublish: presentations.current?.identity === identity });
      return { token: t.token, identity, expiresAt: t.expiresAt, codec: media.codec };
    } catch (e) { throw new ApiError(503, 'media_unavailable', (e as Error).message); }
  });
  // LiveKit signalling, carried inside the pinned CLAN TLS channel to the loopback-only SFU.
  let mediaSockets = 0;
  app.register(async (scope) => {
    scope.route({
      method: 'GET', url: '/media/*',
      handler: async (req, reply) => {
        if (media?.state !== 'ready') return reply.code(503).send({ code: 'media_unavailable' });
        const r = await fetch(`http://127.0.0.1:${new URL(media.signalUrl).port}${req.url.slice('/media'.length)}`).catch(() => null);
        return reply.code(r?.status ?? 502).send(r ? await r.text() : '');
      },
      wsHandler: (ws, req) => {
        if (media?.state !== 'ready') return ws.close(1013, 'media unavailable');
        if (mediaSockets >= MEDIA_MAX_SOCKETS) return ws.close(1013, 'too many media connections');
        mediaSockets++;
        const up = new UpstreamSocket(media.signalUrl + req.url.slice('/media'.length));
        const queue: Buffer[] = [];
        up.on('open', () => { for (const m of queue.splice(0)) up.send(m); });
        up.on('message', (d, bin) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: bin }); });
        ws.on('message', (d: Buffer, bin: boolean) => { if (up.readyState === up.OPEN) up.send(d, { binary: bin }); else if (queue.length < MEDIA_MAX_QUEUED) queue.push(d); else ws.close(1008, 'too much before connect'); });
        let ended = false;
        const end = () => { if (!ended) { ended = true; mediaSockets--; } if (up.readyState <= 1) up.close(); if (ws.readyState <= 1) ws.close(); };
        up.on('close', end); up.on('error', end); ws.on('close', end); ws.on('error', end);
      },
    });
  });

  // ---- chat (history; live delivery is on the WSS) and member file shares ----
  const needChat = () => { if (!chat) throw new ApiError(503, 'chat_unavailable', 'Chat is not available on this host.'); return chat; };
  const seqParam = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
  app.get('/api/chat/threads', async (req) => needChat().threads(auth(req)));
  app.get('/api/chat/threads/:id/messages', async (req) => {
    const q = parse(z.object({ before: seqParam, after: seqParam, limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    return needChat().page(auth(req), uuidParam(req), q);
  });
  app.post('/api/chat/direct', async (req) => needChat().openDirect(auth(req), parse(z.object({ to: ChatHandle }), req.body).to));
  app.get('/api/shares/pending', async (req) => ({ shares: shares.pending(auth(req)) }));
  app.post('/api/shares/:id/review', async (req) => shares.decide(auth(req), uuidParam(req), parse(z.object({ accept: z.boolean() }), req.body).accept));
  app.post('/api/shares', async (req, reply) => {
    const memberId = studentOnly(auth(req));
    const st = await shares.init(memberId, parse(ShareUploadInit, req.body));
    return reply.code(st.state === 'complete' ? 200 : 201).send(st);
  });
  app.get('/api/shares/:id', async (req) => shares.status(studentOnly(auth(req)), uuidParam(req)));
  app.put('/api/shares/:id', async (req) => {
    const body = req.body as Readable;
    try {
      const memberId = studentOnly(auth(req));
      const id = uuidParam(req);
      if (req.headers['content-type'] !== UPLOAD_CONTENT_TYPE) throw new ApiError(415, 'bad_content_type', `Use ${UPLOAD_CONTENT_TYPE}.`);
      const off = String(req.headers['upload-offset'] ?? '');
      if (!/^\d{1,15}$/.test(off)) throw new ApiError(400, 'bad_offset', 'Upload-Offset header required.');
      const dog = watchdog(() => req.raw.destroy());
      try { return await shares.append(memberId, id, Number(off), body, dog.touch); } finally { dog.stop(); }
    } catch (e) { body?.resume?.(); throw e; }
  });

  app.get('/api/assignments', async (req) => {
    const p = auth(req);
    return { assignments: p.role === 'teacher' ? assignments.listForTeacher() : assignments.listForStudent(p.memberId) };
  });

  app.post('/api/uploads', async (req, reply) => {
    const p = auth(req);
    if (!classroom.can(p, 'SUBMIT_ASSIGNMENT')) throw new ApiError(403, 'forbidden', 'This CLAN has no assignments.');
    const memberId = studentOnly(p);
    const body = UploadInit.safeParse(req.body);
    if (!body.success) throw new ApiError(400, 'invalid', body.error.issues[0]?.message ?? 'Invalid request');
    const st = await assignments.init(memberId, body.data);
    return reply.code(st.state === 'complete' ? 200 : 201).send(st);
  });

  app.get('/api/uploads/:id', async (req) => assignments.status(studentOnly(auth(req)), uuidParam(req)));

  app.put('/api/uploads/:id', async (req) => {
    const body = req.body as Readable;
    try {
      const memberId = studentOnly(auth(req));
      const id = uuidParam(req);
      if (req.headers['content-type'] !== UPLOAD_CONTENT_TYPE) throw new ApiError(415, 'bad_content_type', `Use ${UPLOAD_CONTENT_TYPE}.`);
      const off = String(req.headers['upload-offset'] ?? '');
      if (!/^\d{1,15}$/.test(off)) throw new ApiError(400, 'bad_offset', 'Upload-Offset header required.');
      // No 'data' listener here: that would switch the stream to flowing mode and drop bytes before the pipeline.
      const dog = watchdog(() => req.raw.destroy());
      try { return await assignments.append(memberId, id, Number(off), body, dog.touch); } finally { dog.stop(); }
    } catch (e) {
      body?.resume?.(); // drain so the error response can be delivered
      throw e;
    }
  });

  const sockets = new Map<WebSocket, Principal>();
  let probe: { id: string; memberId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let shuttingDown = false;
  const send = (ws: WebSocket, m: ServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  const toTeachers = (m: () => ServerMessage) => {
    let msg: ServerMessage | undefined;
    for (const [ws, p] of sockets) if (p.role === 'teacher') send(ws, (msg ??= m()));
  };
  const toAll = (m: ServerMessage) => { for (const ws of sockets.keys()) send(ws, m); };

  /** Names-only roster for members whose CLAN grants VIEW_MEMBERS (never device keys or ids). */
  const handles = () => chat?.handles() ?? new Map<string, string>();
  const memberRoster = (p: Principal): ServerMessage => {
    const h = handles();
    return { t: 'members', me: chat?.handleOf(p) ?? '', members: [{ name: classroom.hostName ?? 'Host', host: true, connected: true, handle: chat?.hostHandle ?? '' },
      ...classroom.roster().filter((m) => m.status === 'approved').map((m) => ({ name: m.fullName, host: false, connected: m.connected, handle: h.get(m.id) ?? '' }))] };
  };
  const hostRoster = (): ServerMessage => { const h = handles(); return { t: 'roster', members: classroom.roster().map((m) => (chat ? { ...m, handle: h.get(m.id) } : m)) }; };
  const toMembers = () => {
    for (const [ws, p] of sockets) if (p.role === 'student' && classroom.status(p.memberId) === 'approved' && classroom.can(p, 'VIEW_MEMBERS')) send(ws, memberRoster(p));
  };
  classroom.on('hands', () => { for (const [ws, p] of sockets) if (p.role === 'teacher' || classroom.status(p.memberId) === 'approved') send(ws, classroom.handView(p)); });
  classroom.on('roster', () => { toTeachers(hostRoster); toMembers(); schedule(); });

  // Coalesce bursts (40 students reporting progress) into at most one list broadcast per 150 ms.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => { pending ??= setTimeout(flush, 150); };
  const flush = () => {
    pending = null;
    if (shuttingDown) return;
    let teacherRes: ServerMessage | undefined, teacherAsg: ServerMessage | undefined;
    for (const [ws, p] of sockets) {
      if (p.role === 'teacher') {
        send(ws, (teacherRes ??= { t: 'resources', resources: resources.listForTeacher() }));
        send(ws, (teacherAsg ??= { t: 'assignments', assignments: assignments.listForTeacher() }));
      } else if (classroom.status(p.memberId) === 'approved') {
        send(ws, { t: 'resources', resources: resources.listForStudent(p) }); // per member: files sent to them personally
        send(ws, { t: 'assignments', assignments: assignments.listForStudent(p.memberId) });
      }
    }
  };
  resources.on('changed', schedule);
  assignments.on('changed', schedule);
  resources.on('push', (resourceId: string) => {
    for (const [ws, p] of sockets) if (p.role === 'student' && classroom.status(p.memberId) === 'approved') send(ws, { t: 'resource.push', resourceId });
    // Large file + peer assistance: ask a few active peers to start right away so the swarm forms early.
    const m = resources.manifest({ role: 'teacher' }, resourceId);
    if (classroom.info().peerAssist && m.payload.chunks.length >= SEED_MIN_CHUNKS) {
      const seeders = new Set(peers.pickSeeders(SEEDERS));
      for (const [ws, p] of sockets) if (p.role === 'student' && seeders.has(p.memberId)) send(ws, { t: 'resource.seed', resourceId });
    }
  });
  // Removal/blocking revokes the peer role and tells every peer to refuse that device from now on.
  classroom.on('member', (memberId: string, status: string) => {
    if (status === 'approved') for (const [ws, p] of sockets) if (p.role === 'student' && p.memberId === memberId) send(ws, classroom.handView(p));
    if (status === 'approved') return;
    void presentations.removed(memberId); // stops their presentation and drops their media connection now
    const fp = peers.revoke(memberId);
    if (fp) for (const [ws, p] of sockets) if (p.role === 'student') send(ws, { t: 'peer.revoked', fingerprints: [fp] });
  });
  /** Chat delivery: every socket whose principal may read the conversation gets it, with its own view of the thread. */
  type ChatThread = NonNullable<ReturnType<ChatStore['thread']>>;
  const toReaders = (t: ChatThread, m: (p: Principal) => ServerMessage | null) => {
    for (const [ws, p] of sockets) if (chat?.canRead(p, t)) { const x = m(p); if (x) send(ws, x); }
  };
  const deliver = (message: import('@classroom/protocol').ChatMessageView, t: ChatThread) => toReaders(t, (p) => ({ t: 'chat.message', message, thread: chat!.view(t, p) }));
  const statsTimer = setInterval(() => toTeachers(() => ({ t: 'stats', stats: resources.stats(assignments.activeUploads, peers.summary()) })), 1000);
  classroom.on('timeline', () => toTeachers(() => ({ t: 'timeline', events: classroom.timeline() })));
  classroom.on('state', () => {
    const info = classroom.info();
    for (const [ws, p] of sockets) send(ws, { t: 'class.state', classroom: { ...info, ...(sessionAuthority ? { authority: sessionAuthority() } : {}) }, capabilities: [...classroom.capabilities(p)] });
    if (info.ended) { void presentations.end().then(() => media?.close()); for (const ws of sockets.keys()) ws.close(WS_CLOSE.ended, 'class ended'); }
  });
  // Presentation control state to everyone; pending requests only to those who may decide on them.
  const presentationMsg = (p: Principal): ServerMessage => ({ t: 'presentation', state: presentations.view(), policy: presentations.policy, mine: presentations.mine(p),
    requests: classroom.can(p, 'MANAGE_PRESENTERS') ? [...presentations.requests.keys()].map((memberId) => ({ memberId, name: classroom.member(memberId)?.fullName ?? 'Someone' })) : [] });
  presentations.on('state', () => { for (const [ws, p] of sockets) if (p.role === 'teacher' || classroom.status(p.memberId) === 'approved') send(ws, presentationMsg(p)); wallToAll(); });
  /** Whiteboard: everyone who may see the board, each with their own view (can they edit / manage?). */
  const toBoard = (m: (p: Principal) => ServerMessage | null) => { if (whiteboard) for (const [ws, p] of sockets) if (whiteboard.canView(p)) { const x = m(p); if (x) send(ws, x); } };
  function wallToAll() { toBoard((p) => ({ t: 'wb.wall', mode: whiteboard!.wallMode(), by: whiteboard!.wallBy, board: whiteboard!.view(p) })); }
  media?.on('failed', () => { void presentations.stop('media_failed'); });
  classroom.on('member', (memberId: string, status: string) => {
    for (const [ws, p] of sockets) {
      if (p.role !== 'student' || p.memberId !== memberId) continue;
      send(ws, { t: 'member.status', status: status as never });
      if (status !== 'approved') ws.close(WS_CLOSE.removed, status);
      else { send(ws, presentationMsg(p)); if (whiteboard?.canView(p)) send(ws, { t: 'wb.wall', mode: whiteboard.wallMode(), by: whiteboard.wallBy, board: whiteboard.view(p) }); } // what they may do changed (e.g. Present appears once approved)
    }
  });

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (ws) => {
      let principal: Principal | null = null;
      const authTimer = setTimeout(() => ws.close(WS_CLOSE.authFailed, 'auth timeout'), AUTH_TIMEOUT_MS);

      // Ceiling across all message types (chat and board ops also have their own limits): a flooding socket is closed.
      let windowStart = Date.now(), inWindow = 0;
      let alive = true;
      const beat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, limits.socketHeartbeatMs);
      ws.on('pong', () => { alive = true; });
      ws.on('message', (raw) => {
        alive = true;
        const now = Date.now();
        if (now - windowStart >= 1000) { windowStart = now; inWindow = 0; }
        if (++inWindow > WS_MAX_PER_SECOND) return ws.close(WS_CLOSE.badMessage, 'too many messages');
        let msg: ClientMessage;
        try {
          const r = ClientMessage.safeParse(JSON.parse(String(raw)));
          if (!r.success) return send(ws, { t: 'error', code: 'invalid', message: 'Invalid message' });
          msg = r.data;
        } catch {
          return ws.close(WS_CLOSE.badMessage, 'bad json');
        }

        if (!principal) {
          if (msg.t !== 'auth') return ws.close(WS_CLOSE.authFailed, 'auth required');
          principal = classroom.authenticate(msg.token);
          clearTimeout(authTimer);
          if (!principal || classroom.info().ended) return ws.close(WS_CLOSE.authFailed, 'invalid or expired session');
          sockets.set(ws, principal);
          const memberId = principal.role === 'student' ? principal.memberId : null;
          send(ws, { t: 'hello', role: principal.role, memberId, status: memberId ? classroom.status(memberId) : null, classroom: { ...classroom.info(), ...(sessionAuthority ? { authority: sessionAuthority() } : {}) }, serverTime: Date.now(), capabilities: [...classroom.capabilities(principal)] });
          if (principal.role === 'student' && classroom.status(principal.memberId) === 'approved' && classroom.can(principal, 'VIEW_MEMBERS')) send(ws, memberRoster(principal));
          if (principal.role === 'teacher') {
            send(ws, hostRoster());
            send(ws, { t: 'timeline', events: classroom.timeline() });
          }
          schedule();
          if (memberId) { classroom.connected(memberId, true); presentations.presence(memberId, true); }
          send(ws, presentationMsg(principal));
          if (principal.role === 'teacher' || classroom.status(principal.memberId) === 'approved') send(ws, classroom.handView(principal));
          if (whiteboard?.canView(principal)) send(ws, { t: 'wb.wall', mode: whiteboard.wallMode(), by: whiteboard.wallBy, board: whiteboard.view(principal) });
          return;
        }

        if (msg.t === 'auth') return;
        if (msg.t === 'ping') {
          if (principal.role === 'student') classroom.touch(principal.memberId);
          return send(ws, { t: 'pong', n: msg.n, serverTime: Date.now() });
        }
        // Authorization is decided here from the server-side principal, never from anything the client claims.
        const needs = MESSAGE_CAPABILITY[msg.t];
        if ((TEACHER_ONLY.has(msg.t) && principal.role !== 'teacher') || (needs && !classroom.can(principal, needs))) return send(ws, { t: 'error', code: 'forbidden', message: 'Not allowed in this CLAN' });
        if (STUDENT_ONLY.has(msg.t) && (principal.role !== 'student' || classroom.status(principal.memberId) !== 'approved')) return send(ws, { t: 'error', code: 'forbidden', message: 'Students only' });
        if (!UNFENCED.has(msg.t)) {
          try { fence(); } catch (e) { return send(ws, { t: 'error', code: (e as ApiError).code, message: (e as Error).message }); }
        }
        const fail = (e: unknown) => {
          if (e instanceof JoinError || e instanceof ApiError || (e as Error).name === 'ChatError') return send(ws, { t: 'error', code: (e as ApiError).code, message: (e as Error).message });
          if (e instanceof Error && e.name === 'ZodError') return send(ws, { t: 'error', code: 'invalid', message: 'Invalid request' });
          throw e;
        };
        try {
          switch (msg.t) {
            case 'hand.set': classroom.setHand(principal, msg.raised); return send(ws, classroom.handView(principal));
            case 'hand.dismiss': return classroom.dismissHand(principal, msg.memberId);
            case 'member.approve': return classroom.setStatus(msg.memberId, 'approved');
            case 'member.reject': return classroom.setStatus(msg.memberId, 'rejected');
            case 'member.remove': return classroom.setStatus(msg.memberId, 'removed');
            case 'member.block': return classroom.setStatus(msg.memberId, 'blocked');
            case 'class.lock': return classroom.setLocked(msg.locked);
            case 'class.policy': return classroom.setPolicy(msg.policy);
            case 'class.filePolicy': return classroom.setFilePolicy(msg.policy);
            case 'class.end': return classroom.end();
            case 'resource.available': return resources.setAvailable(msg.resourceId, msg.available);
            case 'resource.push': return resources.push(msg.resourceId);
            case 'resource.remove': return void resources.remove(msg.resourceId).catch(fail);
            case 'assignment.create': return void assignments.create(msg.assignment);
            case 'assignment.close': return assignments.close(msg.assignmentId);
            case 'class.peerAssist': return classroom.setPeerAssist(msg.enabled);
            case 'present.request': return presentations.request(principal);
            case 'present.approve': return presentations.approve(msg.memberId);
            case 'present.decline': return presentations.decline(msg.memberId);
            case 'present.policy': return presentations.setPolicy(msg.policy);
            case 'present.start': { whiteboard?.beforePresent(principal, !!msg.takeover); return void presentations.start(principal, msg).catch(fail); }
            case 'present.source': return presentations.source(principal, msg);
            case 'present.stop': return void presentations.stopBy(principal, msg.presentationId).catch(fail);
            case 'peer.probeResult': {
              if (!probe || probe.id !== msg.probeId || probe.memberId !== (principal as { memberId: string }).memberId || msg.tried === 0) return;
              clearTimeout(probe.timer); probe = null;
              return classroom.setP2p(msg.reachable > 0);
            }
            case 'transfer.state': return resources.report((principal as { memberId: string }).memberId, msg.resourceId, msg.state, msg.bytes);
            case 'chat.send': {
              if (!chat) return send(ws, { t: 'chat.nack', id: msg.id, code: 'chat_unavailable', message: 'Chat is not available on this host.' });
              let r: ReturnType<ChatRelay['send']>;
              try { r = chat.send(principal, msg); } catch (e) {
                const x = e as { code?: string; message?: string };
                return send(ws, { t: 'chat.nack', id: msg.id, code: x.code ?? 'invalid', message: e instanceof ApiError || (e as Error).name === 'ChatError' ? String(x.message) : 'Invalid message' });
              }
              send(ws, { t: 'chat.ack', id: msg.id, threadId: r.message.threadId, seq: r.message.seq, createdAt: r.message.createdAt });
              if (r.created) deliver(r.message, r.thread);
              else send(ws, { t: 'chat.message', message: r.message, thread: chat.view(r.thread, principal) }); // a retry: the sender may have missed it
              return;
            }
            case 'chat.edit': case 'chat.remove': case 'chat.react': {
              const c = needChat();
              const r = msg.t === 'chat.edit' ? c.edit(principal, msg.id, msg.body) : msg.t === 'chat.remove' ? c.remove(principal, msg.id) : c.react(principal, msg.id, msg.reaction, msg.on);
              return deliver(r.message, r.thread);
            }
            case 'chat.cursor': {
              const r = needChat().cursor(principal, msg.threadId, msg);
              return toReaders(r.thread, () => ({ t: 'chat.cursors', threadId: r.thread.id, cursors: r.cursors }));
            }
            case 'wb.sync': {
              if (!whiteboard) return send(ws, { t: 'error', code: 'wb_unavailable', message: 'No whiteboard here.' });
              const r = whiteboard.sync(principal, msg.since);
              // large boards go out in pieces (each well under the clients' message limit): state first, then op batches
              const parts = sizedChunks(r.ops, 256 * 1024);
              send(ws, { t: 'wb.state', board: r.board, ops: parts[0] ?? [], snapshot: r.snapshot });
              for (const p of parts.slice(1)) send(ws, { t: 'wb.op', ops: p });
              return;
            }
            case 'wb.ops': {
              if (!whiteboard) return send(ws, { t: 'wb.nack', ids: msg.ops.map((o) => o.id), code: 'wb_unavailable', message: 'No whiteboard here.' });
              try {
                const logged = whiteboard.ops(principal, msg.ops);
                send(ws, { t: 'wb.ack', ids: msg.ops.map((o) => o.id), headSeq: logged.at(-1)?.seq ?? whiteboard.view(principal).headSeq });
                if (logged.length) toBoard(() => ({ t: 'wb.op', ops: logged }));
              } catch (e) { send(ws, { t: 'wb.nack', ids: msg.ops.map((o) => o.id), code: (e as ApiError).code ?? 'invalid', message: e instanceof ApiError ? e.message : 'Invalid whiteboard change' }); }
              return;
            }
            case 'wb.cursor': { const c = whiteboard?.cursor(principal); if (c) for (const [w, p] of sockets) if (w !== ws && whiteboard!.canView(p)) send(w, { t: 'wb.cursor', who: c.who, name: c.name, x: msg.x, y: msg.y, page: msg.page }); return; }
            case 'wb.wall': { if (!whiteboard) return; return void whiteboard.setWall(principal, msg.mode, !!msg.takeover).then(wallToAll, fail); }
            case 'wb.memberEdit': { whiteboard?.setMemberEdit(principal, msg.on); return wallToAll(); }
            case 'chat.typing': {
              const r = needChat().typing(principal, msg.threadId);
              if (r) toReaders(r.thread, (p) => (chat!.handleOf(p) === r.handle ? null : { t: 'chat.typing', threadId: r.thread.id, handle: r.handle, name: r.name, until: r.until }));
              return;
            }
          }
        } catch (e) {
          fail(e);
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimer); clearInterval(beat);
        const p = sockets.get(ws);
        sockets.delete(ws);
        if (p?.role === 'student' && !shuttingDown) {
          classroom.connected(p.memberId, false);
          presentations.presence(p.memberId, classroom.roster().some((m) => m.id === p.memberId && m.connected));
        }
      });
    });
  });

  await app.listen({ host: opts.host, port: 0 });
  httpsPort = (app.server.address() as { port: number }).port;
  await boot.listen({ host: opts.host, port: opts.port ?? 0 });
  const port = (boot.server.address() as { port: number }).port;
  bootPort = port;
  const stopAdvertising = opts.advertise ? advertise({ host: opts.host, port, sid: classroom.id, title: classroom.title, type: classroom.clan.type }) : null;
  await stopAdvertising?.ready; // deterministic: the session is discoverable when start returns
  // The certificate is short-lived; the class ends just before it expires rather than switching keys mid-session.
  const certTimer = setTimeout(() => classroom.end(), Math.max(0, tls.notAfter - Date.now() - 60_000));
  certTimer.unref();
  const hostPart = opts.host.includes(':') ? `[${opts.host}]` : opts.host;

  return {
    classroom,
    resources,
    assignments,
    storage,
    peers,
    presentations,
    media,
    chat,
    whiteboard,
    shares,
    async shareFile(path: string, to: string, name?: string) {
      const audience = chat ? chat.audience({ role: 'teacher' }, to) : to === 'clan' ? null : (() => { throw new ApiError(503, 'chat_unavailable', 'Sending to one person is not available here.'); })();
      return resources.importFile(path, name, { audience, sharedBy: chat?.hostHandle ?? null });
    },
    port,
    url: `https://${hostPart}:${httpsPort}`,
    bootstrapUrl: `http://${hostPart}:${port}`,
    /** Transport-neutral pairing (BLE bridge). Same Pairing object, throttles and messages as the HTTP bootstrap. */
    pairingStats: () => ({ ...pairing.stats, throttled: { ...pairing.stats.throttled } }),
    bootstrap: (source: string, raw: unknown): BleResponse => {
      const r = BleRequest.safeParse(raw);
      if (!r.success) return { ok: false, code: 'invalid', message: 'Invalid request.' };
      try {
        const m = r.data;
        if (m.t === 'hello') return { ok: true, body: { sessionId: classroom.id, v: 1 } };
        if (m.t === 'start') return { ok: true, body: pairing.start(`ble:${source}`, m.sessionId, m.startLoginRequest) };
        if (m.t === 'abort') { pairing.abort(`ble:${source}`, m.pairingId); return { ok: true, body: null }; }
        const body = pairing.finish(`ble:${source}`, m.pairingId, m.finishLoginRequest);
        classroom.log('member.bootstrap', null, { via: 'bluetooth' }); // diagnostics only: no device data
        return { ok: true, body };
      } catch (e) {
        const x = e as { code?: string; message?: string };
        return { ok: false, code: x.code ?? 'error', message: x.code ? String(x.message) : 'Pairing failed.' };
      }
    },
    tls: { certificate: tls.certificate, spkiSha256: tls.spkiSha256, notAfter: tls.notAfter },
    teacherPublicKey,
    async close() {
      await stopAdvertising?.();
      await presentations.end();
      classroom.end();
      shuttingDown = true;
      clearInterval(statsTimer);
      clearTimeout(certTimer);
      if (pending) clearTimeout(pending);
      pairing.destroy();
      await media?.close();
      await Promise.all([app.close(), boot.close()]);
      classroom.removeAllListeners();
      if (!opts.db) db.close();
      if (ownStorage) await import('node:fs/promises').then((f) => f.rm(storage.root, { recursive: true, force: true }));
    },
  };
}

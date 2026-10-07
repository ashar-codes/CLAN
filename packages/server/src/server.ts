import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline, Transform, type Readable } from 'node:stream';
import websocket from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import { generateKeyPairSync, sign as edSign, createPublicKey, type KeyObject } from 'node:crypto';
import * as opaque from '@serenity-kit/opaque';
import {
  b64u, ClientMessage, JoinRequest, PairAbort, PairFinish, PairStart, ReconnectChallengeRequest, ReconnectRequest, STUDENT_ONLY, TEACHER_ONLY,
  UPLOAD_CONTENT_TYPE, UploadInit, WS_CLOSE, type ServerMessage,
} from '@classroom/protocol';
import { Pairing } from './pairing.ts';
import { PeerRegistry } from './peers.ts';
import { z } from 'zod';
import { logError } from './redact.ts';
import { createClassroomTls } from './tls.ts';
import { Assignments } from './assignments.ts';
import { Resources } from './resources.ts';
import { ApiError, contentDisposition, DEFAULT_LIMITS, parseRange, RateLimit, Storage, UUID_RE, type Limits } from './storage.ts';
import { Classroom, JoinError, type NetworkMode, type Principal } from './classroom.ts';
import { openDb, type Db } from './db.ts';
import { advertise } from './discovery.ts';

export type ServerOptions = {
  title: string;
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
};

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
  assignments: Assignments;
  storage: Storage;
  port: number;
  close(): Promise<void>;
};

const AUTH_TIMEOUT_MS = 5000;
/** Seed a resource to a few peers when it spans at least this many chunks. */
const SEED_MIN_CHUNKS = 8;
const SEEDERS = 4;
const MAX_WS_MESSAGE = 64 * 1024;

export async function startClassroomServer(opts: ServerOptions): Promise<RunningServer> {
  const db = opts.db ?? openDb(opts.dbPath ?? ':memory:');
  const classroom = new Classroom(db, opts.title, opts.networkMode ?? 'lan', { code: opts.code });
  const identity = opts.identity ?? (await ephemeralIdentity());
  const teacherPublicKey = b64u.encode(new Uint8Array(createPublicKey(identity.signingKey).export({ type: 'spki', format: 'der' }).subarray(-32)));
  const signer = { publicKey: teacherPublicKey, sign: (bytes: Uint8Array) => b64u.encode(new Uint8Array(edSign(null, bytes, identity.signingKey))) };
  const tls = await createClassroomTls(classroom.id);
  db.prepare('UPDATE sessions SET teacher_key = ?, tls_spki = ? WHERE id = ?').run(teacherPublicKey, tls.spkiSha256, classroom.id);
  let httpsPort = 0;
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const pairing = await Pairing.create(classroom, identity.opaqueServerSetup, classroom.code, () => ({
    httpsPort, spkiSha256: tls.spkiSha256, certificate: tls.certificate, teacherPublicKey, title: classroom.title,
  }));
  pairing.inflightPerSource = limits.pairInflightPerSource;
  const ownStorage = !opts.storageDir; // ephemeral storage (tests, CLI) is deleted on close
  const storage = new Storage(opts.storageDir ?? mkdtempSync(join(tmpdir(), 'classroom-storage-')));
  await storage.init();
  const resources = new Resources(db, classroom, storage, limits, signer);
  const peers = new PeerRegistry(classroom, signer);
  const assignments = new Assignments(db, classroom, storage, limits, signer);
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
    a.addHook('onRequest', async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('x-content-type-options', 'nosniff');
    });
    a.setErrorHandler((err: Error, _req, reply) => {
      if (err instanceof ApiError || err instanceof JoinError) {
        if (err.status === 429) reply.header('retry-after', Math.max(1, Math.ceil(((err as JoinError).retryAfterMs ?? 1000) / 1000)));
        return reply.code(err.status).send({ code: err.code, message: err.message, ...((err as ApiError).extra ?? {}) });
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
    return { resources: p.role === 'teacher' ? resources.listForTeacher() : resources.listForStudent() };
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
    return peers.endorse(memberId, b, req.ip);
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

  app.get('/api/assignments', async (req) => {
    const p = auth(req);
    return { assignments: p.role === 'teacher' ? assignments.listForTeacher() : assignments.listForStudent(p.memberId) };
  });

  app.post('/api/uploads', async (req, reply) => {
    const memberId = studentOnly(auth(req));
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
  let shuttingDown = false;
  const send = (ws: WebSocket, m: ServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  const toTeachers = (m: () => ServerMessage) => {
    let msg: ServerMessage | undefined;
    for (const [ws, p] of sockets) if (p.role === 'teacher') send(ws, (msg ??= m()));
  };
  const toAll = (m: ServerMessage) => { for (const ws of sockets.keys()) send(ws, m); };

  classroom.on('roster', () => { toTeachers(() => ({ t: 'roster', members: classroom.roster() })); schedule(); });

  // Coalesce bursts (40 students reporting progress) into at most one list broadcast per 150 ms.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => { pending ??= setTimeout(flush, 150); };
  const flush = () => {
    pending = null;
    if (shuttingDown) return;
    let teacherRes: ServerMessage | undefined, teacherAsg: ServerMessage | undefined, studentRes: ServerMessage | undefined;
    for (const [ws, p] of sockets) {
      if (p.role === 'teacher') {
        send(ws, (teacherRes ??= { t: 'resources', resources: resources.listForTeacher() }));
        send(ws, (teacherAsg ??= { t: 'assignments', assignments: assignments.listForTeacher() }));
      } else if (classroom.status(p.memberId) === 'approved') {
        send(ws, (studentRes ??= { t: 'resources', resources: resources.listForStudent() }));
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
    if (status === 'approved') return;
    const fp = peers.revoke(memberId);
    if (fp) for (const [ws, p] of sockets) if (p.role === 'student') send(ws, { t: 'peer.revoked', fingerprints: [fp] });
  });
  const statsTimer = setInterval(() => toTeachers(() => ({ t: 'stats', stats: resources.stats(assignments.activeUploads, peers.summary()) })), 1000);
  classroom.on('timeline', () => toTeachers(() => ({ t: 'timeline', events: classroom.timeline() })));
  classroom.on('state', () => {
    const info = classroom.info();
    toAll({ t: 'class.state', classroom: info });
    if (info.ended) for (const ws of sockets.keys()) ws.close(WS_CLOSE.ended, 'class ended');
  });
  classroom.on('member', (memberId: string, status: string) => {
    for (const [ws, p] of sockets) {
      if (p.role !== 'student' || p.memberId !== memberId) continue;
      send(ws, { t: 'member.status', status: status as never });
      if (status !== 'approved') ws.close(WS_CLOSE.removed, status);
    }
  });

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (ws) => {
      let principal: Principal | null = null;
      const authTimer = setTimeout(() => ws.close(WS_CLOSE.authFailed, 'auth timeout'), AUTH_TIMEOUT_MS);

      ws.on('message', (raw) => {
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
          send(ws, { t: 'hello', role: principal.role, memberId, status: memberId ? classroom.status(memberId) : null, classroom: classroom.info(), serverTime: Date.now() });
          if (principal.role === 'teacher') {
            send(ws, { t: 'roster', members: classroom.roster() });
            send(ws, { t: 'timeline', events: classroom.timeline() });
          }
          schedule();
          if (memberId) classroom.connected(memberId, true);
          return;
        }

        if (msg.t === 'auth') return;
        if (msg.t === 'ping') {
          if (principal.role === 'student') classroom.touch(principal.memberId);
          return send(ws, { t: 'pong', n: msg.n, serverTime: Date.now() });
        }
        // Authorization is decided here from the server-side principal, never from anything the client claims.
        if (TEACHER_ONLY.has(msg.t) && principal.role !== 'teacher') return send(ws, { t: 'error', code: 'forbidden', message: 'Teacher only' });
        if (STUDENT_ONLY.has(msg.t) && (principal.role !== 'student' || classroom.status(principal.memberId) !== 'approved')) return send(ws, { t: 'error', code: 'forbidden', message: 'Students only' });
        const fail = (e: unknown) => {
          if (e instanceof JoinError || e instanceof ApiError) return send(ws, { t: 'error', code: e.code, message: e.message });
          if (e instanceof Error && e.name === 'ZodError') return send(ws, { t: 'error', code: 'invalid', message: 'Invalid request' });
          throw e;
        };
        try {
          switch (msg.t) {
            case 'member.approve': return classroom.setStatus(msg.memberId, 'approved');
            case 'member.reject': return classroom.setStatus(msg.memberId, 'rejected');
            case 'member.remove': return classroom.setStatus(msg.memberId, 'removed');
            case 'member.block': return classroom.setStatus(msg.memberId, 'blocked');
            case 'class.lock': return classroom.setLocked(msg.locked);
            case 'class.policy': return classroom.setPolicy(msg.policy);
            case 'class.end': return classroom.end();
            case 'resource.available': return resources.setAvailable(msg.resourceId, msg.available);
            case 'resource.push': return resources.push(msg.resourceId);
            case 'resource.remove': return void resources.remove(msg.resourceId).catch(fail);
            case 'assignment.create': return void assignments.create(msg.assignment);
            case 'assignment.close': return assignments.close(msg.assignmentId);
            case 'class.peerAssist': return classroom.setPeerAssist(msg.enabled);
            case 'transfer.state': return resources.report((principal as { memberId: string }).memberId, msg.resourceId, msg.state, msg.bytes);
          }
        } catch (e) {
          fail(e);
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimer);
        const p = sockets.get(ws);
        sockets.delete(ws);
        if (p?.role === 'student' && !shuttingDown) classroom.connected(p.memberId, false);
      });
    });
  });

  await app.listen({ host: opts.host, port: 0 });
  httpsPort = (app.server.address() as { port: number }).port;
  await boot.listen({ host: opts.host, port: opts.port ?? 0 });
  const port = (boot.server.address() as { port: number }).port;
  const stopAdvertising = opts.advertise ? advertise({ host: opts.host, port, sid: classroom.id, title: classroom.title }) : null;
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
    port,
    url: `https://${hostPart}:${httpsPort}`,
    bootstrapUrl: `http://${hostPart}:${port}`,
    tls: { certificate: tls.certificate, spkiSha256: tls.spkiSha256, notAfter: tls.notAfter },
    teacherPublicKey,
    async close() {
      await stopAdvertising?.();
      classroom.end();
      shuttingDown = true;
      clearInterval(statsTimer);
      clearTimeout(certTimer);
      if (pending) clearTimeout(pending);
      pairing.destroy();
      await Promise.all([app.close(), boot.close()]);
      classroom.removeAllListeners();
      if (!opts.db) db.close();
      if (ownStorage) await import('node:fs/promises').then((f) => f.rm(storage.root, { recursive: true, force: true }));
    },
  };
}

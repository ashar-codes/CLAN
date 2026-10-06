import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import { ClientMessage, JoinRequest, TEACHER_ONLY, WS_CLOSE, type ServerMessage } from '@classroom/protocol';
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
};

export type RunningServer = {
  classroom: Classroom;
  url: string;
  port: number;
  close(): Promise<void>;
};

const AUTH_TIMEOUT_MS = 5000;
const MAX_WS_MESSAGE = 64 * 1024;

export async function startClassroomServer(opts: ServerOptions): Promise<RunningServer> {
  const db = opts.db ?? openDb(opts.dbPath ?? ':memory:');
  const classroom = new Classroom(db, opts.title, opts.networkMode ?? 'lan', { code: opts.code });
  const app = Fastify({ bodyLimit: 16 * 1024, trustProxy: false });
  await app.register(websocket, { options: { maxPayload: MAX_WS_MESSAGE } });

  // Auth is bearer-token only (no cookies), so permissive CORS grants nothing ambient.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-headers', 'content-type, authorization');
    reply.header('cache-control', 'no-store');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.get('/api/info', async () => ({ product: 'classroom-lan', protocol: 1, title: classroom.title, sessionId: classroom.id }));

  app.post('/api/join', async (req, reply) => {
    const parsed = JoinRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid request' });
    try {
      return { ...classroom.join(parsed.data, req.ip), classroom: classroom.info() };
    } catch (e) {
      if (!(e instanceof JoinError)) throw e;
      if (e.retryAfterMs) reply.header('retry-after', Math.ceil(e.retryAfterMs / 1000));
      return reply.code(e.status).send({ code: e.code, message: e.message });
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

  classroom.on('roster', () => toTeachers(() => ({ t: 'roster', members: classroom.roster() })));
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
        try {
          switch (msg.t) {
            case 'member.approve': return classroom.setStatus(msg.memberId, 'approved');
            case 'member.reject': return classroom.setStatus(msg.memberId, 'rejected');
            case 'member.remove': return classroom.setStatus(msg.memberId, 'removed');
            case 'member.block': return classroom.setStatus(msg.memberId, 'blocked');
            case 'class.lock': return classroom.setLocked(msg.locked);
            case 'class.policy': return classroom.setPolicy(msg.policy);
            case 'class.end': return classroom.end();
          }
        } catch (e) {
          if (e instanceof JoinError) return send(ws, { t: 'error', code: e.code, message: e.message });
          throw e;
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

  await app.listen({ host: opts.host, port: opts.port ?? 0 });
  const port = (app.server.address() as { port: number }).port;
  const stopAdvertising = opts.advertise ? advertise({ host: opts.host, port, sid: classroom.id, title: classroom.title }) : null;

  return {
    classroom,
    port,
    url: `http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${port}`,
    async close() {
      await stopAdvertising?.();
      classroom.end();
      shuttingDown = true;
      await app.close();
      classroom.removeAllListeners();
      if (!opts.db) db.close();
    },
  };
}

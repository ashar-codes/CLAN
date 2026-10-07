import * as opaque from '@serenity-kit/opaque';
import type { ServerMessage, StudentProfile, TlsBinding } from '@classroom/protocol';
import { pairAndJoin, type DeviceSigner, type Transport } from '@classroom/client';
import { newEd25519, nodeSigner, pinnedTransport } from '@classroom/client/node';

/** A fresh Ed25519 device identity. */
export const device = (): { publicKey: string; sign(bytes: Uint8Array): string; privatePkcs8: string } => { const k = newEd25519(); return { ...nodeSigner(k.privatePkcs8), privatePkcs8: k.privatePkcs8 }; };
export const names = (n = 1) => ({ fullName: `Student ${n}`, rollNo: `FA23-CS-${100 + n}`, deviceName: `Laptop-${n}` });
export const profile = (n = 1, d: DeviceSigner = device()): StudentProfile => ({ ...names(n), devicePublicKey: d.publicKey });

// Pinned transports by origin, so tests can keep using plain https URLs (and TCP proxies in front of them).
const transports = new Map<string, Transport>();
export const trustServer = (s: { url: string; tls: Pick<TlsBinding, 'certificate' | 'spkiSha256'> }, alsoUrl?: string) => {
  const t = pinnedTransport(s.tls);
  transports.set(new URL(s.url).origin, t);
  if (alsoUrl) transports.set(new URL(alsoUrl).origin, t);
  return t;
};
export const trFor = (url: string) => {
  const t = transports.get(new URL(url).origin);
  if (!t) throw new Error(`no pinned transport for ${url}`);
  return t;
};

/** Real secure join: OPAQUE with the code, pinned TLS, device-key proof. */
export async function secureJoin(s: { bootstrapUrl: string; classroom: { id: string; code: string } }, n = 1, d: DeviceSigner = device(), code = s.classroom.code) {
  await opaque.ready;
  return pairAndJoin({ candidates: [{ url: s.bootstrapUrl, sid: s.classroom.id }], code, profile: names(n), device: d, opaque: opaque.client, transportFor: pinnedTransport });
}

export async function postJoin(url: string, body: unknown, raw = false) {
  const res = await trFor(url).fetch(url + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Minimal test socket over pinned WSS: collects messages, lets tests await a predicate. */
export function socket(url: string, token?: string) {
  const ws = trFor(url).openWebSocket(url.replace(/^https/, 'wss') + '/ws');
  const msgs: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; res: (m: ServerMessage) => void }[] = [];
  let closed: { code: number; reason: string } | null = null;
  const closeWaiters: ((c: { code: number; reason: string }) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  };
  ws.onclose = (e) => { closed = { code: e.code, reason: e.reason }; closeWaiters.forEach((f) => f(closed!)); };
  const opened = new Promise<void>((r) => (ws.onopen = () => { if (token) ws.send(JSON.stringify({ t: 'auth', token })); r(); }));
  return {
    ws, msgs, opened,
    send: (m: unknown) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 3000) {
      const hit = msgs.find((m) => m.t === t && pred(m as never));
      if (hit) { msgs.splice(msgs.indexOf(hit), 1); return Promise.resolve(hit as Extract<ServerMessage, { t: T }>); }
      return new Promise<Extract<ServerMessage, { t: T }>>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), ms);
        waiters.push({ pred: (m) => m.t === t && pred(m as never), res: (m) => { clearTimeout(timer); msgs.splice(msgs.indexOf(m), 1); res(m as never); } });
      });
    },
    closed: () => (closed ? Promise.resolve(closed) : new Promise<{ code: number; reason: string }>((r) => closeWaiters.push(r))),
    close: () => ws.close(),
  };
}

// ---- Milestone 2 helpers ----
import { createServer, connect, type Socket } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startClassroomServer, type ServerOptions, type RunningServer } from '../src/index.ts';

/** Temp dirs are registered and removed after each test file (test/setup.ts) — tests must not leak disk. */
export const tmpDirs: string[] = ((globalThis as { __classroomTmpDirs?: string[] }).__classroomTmpDirs ??= []);
export const tmp = (prefix = 'clt-') => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };

/** Random file of `bytes`; returns path + sha256. */
export function makeFile(bytes: number, name = 'file.bin', dir = tmp()) {
  const buf = randomBytes(bytes);
  const path = join(dir, name);
  writeFileSync(path, buf);
  return { path, sha256: createHash('sha256').update(buf).digest('hex'), size: bytes, buf };
}

export type Student = { token: string; memberId: string; device: ReturnType<typeof device> };
/** Server with open join policy and `n` approved students. */
export async function classWith(n: number, opts: Partial<ServerOptions> = {}): Promise<{ s: RunningServer; students: Student[] }> {
  const s = await startClassroomServer({ title: 'Class', host: '127.0.0.1', storageDir: tmp('cls-storage-'), ...opts });
  trustServer(s);
  s.classroom.setPolicy('open');
  const students: Student[] = [];
  for (let i = 0; i < n; i++) {
    const d = device();
    const j = await secureJoin(s, i, d);
    students.push({ token: j.token, memberId: j.memberId, device: d });
  }
  return { s, students };
}

export const get = (url: string, token: string | null, headers: Record<string, string> = {}) =>
  trFor(url).fetch(url, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

/**
 * TCP proxy that kills the first connection after `cutAfter` bytes in one direction ('down' = server->client).
 * Later connections pass through untouched. Simulates Wi-Fi dropping mid-transfer.
 */
export async function cuttingProxy(target: string, cutAfter: number, dir: 'down' | 'up' = 'down') {
  const { hostname, port } = new URL(target);
  let cut = false;
  const socks = new Set<Socket>();
  const srv = createServer((client) => {
    const upstream = connect(Number(port), hostname);
    socks.add(client); socks.add(upstream);
    let n = 0;
    const armed = !cut;
    // Respect backpressure, so "bytes sent" means bytes handed to the receiver's socket, not bytes queued in this proxy.
    const watch = (from: Socket, to: Socket, counting: boolean) => {
      to.on('drain', () => from.resume());
      from.on('data', (d) => {
        if (armed && counting && !cut) {
          n += d.length;
          if (n >= cutAfter) { cut = true; to.write(d.subarray(0, d.length - (n - cutAfter)), () => { client.destroy(); upstream.destroy(); }); return; }
        }
        if (!to.write(d)) from.pause();
      });
    };
    watch(upstream, client, dir === 'down');
    watch(client, upstream, dir === 'up');
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    // Raw TCP relay: TLS runs end-to-end through it, so it's https and uses the real server's pin.
    url: `https://127.0.0.1:${(srv.address() as { port: number }).port}`,
    wasCut: () => cut,
    close: () => { socks.forEach((s) => s.destroy()); return new Promise<void>((r) => srv.close(() => r())); },
  };
}

// ---- Milestone 2.5 attacker tooling ----
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { createServer as createTlsServer, connect as tlsConnect } from 'node:tls';
import { createClassroomTls } from '../src/tls.ts';

/**
 * Attacker HTTP relay in front of a classroom's plaintext bootstrap. `rewrite` may alter JSON responses
 * (e.g. the TLS binding) before they reach the student.
 */
export async function bootstrapRelay(target: string, rewrite: (path: string, body: any) => any = (_p, b) => b) {
  const t = new URL(target);
  const srv = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const up = httpRequest({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers }, (ur) => {
        const rc: Buffer[] = [];
        ur.on('data', (c) => rc.push(c));
        ur.on('end', () => {
          let body = Buffer.concat(rc).toString();
          try { body = JSON.stringify(rewrite(req.url!, JSON.parse(body))); } catch {}
          res.writeHead(ur.statusCode!, { 'content-type': 'application/json' }).end(body);
        });
      });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** Active MITM: terminates TLS with its OWN certificate and re-encrypts to the real server. */
export async function tlsInterceptor(target: string) {
  const t = new URL(target);
  const fake = await createClassroomTls('attacker');
  let intercepted = 0;
  const srv = createTlsServer({ cert: fake.certPem, key: fake.keyPem }, (client) => {
    const up = tlsConnect({ host: t.hostname, port: Number(t.port), rejectUnauthorized: false });
    client.pipe(up).pipe(client);
    const end = () => { client.destroy(); up.destroy(); };
    client.on('error', end); up.on('error', end);
  });
  srv.on('connection', () => { intercepted++; }); // TCP reached the attacker (the TLS handshake then fails client-side)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `https://127.0.0.1:${(srv.address() as { port: number }).port}`, fake, intercepted: () => intercepted, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

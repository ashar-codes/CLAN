// The people endpoint each computer runs for Nearby People, friends, private chats, direct files and call signaling
// (docs/PHASE_14_3_ARCHITECTURE.md). TLS 1.3 with a long-lived certificate whose SPKI the device identity key vouches
// for (PeerTlsBinding). Every request is signed by the caller's identity key over method, path, time, nonce, body hash
// and the recipient (its key, or for the first hello the TLS SPKI the caller saw — so a relay cannot reuse it). Nothing
// about this device (not even its identity key) is released to a caller its visibility settings do not allow.
// Phones accept no connections: they keep an authenticated WebSocket open while active and receive their queue on it.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { browseLan, publishLan } from './lan-mdns.ts';
import { b64u, bodySha, PEER_SERVICE, PEER_SKEW_MS, peerRequestStatement, verifyStatement, type PeerEnvelope, type PeerTlsBinding } from '@classroom/protocol';
import { parseRange } from './storage.ts';
import { Throttle } from './throttle.ts';

/** What the server needs from the device's People module (structural; implemented by @clan/core People + transport). */
export type PeopleHost = {
  myKey(): string;
  binding(): PeerTlsBinding;
  visibility(): 'everyone' | 'friends' | 'invisible';
  reachableBy(key: string, invite?: string | null): boolean;
  profileFor(key: string, invite?: string | null): { profile: unknown };
  /** The caller's own signed TLS binding, endpoints and profile (how to reach and show them). Validated by the host. */
  introduce?(fromKey: string, intro: unknown): void;
  /** Applies one signed envelope (throws a coded error when refused). */
  receive(envelope: unknown, fromKey: string): unknown;
  avatar?(key: string, invite: string | null): Promise<{ mime: string; data: Uint8Array } | null>;
  outgoingBytes(transferId: string, peerKey: string): { path: string; size: number; sha256: string; mime: string; name: string } | null;
  /** A phone pushes bytes it offered: append at `offset` (the receiver's own state decides what is accepted). */
  incomingChunk?(transferId: string, peerKey: string, offset: number, bytes: Uint8Array): Promise<{ have: number }>;
  /** Envelopes waiting for a phone that is connected right now; `sent(id)` once written to its socket. */
  queuedFor(key: string): { id: string; envelope: PeerEnvelope }[];
  sent(id: string, recipient: string): void;
  refused?(id: string, recipient: string): void;
  onPhone?(key: string, connected: boolean): void;
};
export type PeopleServerOptions = { host: PeopleHost; tls: { certPem: string; keyPem: string; spkiSha256: string }; port?: number; bind?: string; now?: () => number };
type Tagged = Error & { code?: string };
const KEY = /^[A-Za-z0-9_-]{43}$/;

export async function startPeopleServer(o: PeopleServerOptions) {
  const now = o.now ?? (() => Date.now());
  const app = Fastify({ https: { cert: o.tls.certPem, key: o.tls.keyPem, minVersion: 'TLSv1.3' }, bodyLimit: 9 * 1024 * 1024, logger: false, forceCloseConnections: true });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => { try { done(null, { raw: body as string, json: JSON.parse(body as string) }); } catch { done(Object.assign(new Error('Malformed JSON.'), { statusCode: 400 })); } });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_r, body, done) => done(null, { raw: body as Buffer, json: undefined }));
  const seen = new Map<string, number>();
  const strangers = new Throttle(30, 60_000, 5 * 60_000);
  const fail = (reply: FastifyReply, e: unknown) => {
    const code = (e as Tagged).code ?? (e instanceof z.ZodError ? 'invalid' : 'error');
    const status = code === 'bad_auth' || code === 'replay' || code === 'stale_req' ? 401 : code === 'rate_limited' ? 429 : ['refused', 'not_allowed', 'hidden'].includes(code) ? 403 : code === 'not_found' ? 404 : ['invalid', 'stale'].includes(code) ? 400 : ['bad_state', 'corrupt'].includes(code) ? 409 : code === 'too_large' ? 413 : 500;
    // A refused stranger learns only "refused"; details stay on this device.
    return reply.code(status).send({ error: status === 403 ? 'refused' : code, message: status === 500 ? 'Something went wrong on the other device.' : status === 403 ? 'Not accepted.' : (e as Error).message });
  };
  /** Verifies the signed request headers; returns the caller's identity key. `to`: our key (or SPKI for hello). */
  const authed = (req: FastifyRequest, raw: string | Uint8Array, to: string) => {
    let a: { key: string; ts: number; nonce: string; bodySha: string };
    try { a = z.object({ key: z.string().regex(KEY), ts: z.number().int(), nonce: z.string().min(16).max(64), bodySha: z.string().max(64) }).parse(JSON.parse(new TextDecoder().decode(b64u.decode(String(req.headers['x-clan-peer'] ?? ''))))); }
    catch { throw Object.assign(new Error('Missing or malformed authentication.'), { code: 'bad_auth' }); }
    if (Math.abs(now() - a.ts) > PEER_SKEW_MS) throw Object.assign(new Error('Request too old or clock too far off.'), { code: 'stale_req' });
    if (a.bodySha !== bodySha(raw)) throw Object.assign(new Error('Body does not match the signature.'), { code: 'bad_auth' });
    const path = req.url.split('?')[0]!;
    if (!verifyStatement(a.key, peerRequestStatement({ method: req.method, path, ts: a.ts, nonce: a.nonce, bodySha: a.bodySha, key: a.key, to }), String(req.headers['x-clan-peer-sig'] ?? ''))) throw Object.assign(new Error('Signature does not verify.'), { code: 'bad_auth' });
    const k = `${a.key}:${a.nonce}`;
    for (const [x, t] of seen) if (t < now() - 2 * PEER_SKEW_MS) seen.delete(x);
    if (seen.has(k)) throw Object.assign(new Error('Request was replayed.'), { code: 'replay' });
    seen.set(k, now());
    if (a.key === o.host.myKey()) throw Object.assign(new Error('That is this device.'), { code: 'bad_auth' });
    return a.key;
  };
  const body = (req: FastifyRequest) => (req.body as { raw: string | Buffer; json: unknown } | undefined) ?? { raw: '', json: undefined };
  const invite = (req: FastifyRequest) => { const v = req.headers['x-clan-invite']; return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : null; };
  const reachable = (key: string, req: FastifyRequest) => {
    if (o.host.reachableBy(key, invite(req))) return;
    if (strangers.lockedFor(req.ip) > 0) throw Object.assign(new Error('Too many requests.'), { code: 'rate_limited' });
    strangers.fail(req.ip);
    throw Object.assign(new Error('Not accepted.'), { code: 'hidden' });
  };

  // First contact: the caller proves its key bound to the SPKI it saw; we release our identity binding only if allowed.
  app.post('/peer/hello', async (req, reply) => {
    try { const b = body(req), key = authed(req, b.raw, o.tls.spkiSha256); reachable(key, req); return { binding: o.host.binding() }; } catch (e) { return fail(reply, e); }
  });
  // The caller's view of our picture (only if the profile it may see includes one).
  app.post('/peer/avatar', async (req, reply) => {
    try {
      const b = body(req), key = authed(req, b.raw, o.host.myKey()); reachable(key, req);
      const a = await o.host.avatar?.(key, invite(req));
      if (!a) throw Object.assign(new Error('No picture.'), { code: 'not_found' });
      return { mime: a.mime, data: Buffer.from(a.data).toString('base64url') };
    } catch (e) { return fail(reply, e); }
  });
  app.post('/peer/profile', async (req, reply) => {
    try { const b = body(req), key = authed(req, b.raw, o.host.myKey()); reachable(key, req); const p = o.host.profileFor(key, invite(req)); if (!p.profile) throw Object.assign(new Error('Not shared.'), { code: 'hidden' }); return p; } catch (e) { return fail(reply, e); }
  });
  // Envelopes from a person. Strangers may only ask (friend request / chat invitation) while this device is visible.
  app.post('/peer/inbox', async (req, reply) => {
    try {
      const b = body(req), key = authed(req, b.raw, o.host.myKey());
      const parsed = z.object({ envelopes: z.array(z.unknown()).min(1).max(100), intro: z.unknown().optional() }).parse(b.json), envs = parsed.envelopes;
      if (!o.host.reachableBy(key, invite(req))) {
        const asks = envs.every((e) => ['friend.request', 'chat.invite'].includes(String((e as { body?: { kind?: string } })?.body?.kind)));
        if (!asks || o.host.visibility() === 'invisible') reachable(key, req);
      }
      if (parsed.intro !== undefined) { try { o.host.introduce?.(key, parsed.intro); } catch { /* an invalid introduction is ignored; envelopes still verify on their own */ } }
      const results = envs.map((e) => { try { o.host.receive(e, key); return { ok: true }; } catch (err) { const c = (err as Tagged).code ?? 'error'; return { ok: false, error: ['refused', 'not_allowed'].includes(c) ? 'refused' : c, final: c !== 'error' }; } });
      return { results };
    } catch (e) { return fail(reply, e); }
  });
  // Bytes of a file we offered, only to the conversation peer that accepted it (resumable by Range). GET is the same
  // request for native downloaders that cannot send a body (the signature covers the method and an empty body).
  const fileBytes = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const b = body(req), key = authed(req, b.raw, o.host.myKey());
      const id = z.string().uuid().parse((req.params as { id: string }).id);
      const f = o.host.outgoingBytes(id, key);
      if (!f) throw Object.assign(new Error('No such file for you.'), { code: 'not_found' });
      const size = (await stat(f.path)).size, range = parseRange(req.headers.range, size);
      if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send();
      reply.header('accept-ranges', 'bytes').header('content-type', 'application/octet-stream');
      if (range) { reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1); return reply.send(createReadStream(f.path, range)); }
      reply.header('content-length', size); return reply.send(createReadStream(f.path));
    } catch (e) { return fail(reply, e); }
  };
  app.post('/peer/file/:id', fileBytes);
  app.get('/peer/file/:id', fileBytes);
  // A phone (no server) pushes the bytes of a file it offered, in chunks at the offset we report.
  app.put('/peer/file/:id', async (req, reply) => {
    try {
      if (!o.host.incomingChunk) throw Object.assign(new Error('Not supported.'), { code: 'not_found' });
      const b = body(req), key = authed(req, b.raw as Buffer, o.host.myKey());
      const id = z.string().uuid().parse((req.params as { id: string }).id), offset = z.coerce.number().int().min(0).parse((req.query as { offset?: string }).offset);
      return await o.host.incomingChunk(id, key, offset, new Uint8Array(b.raw as Buffer));
    } catch (e) { return fail(reply, e); }
  });
  // Phones: one authenticated socket while the app is open; queued envelopes are written to it and acknowledged.
  const phones = new Map<string, Set<{ send(s: string): void; close(): void }>>();
  app.get('/peer/ws', { websocket: true }, (socket) => {
    let key: string | null = null;
    const timer = setTimeout(() => socket.close(4401, 'auth required'), 5000);
    const flush = () => { if (!key) return; for (const q of o.host.queuedFor(key)) { socket.send(JSON.stringify({ t: 'env', id: q.id, envelope: q.envelope })); } };
    socket.on('message', (raw: Buffer) => {
      let m: { t?: string; [k: string]: unknown };
      try { m = JSON.parse(String(raw)); } catch { return socket.close(4400, 'bad json'); }
      if (!key) {
        try {
          const a = z.object({ t: z.literal('auth'), key: z.string().regex(KEY), ts: z.number().int(), nonce: z.string().min(16).max(64), sig: z.string().max(100) }).parse(m);
          const stmt = peerRequestStatement({ method: 'GET', path: '/peer/ws', ts: a.ts, nonce: a.nonce, bodySha: bodySha(''), key: a.key, to: o.host.myKey() });
          if (Math.abs(now() - a.ts) > PEER_SKEW_MS || !verifyStatement(a.key, stmt, a.sig) || seen.has(`${a.key}:${a.nonce}`) || !o.host.reachableBy(a.key)) return socket.close(4401, 'not accepted');
          seen.set(`${a.key}:${a.nonce}`, now());
          key = a.key; clearTimeout(timer);
          const set = phones.get(key) ?? new Set(); set.add(socket); phones.set(key, set);
          o.host.onPhone?.(key, true);
          socket.send(JSON.stringify({ t: 'hello', key: o.host.myKey() }));
          return flush();
        } catch { return socket.close(4401, 'not accepted'); }
      }
      if (m.t === 'ack' && typeof m.id === 'string') { if (m.ok === false) o.host.refused?.(m.id, key); else o.host.sent(m.id, key); }
      else if (m.t === 'pull') flush();
    });
    socket.on('close', () => { clearTimeout(timer); if (key) { phones.get(key)?.delete(socket); if (!phones.get(key)?.size) { phones.delete(key); o.host.onPhone?.(key, false); } } });
  });

  const port = await app.listen({ port: o.port ?? 0, host: o.bind ?? '0.0.0.0' }).then(() => (app.server.address() as { port: number }).port);
  return {
    port,
    /** Push queued/live envelopes to a connected phone now (returns false if it is not connected). */
    notifyPhone(key: string, live?: { id: string; envelope: PeerEnvelope }) {
      const set = phones.get(key); if (!set?.size) return false;
      for (const s of set) { if (live) s.send(JSON.stringify({ t: 'env', id: live.id, envelope: live.envelope, live: true })); else for (const q of o.host.queuedFor(key)) s.send(JSON.stringify({ t: 'env', id: q.id, envelope: q.envelope })); }
      return true;
    },
    phoneConnected: (key: string) => !!phones.get(key)?.size,
    close: () => app.close(),
  };
}


/** DNS-SD: TXT carries only a random id that the caller rotates; nothing identifies the person. */
/** `r` random per advert; `t` the presence tag only friends can recognise (presenceTag). Nothing else is advertised. */
export function advertisePeople(o: { port: number; r: string; t?: string; onError?(m: string): void }) {
  return publishLan({ type: PEER_SERVICE, name: `CLAN person ${o.r.slice(0, 6)}`, port: o.port, txt: { v: '1', r: o.r, ...(o.t ? { t: o.t } : {}) }, onError: o.onError });
}
/** Browse adverts; `addrs` are every usable address, best first (try them in order), `addr` the best one. */
export function browsePeople(onUp: (s: { addr: string; addrs: string[]; port: number; r: string; t: string }) => void, onDown?: (r: string) => void, type: string = PEER_SERVICE, o: { onError?(m: string): void } = {}) {
  return browseLan(type, (s) => {
    const txt = s.txt as { v?: string; r?: string; t?: string };
    if (txt.v === '1' && typeof txt.r === 'string' && /^[A-Za-z0-9_-]{8,24}$/.test(txt.r)) onUp({ addr: s.addrs[0]!, addrs: s.addrs, port: s.port, r: txt.r, t: typeof txt.t === 'string' && /^[A-Za-z0-9_-]{16}$/.test(txt.t) ? txt.t : '' });
  }, (s) => { const r = (s.txt as { r?: unknown }).r; if (typeof r === 'string') onDown?.(r); }, o);
}

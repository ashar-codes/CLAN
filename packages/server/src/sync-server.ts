// Personal device sync over the LAN: a small HTTPS server each device runs for its own linked devices. TLS uses the
// device's long-lived sync certificate (peers pin it); every /sync request is also signed by the calling device key and
// checked against the account's device registry (unknown or unlinked → refused). Unrelated to the classroom server:
// a linked device gains no CLAN authority here.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { Bonjour } from 'bonjour-service';
import { SyncRecord } from '@classroom/protocol';
import { Throttle } from './throttle.ts';
import { parseRange } from './storage.ts';

/** What the server needs from the device's sync engine (structural; implemented by @clan/core PersonalSync). */
export type SyncHost = {
  verifyRequest(h: { auth: string | undefined; sig: string | undefined }, method: string, path: string, bodySha: string): string;
  bodySha(body: string | Uint8Array): string;
  changes(since: number, limit: number): unknown;
  applyBatch(fromFp: string, records: unknown[]): Promise<{ accepted: number }>;
  linkStart(): { sessionId: string; nonceA: string };
  linkHello(raw: unknown, serverSpki: string): unknown;
  linkStatus(sessionId: string, nonceB: string): unknown;
};
export type SyncServerOptions = { host: SyncHost; tls: { certPem: string; keyPem: string; spkiSha256: string }; objectPath(sha256: string): string | null; port?: number; bind?: string; onChange?(): void };
export const SYNC_SERVICE = 'clansync';

export async function startSyncServer(o: SyncServerOptions) {
  const app = Fastify({ https: { cert: o.tls.certPem, key: o.tls.keyPem, minVersion: 'TLSv1.3' }, bodyLimit: 64 * 1024 * 1024, logger: false });
  const linkTries = new Throttle(10, 60_000, 5 * 60_000);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => { try { done(null, { raw: body as string, json: JSON.parse(body as string) }); } catch (e) { done(e as Error); } });
  const fail = (reply: FastifyReply, e: unknown) => {
    const code = (e as { code?: string }).code;
    const status = code === 'revoked' ? 403 : code === 'unknown_device' || code === 'bad_auth' || code === 'replay' || code === 'stale' ? 401 : code === 'bad_code' || code === 'no_link' ? 400 : e instanceof z.ZodError ? 400 : 500;
    return reply.code(status).send({ error: code ?? 'error', message: status === 500 ? 'Sync failed on the other device.' : (e as Error).message });
  };
  const authed = (req: FastifyRequest, raw: string) => o.host.verifyRequest({ auth: req.headers['x-clan-sync'] as string | undefined, sig: req.headers['x-clan-sync-sig'] as string | undefined }, req.method, req.url, o.host.bodySha(raw));
  const body = (req: FastifyRequest) => (req.body as { raw: string; json: unknown } | undefined) ?? { raw: '', json: undefined };

  // ---- linking (no device auth yet: the short code + proofs bound to this TLS key do the work) ----
  const limited = (req: FastifyRequest) => linkTries.lockedFor(req.ip) > 0;
  app.post('/link/start', async (req, reply) => { if (limited(req)) return reply.code(429).send({ error: 'locked' }); try { return o.host.linkStart(); } catch (e) { return fail(reply, e); } });
  app.post('/link/hello', async (req, reply) => {
    if (limited(req)) return reply.code(429).send({ error: 'locked' });
    try { return o.host.linkHello(body(req).json, o.tls.spkiSha256); } catch (e) { linkTries.fail(req.ip); return fail(reply, e); }
  });
  app.post('/link/status', async (req, reply) => {
    try { const b = z.object({ sessionId: z.string().max(64), nonceB: z.string().max(64) }).parse(body(req).json); return o.host.linkStatus(b.sessionId, b.nonceB); } catch (e) { return fail(reply, e); }
  });

  // ---- sync (signed by a linked device) ----
  app.get('/sync/changes', async (req, reply) => {
    try {
      authed(req, '');
      const q = z.object({ since: z.coerce.number().int().min(0), limit: z.coerce.number().int().min(1).max(1000) }).parse(req.query);
      return o.host.changes(q.since, q.limit);
    } catch (e) { return fail(reply, e); }
  });
  app.post('/sync/changes', async (req, reply) => {
    try {
      const b = body(req), fp = authed(req, b.raw);
      const r = await o.host.applyBatch(fp, z.object({ records: z.array(SyncRecord).max(1000) }).parse(b.json).records);
      if (r.accepted) o.onChange?.();
      return r;
    } catch (e) { return fail(reply, e); }
  });
  app.get('/sync/objects/:sha', async (req, reply) => {
    try {
      authed(req, '');
      const sha = z.string().regex(/^[0-9a-f]{64}$/).parse((req.params as { sha: string }).sha);
      const path = o.objectPath(sha); // only this account's own personal files
      if (!path) return reply.code(404).send({ error: 'not_found' });
      const size = (await stat(path)).size;
      const range = parseRange(req.headers.range, size);
      if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send();
      reply.header('accept-ranges', 'bytes').header('content-type', 'application/octet-stream');
      if (range) { reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1); return reply.send(createReadStream(path, range)); }
      reply.header('content-length', size); return reply.send(createReadStream(path));
    } catch (e) { return fail(reply, e); }
  });

  const port = await app.listen({ port: o.port ?? 0, host: o.bind ?? '0.0.0.0' }).then(() => (app.server.address() as { port: number }).port);
  return { port, close: () => app.close() };
}

/** DNS-SD for linked devices: TXT carries only an account tag that changes hourly (no names, no device ids) and, while a
 *  link code is open, a short tag derived from it so the new device can find this one. */
export function advertiseSync(o: { port: number; tag: string; linkTag?: string }) {
  const bonjour = new Bonjour({ bind: '0.0.0.0' } as object, () => {});
  bonjour.publish({ name: `CLAN sync ${o.tag.slice(0, 6)}`, type: SYNC_SERVICE, port: o.port, txt: { v: '1', a: o.tag, ...(o.linkTag ? { l: o.linkTag } : {}) }, disableIPv6: true });
  return () => new Promise<void>((r) => bonjour.unpublishAll(() => { bonjour.destroy(); r(); }));
}
export function browseSync(onUp: (s: { addr: string; port: number; tag: string; linkTag: string | null }) => void) {
  const bonjour = new Bonjour({}, () => {});
  const b = bonjour.find({ type: SYNC_SERVICE });
  b.on('up', (s) => { const txt = (s.txt ?? {}) as { v?: string; a?: string; l?: string }; const addr = s.addresses?.find((a) => a.includes('.')) ?? s.referer?.address; if (txt.v === '1' && addr && txt.a) onUp({ addr, port: s.port, tag: txt.a, linkTag: txt.l ?? null }); });
  const t = setInterval(() => b.update(), 4000);
  return () => { clearInterval(t); b.stop(); bonjour.destroy(); };
}

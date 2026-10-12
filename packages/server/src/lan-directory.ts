import Fastify from 'fastify';
import { z } from 'zod';
import { b64u, bodySha, peerRequestStatement, verifyStatement, DirectoryRegistration, internalAddress, internalEndpoint, type DirectoryAdvert } from '@classroom/protocol';

/** No outbound sockets, no durable identity database and no payload forwarding. Admin enrolls device PUBLIC keys. */
export async function startLanDirectory(o: {
  tls: { certPem: string; keyPem: string; spkiSha256: string }; allowedKeys: Set<string>; host: string; port?: number;
  now?: () => number; allowLoopback?: boolean;
}) {
  if (!internalAddress(o.host.includes(':') ? `[${o.host}]` : o.host, o.allowLoopback)) throw new Error('Bind the directory to an explicit internal interface.');
  if (!o.allowedKeys.size || o.allowedKeys.size > 256) throw new Error('Enroll 1–256 device public keys.');
  const now = o.now ?? Date.now, records = new Map<string, { expires: number; adverts: DirectoryAdvert[] }>(), seen = new Map<string, number>();
  let budgetAt = now(), budget = 0;
  const app = Fastify({ https: { cert: o.tls.certPem, key: o.tls.keyPem, minVersion: 'TLSv1.3' }, logger: false, bodyLimit: 16384, forceCloseConnections: true, requestTimeout: 5000, connectionTimeout: 5000, maxRequestsPerSocket: 100 });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, raw, done) => { try { done(null, { raw: String(raw), json: JSON.parse(String(raw)) }); } catch { done(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); } });
  const sweep = () => { for (const [k, r] of records) if (r.expires <= now() || !o.allowedKeys.has(k)) records.delete(k); for (const [k, t] of seen) if (t < now() - 240_000) seen.delete(k); };
  app.post('/lan/:action', (req, reply) => {
    try {
      if (now() - budgetAt >= 60_000) { budgetAt = now(); budget = 0; }
      if (++budget > 240) return reply.code(429).send({ error: 'rate_limited' });
      const { raw, json } = req.body as { raw: string; json: unknown };
      const header = String(req.headers['x-clan-peer'] ?? ''), sig = String(req.headers['x-clan-peer-sig'] ?? '');
      if (header.length > 1024 || sig.length > 128) throw Error('auth');
      const a = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ts: z.number().int(), nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), bodySha: z.string().max(64) }).strict().parse(JSON.parse(new TextDecoder().decode(b64u.decode(header))));
      if (!o.allowedKeys.has(a.key) || Math.abs(now() - a.ts) > 120_000 || a.bodySha !== bodySha(raw) || !verifyStatement(a.key, peerRequestStatement({ method: 'POST', path: req.url, ...a, to: o.tls.spkiSha256 }), sig)) return reply.code(401).send({ error: 'auth' });
      sweep(); const nonce = `${a.key}:${a.nonce}`;
      if (seen.has(nonce)) return reply.code(401).send({ error: 'replay' });
      if (seen.size >= 4096) return reply.code(429).send({ error: 'rate_limited' });
      seen.set(nonce, now());
      if (req.url === '/lan/register') {
        const { adverts } = DirectoryRegistration.parse(json);
        if (adverts.some((x) => x.endpoints.some((e) => !internalEndpoint(e, o.allowLoopback)))) return reply.code(400).send({ error: 'internal_endpoints_only' });
        if ([...records.entries()].filter(([k]) => k !== a.key).reduce((n, [, r]) => n + r.adverts.length, adverts.length) > 128) return reply.code(429).send({ error: 'directory_full' });
        if (adverts.length) records.set(a.key, { adverts, expires: now() + 90_000 }); else records.delete(a.key);
        return { ok: true };
      }
      if (req.url !== '/lan/lookup') return reply.code(404).send({ error: 'not_found' });
      z.object({}).strict().parse(json);
      const visible = [...records.entries()].filter(([k]) => k !== a.key);
      return { ttlMs: Math.max(1, Math.min(90_000, ...visible.map(([, r]) => r.expires - now()))), adverts: visible.flatMap(([, r]) => r.adverts) };
    } catch { return reply.code(400).send({ error: 'invalid' }); }
  });
  const timer = setInterval(sweep, 15_000); timer.unref(); app.addHook('onClose', () => clearInterval(timer));
  try { await app.listen({ host: o.host, port: o.port ?? 0 }); } catch (e) { clearInterval(timer); throw e; }
  return { app, port: (app.server.address() as { port: number }).port, close: () => app.close() };
}

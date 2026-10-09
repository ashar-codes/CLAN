// Personal device sync, client side (Node / Electron main): the LAN SyncTransport to a linked device (pinned to that
// device's sync certificate, every request signed), and the joiner's half of linking.
import { request } from 'node:https';
import { randomBytes } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { SyncBatch, type LinkHello, type SyncRecord, type SyncTransport } from '@classroom/protocol';
import { joinWithCode as join, SyncHttpError } from './link.ts';
export { SyncHttpError } from './link.ts';
import { pinnedTransport, spkiSha256OfDer } from './node.ts';

export type SyncAuth = (method: string, path: string, body: string) => Record<string, string>;

/** A SyncTransport to one linked device at `base` (https://addr:port), trusting only its registered certificate. */
export function lanSyncTransport(o: { peer: string; base: string; tlsCa: string; tlsSpki: string; auth: SyncAuth; timeoutMs?: number }): SyncTransport {
  const t = pinnedTransport({ certificate: o.tlsCa, spkiSha256: o.tlsSpki });
  const call = async (method: string, path: string, body = '', extra: Record<string, string> = {}) => {
    const res = await t.fetch(`${o.base}${path}`, { method, headers: { ...o.auth(method, path, body), ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body || undefined, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    if (!res.ok && res.status !== 206) { const e = await res.json().catch(() => ({})) as { error?: string; message?: string }; throw new SyncHttpError(res.status, e.error ?? 'error', e.message ?? `HTTP ${res.status}`); }
    return res;
  };
  return {
    peer: o.peer,
    pull: async (since, limit) => SyncBatch.parse(await (await call('GET', `/sync/changes?since=${since}&limit=${limit}`)).json()),
    push: async (records: SyncRecord[]) => (await call('POST', '/sync/changes', JSON.stringify({ records }))).json() as Promise<{ accepted: number }>,
    object: async (sha, offset) => {
      const res = await call('GET', `/sync/objects/${sha}`, '', offset ? { range: `bytes=${offset}-` } : {});
      if (offset && res.status !== 206) throw new SyncHttpError(res.status, 'no_range', 'The other device did not resume the transfer.');
      return res.body as unknown as AsyncIterable<Uint8Array>;
    },
  };
}

/** One JSON POST that also reports the server's leaf SPKI — linking can't pin yet; the proofs bind to what we saw. */
function postSeeing(base: string, path: string, body: unknown): Promise<{ status: number; json: unknown; spki: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    if (u.protocol !== 'https:') return reject(new Error('Linking needs HTTPS.'));
    const data = JSON.stringify(body ?? {});
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, rejectUnauthorized: false, minVersion: 'TLSv1.3', timeout: 15_000 }, (res) => {
      const raw = (res.socket as TLSSocket).getPeerCertificate()?.raw;
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 1 << 20) req.destroy(new Error('Too large.')); });
      res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}'), spki: raw ? spkiSha256OfDer(raw) : '' }); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('The other device did not answer.')));
    req.on('error', reject); req.end(data);
  });
}

/** Desktop joiner: `joinWithCode` over node:https (first contact unpinned; proofs bind to the SPKI seen). */
export const joinWithCode = (o: { base: string; code: string; device: LinkHello['device']; sign(bytes: Uint8Array): string; signal?: AbortSignal; pollMs?: number }) =>
  join({ ...o, post: (path, body) => postSeeing(o.base, path, body), random: (n) => new Uint8Array(randomBytes(n)) });

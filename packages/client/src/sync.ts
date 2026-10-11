// Personal device sync, client side (Node / Electron main): the LAN SyncTransport to a linked device (pinned to that
// device's sync certificate, every request signed), and the joiner's half of linking.
import { request } from 'node:https';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

// ---- persistent CLAN hosting hand-over, destination side ----
/** What the destination's hosting authority offers (structural; implemented by @clan/core HostAuthority). */
export type HostingDestination = {
  beginStaging(chain: unknown, delegation: unknown, header: unknown, localKey: string): { hash: string };
  missingBlobs(clanId: string): Promise<{ sha256: string; size: number }[]>;
  stagingPath(clanId: string, sha256: string): string;
  completeStaging(clanId: string): Promise<void>;
  acknowledge(clanId: string, dest: { publicKey: string; sign(bytes: Uint8Array): string }): unknown;
  accept(chain: unknown, localKey: string): Promise<{ epoch: number; writable: boolean }>;
};
type Offer = { chain: unknown[]; header?: { clanId: string }; transition?: unknown; clan?: { type: string; name: string; expiresAt: number | null } };

/**
 * Pulls a frozen CLAN checkpoint from the current host (a linked device: pinned TLS + signed requests), verifies it
 * locally, acknowledges it, receives the signed transition and activates. Safe to re-run after any interruption:
 * staging resumes by byte range, verification is repeated, and a transition already signed for us is re-delivered.
 * `prepare` runs before staging (e.g. anchor the owner key of a CLAN this device has never seen).
 */
export async function replicateClan(o: { base: string; tlsCa: string; tlsSpki: string; auth: SyncAuth; clanId: string; delegation: unknown; hosting: HostingDestination;
  signer: { publicKey: string; sign(bytes: Uint8Array): string }; prepare?(offer: Offer): void; timeoutMs?: number; onProgress?(done: number, total: number): void }) {
  const t = pinnedTransport({ certificate: o.tlsCa, spkiSha256: o.tlsSpki });
  const call = async (method: string, path: string, body = '', extra: Record<string, string> = {}) => {
    const res = await t.fetch(`${o.base}${path}`, { method, headers: { ...o.auth(method, path, body), ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body || undefined, signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) });
    if (!res.ok && res.status !== 206) { const e = await res.json().catch(() => ({})) as { error?: string; message?: string }; throw new SyncHttpError(res.status, e.error ?? 'error', e.message ?? `HTTP ${res.status}`); }
    return res;
  };
  const post = async (path: string, v: unknown) => (await call('POST', path, JSON.stringify(v))).json() as Promise<Offer>;
  const offer = await post('/host/offer', { clanId: o.clanId, delegation: o.delegation });
  o.prepare?.(offer);
  if (offer.transition) return o.hosting.accept([...offer.chain, offer.transition], o.signer.publicKey);
  o.hosting.beginStaging(offer.chain, o.delegation, offer.header, o.signer.publicKey);
  for (let attempt = 0; ; attempt++) {
    const missing = await o.hosting.missingBlobs(o.clanId);
    const total = missing.reduce((n, b) => n + b.size, 0); let done = 0;
    for (const b of missing) {
      const final = o.hosting.stagingPath(o.clanId, b.sha256), part = `${final}.part`;
      let have = await stat(part).then((s) => s.size, () => 0);
      if (have > b.size) { await rm(part, { force: true }); have = 0; }
      if (have < b.size) {
        const res = await call('GET', `/host/blob/${o.clanId}/${b.sha256}`, '', have ? { range: `bytes=${have}-` } : {});
        if (have && res.status !== 206) { await rm(part, { force: true }); throw new SyncHttpError(res.status, 'no_range', 'The host did not resume the transfer.'); }
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part, { flags: 'a' }));
      }
      if ((await stat(part)).size !== b.size) throw new SyncHttpError(0, 'short', 'The host sent an incomplete file; retry to resume.');
      await rename(part, final);
      o.onProgress?.(done += b.size, total);
    }
    try { await o.hosting.completeStaging(o.clanId); break; } catch (e) {
      // A corrupt blob was deleted by verification; fetch it once more, then give up loudly.
      if ((e as { code?: string }).code !== 'corrupt' || attempt >= 1) throw e;
    }
  }
  const ack = o.hosting.acknowledge(o.clanId, o.signer);
  const done = await post('/host/relinquish', { clanId: o.clanId, delegation: o.delegation, ack });
  return o.hosting.accept([...done.chain, done.transition], o.signer.publicKey);
}

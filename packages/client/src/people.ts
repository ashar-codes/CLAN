// People endpoint client for Node (desktop main process, tests): first contact that binds the TLS key it saw to the
// peer's signed identity, then pinned and signed requests for profiles, envelopes and resumable file downloads.
import { request } from 'node:https';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TLSSocket } from 'node:tls';
import { PeerTlsBinding, peerBindingValid, type PeerEnvelope } from '@classroom/protocol';
import { pinnedTransport, spkiSha256OfDer } from './node.ts';
import { peerAuthHeaders, type PeerKeySigner } from './people-auth.ts';

export class PeerHttpError extends Error { readonly status: number; readonly code: string; constructor(status: number, code: string, m: string) { super(m); this.status = status; this.code = code; } }
const nonce = () => randomBytes(18).toString('base64url');

/** First contact with `endpoint` (host:port): learn which identity it is, authenticated by its signed TLS binding. */
export function hello(endpoint: string, signer: PeerKeySigner, o: { invite?: string; timeoutMs?: number } = {}): Promise<PeerTlsBinding> {
  const timeoutMs = o.timeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    const [host, port] = [endpoint.slice(0, endpoint.lastIndexOf(':')), Number(endpoint.slice(endpoint.lastIndexOf(':') + 1))];
    const body = '{}';
    // The SPKI is known only after the handshake; the request is signed for it from the socket's 'secureConnect'.
    const req = request({ host, port, path: '/peer/hello', method: 'POST', agent: false, rejectUnauthorized: false, minVersion: 'TLSv1.3', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': 2, ...(o.invite ? { 'x-clan-invite': o.invite } : {}) } }, (res) => {
      const raw = (res.socket as TLSSocket).getPeerCertificate()?.raw, chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { chunks.push(c); });
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { binding?: unknown; message?: string; error?: string };
          if (res.statusCode !== 200) return reject(new PeerHttpError(res.statusCode ?? 0, json.error ?? 'error', json.message ?? 'Not reachable.'));
          const b = PeerTlsBinding.safeParse(json.binding);
          if (!b.success || !peerBindingValid(b.data) || !raw || b.data.spkiSha256 !== spkiSha256OfDer(raw)) return reject(new PeerHttpError(0, 'identity_mismatch', 'That device did not prove its identity.'));
          resolve(b.data);
        } catch (e) { reject(e); }
      });
    });
    req.on('socket', (s) => s.once('secureConnect', () => {
      const raw = (s as TLSSocket).getPeerCertificate()?.raw;
      const h = peerAuthHeaders(signer, { method: 'POST', path: '/peer/hello', body, to: raw ? spkiSha256OfDer(raw) : '', nonce: nonce() });
      for (const [k, v] of Object.entries(h)) req.setHeader(k, v);
      req.end(body);
    }));
    req.on('timeout', () => req.destroy(new PeerHttpError(0, 'unreachable', 'The other device did not answer.')));
    req.on('error', reject);
  });
}

/** Pinned + signed client for one person at one endpoint. */
export function peerClient(o: { endpoint: string; tls: { certificate: string; spkiSha256: string }; peerKey: string; signer: PeerKeySigner; timeoutMs?: number; invite?: string }) {
  const t = pinnedTransport(o.tls), base = `https://${o.endpoint}`;
  const call = async (method: string, path: string, body = '', extra: Record<string, string> = {}) => {
    const res = await t.fetch(`${base}${path}`, { method, headers: { ...peerAuthHeaders(o.signer, { method, path, body, to: o.peerKey, nonce: nonce() }), ...(body ? { 'content-type': 'application/json' } : {}), ...(o.invite ? { 'x-clan-invite': o.invite } : {}), ...extra }, body: body || undefined, signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
    if (!res.ok && res.status !== 206) { const e = await res.json().catch(() => ({})) as { error?: string; message?: string }; throw new PeerHttpError(res.status, e.error ?? 'error', e.message ?? `HTTP ${res.status}`); }
    return res;
  };
  return {
    profile: async () => (await (await call('POST', '/peer/profile', '{}')).json() as { profile: unknown }).profile,
    /** Their picture as they show it to us (null if none); the caller verifies it against the signed profile. */
    avatar: async () => { try { const r = await (await call('POST', '/peer/avatar', '{}')).json() as { mime: string; data: string }; return { mime: r.mime, data: Buffer.from(r.data, 'base64url') }; } catch (e) { if (e instanceof PeerHttpError && e.status === 404) return null; throw e; } },
    send: async (envelopes: PeerEnvelope[], intro?: unknown) => (await (await call('POST', '/peer/inbox', JSON.stringify({ envelopes, ...(intro ? { intro } : {}) }))).json() as { results: { ok: boolean; error?: string; final?: boolean }[] }).results,
    /** Resumable: continues `${dest}.part`; renames to `dest` when complete. The caller verifies the hash. */
    download: async (transferId: string, dest: string, size: number, onProgress?: (n: number) => void) => {
      const part = `${dest}.part`;
      let have = await stat(part).then((s) => s.size, () => 0);
      if (have > size) { await rm(part, { force: true }); have = 0; }
      if (have < size) {
        const res = await call('POST', `/peer/file/${transferId}`, '{}', have ? { range: `bytes=${have}-` } : {});
        if (have && res.status !== 206) { await rm(part, { force: true }); throw new PeerHttpError(res.status, 'no_range', 'The other device did not resume; retrying from the start.'); }
        let n = have;
        const counter = new TransformCounter((d) => { n += d; onProgress?.(n); });
        await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(part, { flags: 'a' }));
      }
      if ((await stat(part)).size !== size) throw new PeerHttpError(0, 'short', 'The transfer stopped; retry to resume.');
      await rename(part, dest);
      return dest;
    },
  };
}
class TransformCounter extends Transform {
  private tick: (n: number) => void;
  constructor(tick: (n: number) => void) { super(); this.tick = tick; }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) { this.tick(chunk.length); cb(null, chunk); }
}

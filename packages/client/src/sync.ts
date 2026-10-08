// Personal device sync, client side (Node / Electron main): the LAN SyncTransport to a linked device (pinned to that
// device's sync certificate, every request signed), and the joiner's half of linking.
import { request } from 'node:https';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { linkTranscript, SyncBatch, type LinkGrant, type LinkHello, type SyncRecord, type SyncTransport } from '@classroom/protocol';
import { pinnedTransport, spkiSha256OfDer } from './node.ts';

export type SyncAuth = (method: string, path: string, body: string) => Record<string, string>;
export class SyncHttpError extends Error { readonly code: string; readonly status: number; constructor(status: number, code: string, m: string) { super(m); this.status = status; this.code = code; } }

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

const linkKey = (code: string) => createHash('sha256').update(`clan-sync-link-key/v1|${code}`).digest();
const hmac = (code: string, s: string) => createHmac('sha256', linkKey(code)).update(s).digest('base64url');

/**
 * Joiner: with the code typed from the trusted device, prove knowledge of it bound to that device's TLS key and to our
 * device key, wait for the student to approve there, then verify the approver's proof before accepting the grant.
 */
export async function joinWithCode(o: { base: string; code: string; device: LinkHello['device']; sign(bytes: Uint8Array): string; signal?: AbortSignal; pollMs?: number }): Promise<{ grant: LinkGrant; serverSpki: string }> {
  const start = await postSeeing(o.base, '/link/start', {});
  if (start.status !== 200) throw new SyncHttpError(start.status, (start.json as { error?: string }).error ?? 'error', (start.json as { message?: string }).message ?? 'No link is open on that device.');
  const { sessionId, nonceA } = start.json as { sessionId: string; nonceA: string };
  const nonceB = randomBytes(18).toString('base64url'), spki = start.spki;
  const tr = linkTranscript('joiner', { sessionId, serverSpki: spki, joinerKey: o.device.publicKey, nonceA, nonceB });
  const hello = await postSeeing(o.base, '/link/hello', { sessionId, nonceB, proof: hmac(o.code, tr), sig: o.sign(new TextEncoder().encode(tr)), device: o.device } satisfies LinkHello);
  if (hello.spki !== spki) throw new Error('The other device changed during linking.');
  if (hello.status !== 200) throw new SyncHttpError(hello.status, (hello.json as { error?: string }).error ?? 'error', (hello.json as { message?: string }).message ?? 'Linking failed.');
  for (;;) {
    if (o.signal?.aborted) throw new Error('Cancelled.');
    await new Promise((r) => setTimeout(r, o.pollMs ?? 1000));
    const st = await postSeeing(o.base, '/link/status', { sessionId, nonceB });
    if (st.spki !== spki) throw new Error('The other device changed during linking.');
    const s = st.json as { status: string; proof?: string; grant?: LinkGrant };
    if (st.status !== 200) throw new SyncHttpError(st.status, 'no_link', 'The link was closed on the other device.');
    if (s.status === 'rejected') throw new SyncHttpError(403, 'rejected', 'The link was declined on the other device.');
    if (s.status !== 'approved') continue;
    const expected = hmac(o.code, linkTranscript('approver', { sessionId, serverSpki: spki, joinerKey: o.device.publicKey, nonceA, nonceB }));
    if (s.proof !== expected) throw new Error('The other device could not prove it showed this code.');
    const approver = s.grant!.devices.find((d) => d.fp === s.grant!.approver.fp);
    if (!approver || approver.tlsSpki !== spki) throw new Error('The approving device is not the one we talked to.');
    return { grant: s.grant!, serverSpki: spki };
  }
}

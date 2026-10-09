// Personal-device linking, joiner side — platform-neutral (desktop over node:https, the phone over its native
// first-contact TLS). `post` must report the server leaf SPKI it saw; every proof is bound to that key.
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { b64u, linkTranscript, type LinkGrant, type LinkHello } from '@classroom/protocol';

export class SyncHttpError extends Error { readonly code: string; readonly status: number; constructor(status: number, code: string, m: string) { super(m); this.status = status; this.code = code; } }
export type SeeingPost = (path: string, body: unknown) => Promise<{ status: number; json: unknown; spki: string }>;
const te = new TextEncoder();
const linkKey = (code: string) => sha256(te.encode(`clan-sync-link-key/v1|${code}`));
const hmacB64u = (code: string, s: string) => b64u.encode(hmac(sha256, linkKey(code), te.encode(s)));
const nonce = (rand: (n: number) => Uint8Array) => b64u.encode(rand(18));

/**
 * Joiner: with the code typed from the trusted device, prove knowledge of it bound to that device's TLS key and to our
 * device key, wait for the student to approve there, then verify the approver's proof before accepting the grant.
 */
export async function joinWithCode(o: { post: SeeingPost; code: string; device: LinkHello['device']; sign(bytes: Uint8Array): string | Promise<string>; random(n: number): Uint8Array; signal?: AbortSignal; pollMs?: number }): Promise<{ grant: LinkGrant; serverSpki: string }> {
  const err = (r: { status: number; json: unknown }, fallback: string) => new SyncHttpError(r.status, (r.json as { error?: string }).error ?? 'error', (r.json as { message?: string }).message ?? fallback);
  const start = await o.post('/link/start', {});
  if (start.status !== 200) throw err(start, 'No link is open on that device.');
  const { sessionId, nonceA } = start.json as { sessionId: string; nonceA: string };
  const nonceB = nonce(o.random), spki = start.spki;
  if (!spki) throw new Error('Could not read the other device’s certificate.');
  const tr = linkTranscript('joiner', { sessionId, serverSpki: spki, joinerKey: o.device.publicKey, nonceA, nonceB });
  const hello = await o.post('/link/hello', { sessionId, nonceB, proof: hmacB64u(o.code, tr), sig: await o.sign(te.encode(tr)), device: o.device } satisfies LinkHello);
  if (hello.spki !== spki) throw new Error('The other device changed during linking.');
  if (hello.status !== 200) throw err(hello, 'Linking failed.');
  for (;;) {
    if (o.signal?.aborted) throw new Error('Cancelled.');
    await new Promise((r) => setTimeout(r, o.pollMs ?? 1000));
    const st = await o.post('/link/status', { sessionId, nonceB });
    if (st.spki !== spki) throw new Error('The other device changed during linking.');
    const s = st.json as { status: string; proof?: string; grant?: LinkGrant };
    if (st.status !== 200) throw new SyncHttpError(st.status, 'no_link', 'The link was closed on the other device.');
    if (s.status === 'rejected') throw new SyncHttpError(403, 'rejected', 'The link was declined on the other device.');
    if (s.status !== 'approved') continue;
    const expected = hmacB64u(o.code, linkTranscript('approver', { sessionId, serverSpki: spki, joinerKey: o.device.publicKey, nonceA, nonceB }));
    if (s.proof !== expected) throw new Error('The other device could not prove it showed this code.');
    const approver = s.grant!.devices.find((d) => d.fp === s.grant!.approver.fp);
    if (!approver || approver.tlsSpki !== spki) throw new Error('The approving device is not the one we talked to.');
    return { grant: s.grant!, serverSpki: spki };
  }
}

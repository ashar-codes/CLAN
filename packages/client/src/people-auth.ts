// Signed request headers for the people endpoint (portable: desktop main, phone, tests). Proves the caller's identity
// key over method, path, time, nonce, body hash and the intended recipient (its key, or the SPKI seen at first contact).
import { b64u, bodySha, peerRequestStatement } from '@classroom/protocol';

export type PeerKeySigner = { publicKey: string; sign(bytes: Uint8Array): string };
export function peerAuthHeaders(s: PeerKeySigner, o: { method: string; path: string; body: string | Uint8Array; to: string; now?: number; nonce: string }) {
  const ts = o.now ?? Date.now(), sha = bodySha(o.body);
  const auth = b64u.encode(new TextEncoder().encode(JSON.stringify({ key: s.publicKey, ts, nonce: o.nonce, bodySha: sha })));
  return { 'x-clan-peer': auth, 'x-clan-peer-sig': s.sign(peerRequestStatement({ method: o.method, path: o.path, ts, nonce: o.nonce, bodySha: sha, key: s.publicKey, to: o.to })) };
}
/** First message on a people WebSocket (native sockets cannot set headers). */
export function peerSocketAuth(s: PeerKeySigner, to: string, nonce: string, now = Date.now()) {
  return { t: 'auth', key: s.publicKey, ts: now, nonce, sig: s.sign(peerRequestStatement({ method: 'GET', path: '/peer/ws', ts: now, nonce, bodySha: bodySha(''), key: s.publicKey, to })) };
}

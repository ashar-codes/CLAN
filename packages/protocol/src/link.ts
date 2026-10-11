// clan-link/1: the authenticated, encrypted session that personal communication runs over when there is no TLS
// endpoint to pin — phone ↔ phone over Wi-Fi Direct, Wi-Fi Aware, Apple peer-to-peer or a hotspot, and phone ↔ computer
// on a LAN without internet. Any reliable ordered byte stream can carry it (TCP today).
//
// Construction (SIGMA-I with standard primitives; same shape as Noise XX with the responder's identity sent last):
//   1  I → R   { v, e_i, n_i }                                   plaintext
//   2  R → I   { e_r, n_r }                                      plaintext
//      dh = X25519(e_i, e_r); h = SHA-256(label ‖ m1 ‖ m2); k_i, k_r = HKDF-SHA256(dh, salt = h)
//   3  I → R   ChaCha20-Poly1305(k_i, { key_I, sig_I(label‖"I"‖h‖key_I), invite? }, aad = h)
//      R checks the signature and its own policy (friend / invite / visibility / block) BEFORE revealing anything
//   4  R → I   ChaCha20-Poly1305(k_r, { key_R, sig_R(label‖"R"‖h‖key_R‖key_I) }, aad = h)  or a refusal
//      I checks the signature and, when it dialled a known person, that key_R is the key it expected.
//   data: ChaCha20-Poly1305 with per-direction keys HKDF(dh, salt = SHA-256(h ‖ key_I ‖ key_R)) and a 64-bit counter
//   nonce; a frame that fails to open, or arrives out of order, ends the session.
// Identities stay hidden from passive observers; a responder discloses its identity only to someone its policy accepts;
// signatures cover both ephemerals (no replay into another session) and the responder's covers the initiator's key
// (no identity misbinding). Ephemeral keys are fresh per session (forward secrecy).
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { b64u } from './trust.ts';
import { verifyStatement } from './people.ts';

export const LINK_VERSION = 'clan-link/1';
export const LINK_MAX_FRAME = 1024 * 1024 + 64;
export const LINK_HANDSHAKE_MS = 10_000;
const te = new TextEncoder(), td = new TextDecoder();
const KEY = /^[A-Za-z0-9_-]{43}$/;

/** A reliable, ordered byte stream (TCP socket, native socket bridge, in-memory pipe in tests). */
export type ByteLink = {
  send(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(): void;
};
export type LinkSigner = { publicKey: string; sign(bytes: Uint8Array): string };
export type SecureLink = {
  /** The other side's verified identity key. */
  peerKey: string;
  role: 'initiator' | 'responder';
  send(message: Uint8Array): void;
  onMessage(cb: (message: Uint8Array) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(reason?: string): void;
  readonly closed: boolean;
};
export class LinkError extends Error { readonly code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

/** Splits a byte stream into length-prefixed frames (4-byte big-endian length). */
export class FrameReader {
  private buf = new Uint8Array(0);
  private readonly max: number;
  constructor(max = LINK_MAX_FRAME) { this.max = max; }
  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length); merged.set(this.buf); merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const n = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0);
      if (n > this.max) throw new LinkError('too_large', 'Frame exceeds the limit.');
      if (this.buf.length < 4 + n) break;
      out.push(this.buf.slice(4, 4 + n)); this.buf = this.buf.slice(4 + n);
    }
    return out;
  }
}
export const frame = (payload: Uint8Array) => { const out = new Uint8Array(4 + payload.length); new DataView(out.buffer).setUint32(0, payload.length); out.set(payload, 4); return out; };
const cat = (...a: Uint8Array[]) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
const nonce = (n: bigint) => { const b = new Uint8Array(12); new DataView(b.buffer).setBigUint64(4, n); return b; };
const json = (b: Uint8Array): Record<string, unknown> => { try { const v = JSON.parse(td.decode(b)); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const bin = (s: unknown, len: number) => { if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw new LinkError('malformed', 'Malformed handshake.'); const b = b64u.decode(s); if (b.length !== len) throw new LinkError('malformed', 'Malformed handshake.'); return b; };

/** Pull frames one at a time from a ByteLink during the handshake (then hand the stream to the session). */
function framesOf(link: ByteLink) {
  const reader = new FrameReader(LINK_MAX_FRAME), queue: Uint8Array[] = [];
  let waiting: { res(f: Uint8Array): void; rej(e: Error): void } | null = null, ended: Error | null = null, sink: ((f: Uint8Array) => void) | null = null, closeSink: ((r?: string) => void) | null = null;
  const fail = (e: Error) => { ended = e; waiting?.rej(e); waiting = null; };
  link.onData((chunk) => {
    let frames: Uint8Array[];
    try { frames = reader.push(chunk); } catch (e) { fail(e as Error); link.close(); return; }
    for (const f of frames) { if (sink) sink(f); else if (waiting) { const w = waiting; waiting = null; w.res(f); } else queue.push(f); }
  });
  link.onClose((r) => { if (closeSink) closeSink(r); else fail(new LinkError('closed', r ? `Connection closed (${r}).` : 'Connection closed.')); });
  return {
    next: () => new Promise<Uint8Array>((res, rej) => { const f = queue.shift(); if (f) return res(f); if (ended) return rej(ended); waiting = { res, rej }; }),
    /** After the handshake: deliver every further frame (and the backlog) to `f`. */
    attach(f: (frame: Uint8Array) => void, onClose: (r?: string) => void) {
      sink = f; closeSink = onClose;
      for (const q of queue.splice(0)) f(q);
      if (ended) onClose(ended.message);
    },
    reader,
  };
}

function session(link: ByteLink, frames: ReturnType<typeof framesOf>, role: SecureLink['role'], peerKey: string, sendKey: Uint8Array, recvKey: Uint8Array): SecureLink {
  let sendN = 0n, recvN = 0n, closed = false;
  const msgSubs: ((m: Uint8Array) => void)[] = [], closeSubs: ((r?: string) => void)[] = [], backlog: Uint8Array[] = [];
  const end = (reason?: string) => { if (closed) return; closed = true; link.close(); for (const c of closeSubs) c(reason); };
  frames.attach((f) => {
    if (closed) return;
    let m: Uint8Array;
    try { m = chacha20poly1305(recvKey, nonce(recvN)).decrypt(f); } catch { return end('A message failed authentication.'); }
    recvN++;
    if (msgSubs.length) for (const s of msgSubs) s(m); else backlog.push(m);
  }, (r) => end(r));
  return {
    peerKey, role,
    get closed() { return closed; },
    send(m) {
      if (closed) throw new LinkError('closed', 'The connection is closed.');
      if (m.length > LINK_MAX_FRAME - 16) throw new LinkError('too_large', 'Message too large.');
      link.send(frame(chacha20poly1305(sendKey, nonce(sendN++)).encrypt(m)));
    },
    onMessage(cb) { msgSubs.push(cb); for (const m of backlog.splice(0)) cb(m); },
    onClose(cb) { if (closed) cb(); else closeSubs.push(cb); },
    close: (reason) => end(reason),
  };
}

const withTimeout = <T>(p: Promise<T>, ms: number, link: ByteLink) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => { link.close(); rej(new LinkError('timeout', 'The other device did not complete the secure handshake.')); }, ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); link.close(); rej(e); });
});

/** Dial side. `expectKey`: the person you meant to reach (from a contact or a scanned code); anyone else is refused. */
export function linkInitiate(link: ByteLink, o: { signer: LinkSigner; expectKey?: string; invite?: string; timeoutMs?: number }): Promise<SecureLink> {
  return withTimeout((async () => {
    const frames = framesOf(link);
    const e = x25519.keygen(), m1 = te.encode(JSON.stringify({ v: LINK_VERSION, e: b64u.encode(e.publicKey), n: b64u.encode(randomBytes(16)) }));
    link.send(frame(m1));
    const m2 = await frames.next(), r2 = json(m2);
    if (r2.refused) throw new LinkError('refused', 'The other device is not accepting connections.');
    const er = bin(r2.e, 32); bin(r2.n, 16);
    const dh = x25519.getSharedSecret(e.secretKey, er);
    const h = sha256(cat(te.encode(LINK_VERSION), m1, m2)), hk = hkdf(sha256, dh, h, te.encode(`${LINK_VERSION} hs`), 64);
    const ki = hk.slice(0, 32), kr = hk.slice(32);
    const me = o.signer.publicKey;
    const sig = o.signer.sign(cat(te.encode(`${LINK_VERSION} I`), h, te.encode(me)));
    link.send(frame(chacha20poly1305(ki, nonce(0n), h).encrypt(te.encode(JSON.stringify({ key: me, sig, ...(o.invite ? { invite: o.invite } : {}) })))));
    const c4 = await frames.next();
    let p4: Uint8Array;
    try { p4 = chacha20poly1305(kr, nonce(0n), h).decrypt(c4); } catch { throw new LinkError('bad_auth', 'The other device failed the secure handshake.'); }
    const r4 = json(p4);
    if (r4.refused) throw new LinkError('refused', typeof r4.message === 'string' ? r4.message.slice(0, 200) : 'Not accepted.');
    const peer = r4.key;
    if (typeof peer !== 'string' || !KEY.test(peer) || typeof r4.sig !== 'string') throw new LinkError('malformed', 'Malformed handshake.');
    if (!verifyStatement(peer, cat(te.encode(`${LINK_VERSION} R`), h, te.encode(peer), te.encode(me)), r4.sig)) throw new LinkError('bad_auth', 'The other device did not prove its identity.');
    if (o.expectKey && peer !== o.expectKey) throw new LinkError('wrong_peer', 'A different device answered (identity did not match).');
    if (peer === me) throw new LinkError('wrong_peer', 'That is this device.');
    const dk = hkdf(sha256, dh, sha256(cat(h, te.encode(me), te.encode(peer))), te.encode(`${LINK_VERSION} data`), 64);
    return session(link, frames, 'initiator', peer, dk.slice(0, 32), dk.slice(32));
  })(), o.timeoutMs ?? LINK_HANDSHAKE_MS, link);
}

/** Listen side. `accept` decides before this device reveals who it is (friends, invite holders, visibility, blocks). */
export function linkRespond(link: ByteLink, o: { signer: LinkSigner; accept(peerKey: string, invite: string | null): boolean | string; timeoutMs?: number }): Promise<SecureLink> {
  return withTimeout((async () => {
    const frames = framesOf(link);
    const m1 = await frames.next(), r1 = json(m1);
    if (r1.v !== LINK_VERSION) { link.send(frame(te.encode(JSON.stringify({ refused: true, v: LINK_VERSION })))); throw new LinkError('version', 'Unsupported link version.'); }
    const ei = bin(r1.e, 32); bin(r1.n, 16);
    const e = x25519.keygen(), m2 = te.encode(JSON.stringify({ e: b64u.encode(e.publicKey), n: b64u.encode(randomBytes(16)) }));
    link.send(frame(m2));
    const dh = x25519.getSharedSecret(e.secretKey, ei);
    const h = sha256(cat(te.encode(LINK_VERSION), m1, m2)), hk = hkdf(sha256, dh, h, te.encode(`${LINK_VERSION} hs`), 64);
    const ki = hk.slice(0, 32), kr = hk.slice(32);
    let p3: Uint8Array;
    try { p3 = chacha20poly1305(ki, nonce(0n), h).decrypt(await frames.next()); } catch (err) { if (err instanceof LinkError) throw err; throw new LinkError('bad_auth', 'Handshake failed authentication.'); }
    const r3 = json(p3), peer = r3.key;
    if (typeof peer !== 'string' || !KEY.test(peer) || typeof r3.sig !== 'string') throw new LinkError('malformed', 'Malformed handshake.');
    if (!verifyStatement(peer, cat(te.encode(`${LINK_VERSION} I`), h, te.encode(peer)), r3.sig)) throw new LinkError('bad_auth', 'The caller did not prove its identity.');
    const me = o.signer.publicKey;
    if (peer === me) throw new LinkError('wrong_peer', 'Connection from this device to itself.');
    const invite = typeof r3.invite === 'string' && r3.invite.length <= 64 ? r3.invite : null;
    const ok = o.accept(peer, invite);
    if (ok !== true) {
      link.send(frame(chacha20poly1305(kr, nonce(0n), h).encrypt(te.encode(JSON.stringify({ refused: true, message: typeof ok === 'string' ? ok : 'Not accepted.' })))));
      throw new LinkError('refused', 'Caller not accepted.');
    }
    const sig = o.signer.sign(cat(te.encode(`${LINK_VERSION} R`), h, te.encode(me), te.encode(peer)));
    link.send(frame(chacha20poly1305(kr, nonce(0n), h).encrypt(te.encode(JSON.stringify({ key: me, sig })))));
    const dk = hkdf(sha256, dh, sha256(cat(h, te.encode(peer), te.encode(me))), te.encode(`${LINK_VERSION} data`), 64);
    return session(link, frames, 'responder', peer, dk.slice(32), dk.slice(0, 32));
  })(), o.timeoutMs ?? LINK_HANDSHAKE_MS, link);
}

/** A throwaway identity for looking at public profiles without revealing who is looking. */
export function ephemeralSigner(): LinkSigner {
  const sk = ed25519.utils.randomSecretKey();
  return { publicKey: b64u.encode(ed25519.getPublicKey(sk)), sign: (b) => b64u.encode(ed25519.sign(b, sk)) };
}

/** In-memory connected pair of ByteLinks (tests, and same-process loopback). */
export function bytePipe(): [ByteLink, ByteLink] {
  const mk = () => ({ data: [] as ((b: Uint8Array) => void)[], close: [] as ((r?: string) => void)[], closed: false });
  const a = mk(), b = mk();
  const side = (me: typeof a, other: typeof a): ByteLink => ({
    send: (bytes) => { if (me.closed || other.closed) return; const copy = bytes.slice(); queueMicrotask(() => { if (!other.closed) for (const f of other.data) f(copy); }); },
    onData: (cb) => { me.data.push(cb); },
    onClose: (cb) => { me.close.push(cb); },
    close: () => { if (me.closed) return; me.closed = true; other.closed = true; queueMicrotask(() => { for (const f of me.close) f('closed'); for (const f of other.close) f('closed by peer'); }); },
  });
  return [side(a, b), side(b, a)];
}

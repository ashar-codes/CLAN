// Shared, platform-neutral trust primitives. Only standard constructions from audited libraries:
// RFC 8785 JSON canonicalization, SHA-256, HKDF-SHA256 (RFC 5869), HMAC-SHA256, Ed25519 (RFC 8032 via @noble/curves).
import canonicalize from 'canonicalize';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Receipt, ReceiptPayload, TlsBinding } from './index.ts';

const enc = new TextEncoder();

export const b64u = {
  encode(b: Uint8Array): string {
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

/** RFC 8785 canonical JSON. Throws instead of silently signing `undefined`. */
export function canonical(value: unknown): string {
  const s = canonicalize(value);
  if (s === undefined) throw new Error('not canonicalizable');
  return s;
}
export const canonicalBytes = (value: unknown) => enc.encode(canonical(value));

/** Device / teacher identity: SHA-256 of the raw Ed25519 public key, base64url. */
export const keyFingerprint = (publicKeyB64: string) => b64u.encode(sha256(b64u.decode(publicKeyB64)));
/** "3F9A-12C4-7B0E-D551" (first 64 bits, hex) for people to compare out loud. */
export const shortFingerprint = (fp: string) =>
  Array.from(b64u.decode(fp).slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g)!.join('-');

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Separate keys per purpose from the 64-byte OPAQUE session key (HKDF-SHA256, fixed labels). */
export function derivePairingKeys(opaqueSessionKeyB64: string) {
  const ikm = b64u.decode(opaqueSessionKeyB64);
  const salt = enc.encode('classroom-lan/v1/pairing');
  return {
    binding: hkdf(sha256, ikm, salt, enc.encode('classroom-lan/v1 tls-binding mac'), 32),
    join: hkdf(sha256, ikm, salt, enc.encode('classroom-lan/v1 join-proof mac'), 32),
  };
}

export const macOf = (key: Uint8Array, value: unknown) => b64u.encode(hmac(sha256, key, canonicalBytes(value)));
export const macValid = (key: Uint8Array, value: unknown, mac: string) => {
  try { return timingSafeEqualBytes(b64u.decode(macOf(key, value)), b64u.decode(mac)); } catch { return false; }
};

export function ed25519Verify(publicKeyB64: string, value: unknown, signatureB64: string): boolean {
  try { return ed25519.verify(b64u.decode(signatureB64), canonicalBytes(value), b64u.decode(publicKeyB64)); } catch { return false; }
}

export type BindingCheck = { ok: true; binding: TlsBinding } | { ok: false; reason: string };

/** Client-side verification of the PAKE-authenticated TLS binding. Any failure means: do not connect. */
export function verifyBinding(bindingKey: Uint8Array, msg: { binding: TlsBinding; mac: string }, expect: { sessionId: string; pairingId: string; now?: number }): BindingCheck {
  const b = msg?.binding;
  if (!b || typeof msg.mac !== 'string' || !macValid(bindingKey, b, msg.mac)) return { ok: false, reason: 'binding MAC invalid (possible man-in-the-middle)' };
  if (b.type !== 'classroom-lan/tls-binding' || b.v !== 1) return { ok: false, reason: 'unsupported binding' };
  if (b.sessionId !== expect.sessionId || b.pairingId !== expect.pairingId) return { ok: false, reason: 'binding is for another classroom or attempt' };
  const now = expect.now ?? Date.now();
  if (!(b.expiresAt > now) || b.issuedAt > now + 120_000 || b.expiresAt - b.issuedAt > 10 * 60_000) return { ok: false, reason: 'binding expired' };
  if (!Number.isInteger(b.httpsPort) || b.httpsPort < 1 || b.httpsPort > 65535) return { ok: false, reason: 'bad port' };
  if (typeof b.certificate !== 'string' || typeof b.spkiSha256 !== 'string' || typeof b.teacherPublicKey !== 'string') return { ok: false, reason: 'bad binding fields' };
  // The transport then trusts exactly `certificate` and additionally requires the server's SPKI to equal `spkiSha256`.
  return { ok: true, binding: b };
}

export type ReceiptCheck = { ok: true; payload: ReceiptPayload } | { ok: false; reason: string };

/**
 * Verify a signed receipt offline. Pass the teacher key you trust (from pairing / your records); without it, only
 * internal consistency is checked and the caller must treat the result as unverified.
 */
export function verifyReceipt(r: Receipt, opts: { trustedTeacherKey?: string; sessionId?: string } = {}): ReceiptCheck {
  if (!r || r.alg !== 'Ed25519' || !r.payload || typeof r.signature !== 'string') return { ok: false, reason: 'malformed receipt' };
  const p = r.payload;
  if (p.type !== 'classroom-lan/receipt' || p.v !== 1) return { ok: false, reason: 'unsupported receipt version' };
  if (opts.trustedTeacherKey && r.teacherPublicKey !== opts.trustedTeacherKey) return { ok: false, reason: 'signed by a different teacher key' };
  let fp: string;
  try { fp = keyFingerprint(r.teacherPublicKey); } catch { return { ok: false, reason: 'bad teacher key' }; }
  if (p.teacherKeyFingerprint !== fp) return { ok: false, reason: 'teacher key does not match receipt' };
  if (opts.sessionId && p.sessionId !== opts.sessionId) return { ok: false, reason: 'receipt is from another classroom session' };
  if (!ed25519Verify(r.teacherPublicKey, p, r.signature)) return { ok: false, reason: 'signature invalid (receipt was altered)' };
  return { ok: true, payload: p };
}

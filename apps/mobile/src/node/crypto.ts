// `node:crypto` for @clan/core on the phone (Metro alias, see metro.config.js): exactly the calls core makes, on
// audited JS primitives (@noble/hashes, @noble/curves) and the OS random source (expo-crypto). Nothing else.
import { getRandomBytes, randomUUID as uuid } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64u } from '@classroom/protocol';

type Enc = 'hex' | 'base64' | 'base64url' | 'utf8' | undefined;
const te = new TextEncoder();
const bytes = (v: string | Uint8Array) => (typeof v === 'string' ? te.encode(v) : v);
const encode = (b: Uint8Array, enc: Enc): string => {
  if (enc === 'hex') return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  if (enc === 'base64url') return b64u.encode(b);
  if (enc === 'base64') { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }
  return new TextDecoder().decode(b);
};
/** A Uint8Array whose toString(enc) behaves like Buffer's for the encodings core uses. */
class Bytes extends Uint8Array { toString(enc?: Enc) { return enc ? encode(this, enc) : super.toString(); } }
const wrap = (b: Uint8Array) => new Bytes(b.buffer as ArrayBuffer, b.byteOffset, b.length);

export const randomUUID = () => uuid();
export const randomBytes = (n: number) => wrap(getRandomBytes(n));

type Digest = { (): Bytes; (enc: Exclude<Enc, undefined>): string };
const digest = (get: () => Uint8Array): Digest => ((enc?: Enc) => { const d = get(); return enc ? encode(d, enc) : wrap(d); }) as Digest;
export function createHash(alg: 'sha256') {
  if (alg !== 'sha256') throw new Error(`Unsupported hash ${alg}`);
  const h = sha256.create();
  const self = { update(v: string | Uint8Array) { h.update(bytes(v)); return self; }, digest: digest(() => h.digest()) };
  return self;
}
export function createHmac(alg: 'sha256', key: string | Uint8Array) {
  if (alg !== 'sha256') throw new Error(`Unsupported HMAC ${alg}`);
  const h = hmac.create(sha256, bytes(key));
  const self = { update(v: string | Uint8Array) { h.update(bytes(v)); return self; }, digest: digest(() => h.digest()) };
  return self;
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!; return d === 0;
}
/** Only Ed25519 SPKI DER (what core builds): the raw key is the last 32 bytes. */
export function createPublicKey(o: { key: Uint8Array; format: 'der'; type: 'spki' }) {
  if (o.key.length !== 44 || o.key[0] !== 0x30) throw new Error('Only Ed25519 SPKI keys are supported.');
  return { raw: o.key.slice(12) };
}
export function verify(_alg: null, data: Uint8Array, key: { raw: Uint8Array }, sig: Uint8Array) {
  try { return ed25519.verify(sig, data, key.raw, { zip215: false }); } catch { return false; } // strict RFC 8032, as Node
}

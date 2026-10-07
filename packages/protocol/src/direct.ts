// CLAN Direct Network: how a member gets from "six-digit code" to the host's own Wi-Fi without IP/port/SSID typing.
// The six-digit code stays the OPAQUE secret only. The Wi-Fi credential is fresh random per session and is released
// only inside a completed OPAQUE exchange, sealed with an OPAQUE-derived key (AES-256-GCM, @noble/ciphers).
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { b64u } from './trust.ts';

export const DIRECT_PACKAGE_TTL_MS = 10 * 60_000;

export const DirectPackage = z.object({
  v: z.literal(1),
  sessionId: z.uuid(),
  ssid: z.string().regex(/^CLAN-[0-9A-Z]{4}$/),
  passphrase: z.string().min(16).max(63),
  auth: z.enum(['WPA2', 'WPA3']),
  /** Host address on the Direct network and its plaintext bootstrap port (OPAQUE only; everything else is pinned HTTPS). */
  host: z.ipv4(),
  bootstrapPort: z.number().int().min(1).max(65535),
  expiresAt: z.number().int(),
});
export type DirectPackage = z.infer<typeof DirectPackage>;
export type SealedDirect = { nonce: string; ciphertext: string };

const aad = (sessionId: string, pairingId: string) => new TextEncoder().encode(`classroom-lan/v1/direct/${sessionId}/${pairingId}`);

/** Encrypt + authenticate a package for one pairing (bound to session + pairing id via AAD). */
export function sealDirect(key: Uint8Array, pkg: DirectPackage, pairingId: string): SealedDirect {
  const nonce = randomBytes(12);
  const ct = gcm(key, nonce, aad(pkg.sessionId, pairingId)).encrypt(new TextEncoder().encode(JSON.stringify(DirectPackage.parse(pkg))));
  return { nonce: b64u.encode(nonce), ciphertext: b64u.encode(ct) };
}

/** Throws on any tampering, a different session/pairing, or an expired package. */
export function openDirect(key: Uint8Array, sealed: SealedDirect, o: { sessionId: string; pairingId: string; now?: number }): DirectPackage {
  const pt = gcm(key, b64u.decode(sealed.nonce), aad(o.sessionId, o.pairingId)).decrypt(b64u.decode(sealed.ciphertext));
  const pkg = DirectPackage.parse(JSON.parse(new TextDecoder().decode(pt)));
  if (pkg.sessionId !== o.sessionId) throw new Error('Direct package is for another session.');
  if (pkg.expiresAt <= (o.now ?? Date.now())) throw new Error('Direct package expired.');
  return pkg;
}

// ---- credentials ----
const SSID_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O look-alikes
const PASS_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Unbiased random string (rejection sampling over CSPRNG bytes). */
function randomFrom(alphabet: string, n: number, rand: (n: number) => Uint8Array = randomBytes) {
  const max = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < n) for (const b of rand(n * 2)) { if (b < max && out.length < n) out += alphabet[b % alphabet.length]; }
  return out;
}
/** SSID carries nothing about the person, course or school; passphrase ≈ 139 bits, never derived from the join code. */
export const newDirectCredentials = (rand?: (n: number) => Uint8Array) => ({ ssid: `CLAN-${randomFrom(SSID_ALPHABET, 4, rand)}`, passphrase: randomFrom(PASS_ALPHABET, 24, rand) });

// ---- QR fallback ----
/** Network-only bootstrap shown on the host screen. Holds no join code; OPAQUE still decides membership. */
export const DIRECT_QR_PREFIX = 'clan://direct#';
export const encodeDirectQr = (p: DirectPackage) => DIRECT_QR_PREFIX + b64u.encode(new TextEncoder().encode(JSON.stringify(DirectPackage.parse(p))));
export function decodeDirectQr(text: string, now = Date.now()): DirectPackage {
  if (!text.startsWith(DIRECT_QR_PREFIX) || text.length > 1024) throw new Error('Not a CLAN code.');
  const p = DirectPackage.parse(JSON.parse(new TextDecoder().decode(b64u.decode(text.slice(DIRECT_QR_PREFIX.length)))));
  if (p.expiresAt <= now) throw new Error('This QR code has expired. Ask the host to show it again.');
  return p;
}

// ---- BLE bootstrap carrier ----
/** GATT service carrying only the existing OPAQUE pairing messages. Advertisement = service UUID + random tag (no names). */
export const BLE = {
  service: '6f1a0001-7c3b-4d5e-9a2b-c1a4e5f60001',
  /** client → host (write without response) */
  rx: '6f1a0002-7c3b-4d5e-9a2b-c1a4e5f60001',
  /** host → client (notify) */
  tx: '6f1a0003-7c3b-4d5e-9a2b-c1a4e5f60001',
  chunk: 180,
  maxChunks: 64,
} as const;

export const BleRequest = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello') }),
  z.object({ t: z.literal('start'), sessionId: z.uuid(), startLoginRequest: z.string().max(4096) }),
  z.object({ t: z.literal('finish'), pairingId: z.uuid(), finishLoginRequest: z.string().max(4096) }),
  z.object({ t: z.literal('abort'), pairingId: z.uuid() }),
]);
export type BleRequest = z.infer<typeof BleRequest>;
export type BleResponse = { ok: true; body: unknown } | { ok: false; code: string; message: string };

/** Split a message into GATT-sized frames: [messageId, index, count, ...bytes]. */
export function bleFrames(id: number, msg: unknown): Uint8Array[] {
  const bytes = new TextEncoder().encode(JSON.stringify(msg));
  const size = BLE.chunk - 3, count = Math.ceil(bytes.length / size) || 1;
  if (count > BLE.maxChunks) throw new Error('BLE message too large.');
  return Array.from({ length: count }, (_, i) => Uint8Array.of(id & 0xff, i, count, ...bytes.subarray(i * size, (i + 1) * size)));
}

/** Reassembles frames per message id; bounded memory; malformed input is dropped, never thrown at the radio layer. */
export class BleReassembler {
  private parts = new Map<number, { count: number; got: Map<number, Uint8Array>; at: number }>();
  push(frame: Uint8Array, now = Date.now()): unknown | undefined {
    for (const [k, v] of this.parts) if (now - v.at > 30_000) this.parts.delete(k);
    if (frame.length < 3) return undefined;
    const [id, i, count] = [frame[0]!, frame[1]!, frame[2]!];
    if (!count || count > BLE.maxChunks || i >= count || frame.length > BLE.chunk) return undefined;
    const p = this.parts.get(id) ?? { count, got: new Map(), at: now };
    if (p.count !== count || this.parts.size > 8 && !this.parts.has(id)) return undefined;
    p.got.set(i, frame.subarray(3));
    this.parts.set(id, p);
    if (p.got.size < count) return undefined;
    this.parts.delete(id);
    const all = Array.from({ length: count }, (_, k) => p.got.get(k)!);
    try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(all.flatMap((a) => [...a])))); } catch { return undefined; }
  }
}

// Data-plane objects (Milestone 2.75). Everything a peer relies on is SIGNED BY THE TEACHER'S Ed25519 KEY:
// resource manifests (what the bytes must be), peer endorsements (which TLS key belongs to which approved device),
// peer capabilities (who may request classroom data). Network roles never carry authority; signatures do.
import { canonicalBytes, ed25519Verify, keyFingerprint } from './trust.ts';

/** Teacher-signed envelope (same shape as receipts). */
export type Signed<T> = { payload: T; alg: 'Ed25519'; signature: string; teacherPublicKey: string };

export type ManifestPayload = {
  type: 'classroom-lan/resource-manifest'; v: 1;
  resourceId: string; sessionId: string; courseTitle: string;
  name: string; mime: string; size: number; sha256: string;
  chunkSize: number; chunks: string[]; // ordered SHA-256 hex of each chunk
  version: number; createdAt: number; teacherKeyFingerprint: string;
};
export type SignedManifest = Signed<ManifestPayload>;

/** Binds an approved member's device key to the TLS identity of its peer server, for one session, briefly. */
export type EndorsementPayload = {
  type: 'classroom-lan/peer-endorsement'; v: 1;
  sessionId: string; memberId: string; devicePublicKey: string; deviceKeyFingerprint: string;
  tlsCa: string; tlsSpkiSha256: string; issuedAt: number; expiresAt: number; teacherKeyFingerprint: string;
};
export type PeerEndorsement = Signed<EndorsementPayload>;

/** Lets one approved member read classroom resources from peers, briefly. Revocation = expiry + pushed deny list. */
export type CapabilityPayload = {
  type: 'classroom-lan/peer-capability'; v: 1;
  capId: string; sessionId: string; memberId: string; holderPublicKey: string; holderFingerprint: string;
  scope: 'resources:read'; issuedAt: number; expiresAt: number; teacherKeyFingerprint: string;
};
export type PeerCapability = Signed<CapabilityPayload>;

/** Signed by the HOLDER's device key, naming the serving peer, so a capability shown to one peer can't be replayed to another. */
export type PeerRequestProof = { type: 'classroom-lan/peer-request'; v: 1; capId: string; servingFingerprint: string; issuedAt: number };

export type SignedCheck<T> = { ok: true; payload: T } | { ok: false; reason: string };

/** Verify a teacher-signed object against the teacher key the verifier trusts (from pairing). Never trusts the embedded key alone. */
export function verifySigned<T extends { type: string; v: number; teacherKeyFingerprint: string }>(s: Signed<T>, type: T['type'], trustedTeacherKey: string, now = Date.now()): SignedCheck<T> {
  if (!s || s.alg !== 'Ed25519' || !s.payload || typeof s.signature !== 'string') return { ok: false, reason: 'malformed' };
  if (s.payload.type !== type || s.payload.v !== 1) return { ok: false, reason: 'wrong type/version' };
  if (s.teacherPublicKey !== trustedTeacherKey) return { ok: false, reason: 'not signed by the classroom teacher' };
  if (s.payload.teacherKeyFingerprint !== keyFingerprint(trustedTeacherKey)) return { ok: false, reason: 'teacher key mismatch' };
  if (!ed25519Verify(trustedTeacherKey, s.payload, s.signature)) return { ok: false, reason: 'bad signature' };
  const exp = (s.payload as { expiresAt?: number }).expiresAt;
  if (exp !== undefined && !(exp > now)) return { ok: false, reason: 'expired' };
  return { ok: true, payload: s.payload };
}

export function verifyManifest(m: SignedManifest, o: { trustedTeacherKey: string; sessionId: string; resourceId: string }): SignedCheck<ManifestPayload> {
  const r = verifySigned(m, 'classroom-lan/resource-manifest', o.trustedTeacherKey);
  if (!r.ok) return r;
  const p = r.payload;
  if (p.sessionId !== o.sessionId || p.resourceId !== o.resourceId) return { ok: false, reason: 'manifest is for another resource or class' };
  const expect = Math.max(1, Math.ceil(p.size / p.chunkSize));
  if (!Number.isInteger(p.chunkSize) || p.chunkSize < 4096 || p.chunks.length !== expect || !p.chunks.every((h) => /^[a-f0-9]{64}$/.test(h)) || !/^[a-f0-9]{64}$/.test(p.sha256)) {
    return { ok: false, reason: 'inconsistent manifest' };
  }
  return r;
}

export const signBytes = canonicalBytes;

// ---- chunk bitfields (bit i = has chunk i), base64url ----
export const bitfield = {
  empty: (n: number) => new Uint8Array(Math.ceil(n / 8)),
  set(b: Uint8Array, i: number) { b[i >> 3]! |= 0x80 >> (i & 7); },
  has: (b: Uint8Array, i: number) => ((b[i >> 3] ?? 0) & (0x80 >> (i & 7))) !== 0,
  count(b: Uint8Array, n: number) { let c = 0; for (let i = 0; i < n; i++) if (bitfield.has(b, i)) c++; return c; },
};

/** Capabilities a client platform supports (not every device can or should seed). */
export type PeerCapabilities = { canDownload: boolean; canSeed: boolean; canRelayMedia: boolean };

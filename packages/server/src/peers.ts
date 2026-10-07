// Teacher-side peer bookkeeping for the peer-assisted data plane. Control plane only: it signs endorsements and
// capabilities with the teacher key and remembers which approved member has which chunks. No bytes flow through here.
import { randomUUID } from 'node:crypto';
import {
  b64u, bitfield, canonicalBytes, keyFingerprint,
  type CapabilityPayload, type EndorsementPayload, type PeerCapability, type PeerEndorsement,
} from '@classroom/protocol';
import type { Classroom } from './classroom.ts';
import type { ReceiptSigner } from './assignments.ts';
import { ApiError } from './storage.ts';

export const ENDORSEMENT_TTL_MS = 60 * 60_000;
export const CAPABILITY_TTL_MS = 15 * 60_000;

type Peer = {
  memberId: string; fingerprint: string; endorsement: PeerEndorsement; host: string; port: number;
  have: Map<string, Uint8Array>; uploaded: number; samples: { t: number; bytes: number }[]; lastSeen: number;
};
export type PeerSource = { fingerprint: string; url: string; endorsement: PeerEndorsement; have: string };

export class PeerRegistry {
  private classroom: Classroom; private signer: ReceiptSigner; private now: () => number;
  private peers = new Map<string, Peer>();

  constructor(classroom: Classroom, signer: ReceiptSigner, now = () => Date.now()) { this.classroom = classroom; this.signer = signer; this.now = now; }

  private sign<T extends object>(payload: T) {
    return { payload, alg: 'Ed25519' as const, signature: this.signer.sign(canonicalBytes(payload)), teacherPublicKey: this.signer.publicKey };
  }

  private approved(memberId: string) {
    const m = this.classroom.member(memberId);
    if (!m || m.status !== 'approved' || !m.deviceKey) throw new ApiError(403, 'forbidden', 'Not an active member of this class.');
    return m as typeof m & { deviceKey: string };
  }

  /** Register an approved member's peer server: binds its device key to its TLS identity (CA + leaf pin). */
  endorse(memberId: string, o: { tlsCa: string; tlsSpkiSha256: string; port: number }, host: string): PeerEndorsement {
    const m = this.approved(memberId);
    const t = this.now();
    const payload: EndorsementPayload = {
      type: 'classroom-lan/peer-endorsement', v: 1, sessionId: this.classroom.id, memberId, devicePublicKey: m.deviceKey,
      deviceKeyFingerprint: keyFingerprint(m.deviceKey), tlsCa: o.tlsCa, tlsSpkiSha256: o.tlsSpkiSha256,
      issuedAt: t, expiresAt: t + ENDORSEMENT_TTL_MS, teacherKeyFingerprint: keyFingerprint(this.signer.publicKey),
    };
    const endorsement = this.sign(payload);
    const prev = this.peers.get(memberId);
    this.peers.set(memberId, {
      memberId, fingerprint: payload.deviceKeyFingerprint, endorsement, host: host.replace(/^::ffff:/, ''), port: o.port,
      have: prev?.have ?? new Map(), uploaded: prev?.uploaded ?? 0, samples: prev?.samples ?? [], lastSeen: t,
    });
    return endorsement;
  }

  /** Short-lived read capability for one approved member, bound to its device key. */
  capability(memberId: string): PeerCapability {
    const m = this.approved(memberId);
    const t = this.now();
    const payload: CapabilityPayload = {
      type: 'classroom-lan/peer-capability', v: 1, capId: randomUUID(), sessionId: this.classroom.id, memberId,
      holderPublicKey: m.deviceKey, holderFingerprint: keyFingerprint(m.deviceKey), scope: 'resources:read',
      issuedAt: t, expiresAt: t + CAPABILITY_TTL_MS, teacherKeyFingerprint: keyFingerprint(this.signer.publicKey),
    };
    return this.sign(payload);
  }

  /** Scheduling hints only (never used for security). Bitfield length is checked against the chunk count. */
  have(memberId: string, resourceId: string, chunksB64: string, chunkCount: number) {
    this.approved(memberId);
    const p = this.peers.get(memberId);
    if (!p) return;
    const b = b64u.decode(chunksB64);
    if (b.length !== Math.ceil(chunkCount / 8)) throw new ApiError(400, 'invalid', 'Bad chunk bitfield.');
    p.have.set(resourceId, b);
    p.lastSeen = this.now();
  }

  stats(memberId: string, uploadedBytes: number) {
    const p = this.peers.get(memberId);
    if (!p || !(uploadedBytes >= p.uploaded)) return;
    p.samples.push({ t: this.now(), bytes: uploadedBytes - p.uploaded });
    p.samples = p.samples.filter((s) => this.now() - s.t < 10_000);
    p.uploaded = uploadedBytes;
    p.lastSeen = this.now();
  }

  /** Candidate peers for a resource (excluding the requester), with their unexpired endorsements. */
  sources(resourceId: string, requesterId: string): PeerSource[] {
    const t = this.now();
    const out: PeerSource[] = [];
    for (const p of this.peers.values()) {
      if (p.memberId === requesterId || p.endorsement.payload.expiresAt <= t || this.classroom.status(p.memberId) !== 'approved') continue;
      const have = p.have.get(resourceId);
      if (!have || !have.some((x) => x !== 0)) continue; // holds nothing yet: not a source
      out.push({ fingerprint: p.fingerprint, url: `https://${p.host}:${p.port}`, endorsement: p.endorsement, have: b64u.encode(have) });
    }
    return out;
  }

  /** Registered, approved peers other than `exceptMemberId` (a scheduling hint for slice sizing). */
  swarm(exceptMemberId: string) {
    const t = this.now();
    let n = 0;
    for (const p of this.peers.values()) if (p.memberId !== exceptMemberId && p.endorsement.payload.expiresAt > t && this.classroom.status(p.memberId) === 'approved') n++;
    return n;
  }

  /** Remove a member's peer role (removed/blocked). Returns its device fingerprint for the deny-list broadcast. */
  revoke(memberId: string): string | null {
    const m = this.classroom.member(memberId);
    this.peers.delete(memberId);
    return m?.deviceKey ? keyFingerprint(m.deviceKey) : null;
  }

  /** Up to `k` registered peers to seed a large resource early (most recently active first). */
  pickSeeders(k: number): string[] {
    return [...this.peers.values()].filter((p) => this.classroom.status(p.memberId) === 'approved')
      .sort((a, b) => b.lastSeen - a.lastSeen).slice(0, k).map((p) => p.memberId);
  }

  summary() {
    const t = this.now();
    let rate = 0, total = 0;
    for (const p of this.peers.values()) { total += p.uploaded; for (const s of p.samples) if (t - s.t < 5000) rate += s.bytes / 5; }
    return { peers: this.peers.size, peerUploadedBytes: total, peerBytesPerSec: rate };
  }

  /** How many registered peers hold at least one chunk of a resource (for the teacher's network panel). */
  holders(resourceId: string, chunkCount: number) {
    let n = 0;
    for (const p of this.peers.values()) { const h = p.have.get(resourceId); if (h && bitfield.count(h, chunkCount) > 0) n++; }
    return n;
  }
}

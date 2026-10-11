// Persistent CLAN hosting authority (docs/PHASE_14_2_HOSTING_DESIGN.md). Pure, portable vocabulary + verification:
// one stable CLAN id, one owner key, and a signed epoch chain naming exactly one host device per epoch. Possession of a
// record never grants anything by itself: each transition needs an owner-signed delegation to the destination key, the
// destination's acknowledgment of the exact checkpoint, and the previous host's signature (made only after it durably
// relinquished its epoch). Wall-clock expiry can only remove rights, never grant them.
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64u, canonicalBytes, ed25519Verify } from './trust.ts';

const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/); // raw Ed25519 public key, base64url
const Sig = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const Hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/); // SHA-256, base64url
const Id = z.string().uuid();
export const HOST_ACTIONS = ['host'] as const;

export const HostDelegationBody = z.object({
  type: z.literal('clan-host-delegation'), v: z.literal(1), id: Id, clanId: Id, ownerKey: Key, destKey: Key,
  actions: z.array(z.enum(HOST_ACTIONS)).min(1).max(4), issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
}).strict();
export const HostDelegation = HostDelegationBody.extend({ sig: Sig }).strict();
export type HostDelegation = z.infer<typeof HostDelegation>;

export const HostRevocationBody = z.object({
  type: z.literal('clan-host-revocation'), v: z.literal(1), clanId: Id, ownerKey: Key, delegationId: Id, revokedAt: z.number().int().nonnegative(),
}).strict();
export const HostRevocation = HostRevocationBody.extend({ sig: Sig }).strict();
export type HostRevocation = z.infer<typeof HostRevocation>;

/** Destination's signed statement: it has durably staged and verified exactly this checkpoint of epoch `epoch`. */
export const HostAckBody = z.object({
  type: z.literal('clan-host-ack'), v: z.literal(1), clanId: Id, epoch: z.number().int().nonnegative(), prevHash: Hash,
  checkpointHash: Hash, delegationId: Id, destKey: Key,
}).strict();
export const HostAck = HostAckBody.extend({ sig: Sig }).strict();
export type HostAck = z.infer<typeof HostAck>;

export const AuthorityRecordBody = z.object({
  type: z.literal('clan-host-authority'), v: z.literal(1), clanId: Id, ownerKey: Key, epoch: z.number().int().nonnegative(), hostKey: Key,
  prevHash: Hash.nullable(), checkpointHash: Hash.nullable(), delegation: HostDelegation.nullable(), ack: HostAck.nullable(),
  issuedAt: z.number().int().nonnegative(),
}).strict();
/** Epoch 0 is signed by the owner (who is its host); epoch N+1 by the host of epoch N. */
export const AuthorityRecord = AuthorityRecordBody.extend({ sig: Sig }).strict();
export type AuthorityRecord = z.infer<typeof AuthorityRecord>;
export const AuthorityChain = z.array(AuthorityRecord).min(1).max(1000);

/** Signs RFC 8785 canonical bytes; returns base64url. Implemented by the device key holder (never exported). */
export type HostSigner = { publicKey: string; sign(bytes: Uint8Array): string };
export const signHostStatement = <T extends object>(signer: HostSigner, body: T): T & { sig: string } => ({ ...body, sig: signer.sign(canonicalBytes(body)) });
const verifySigned = (key: string, v: { sig: string }) => { const { sig, ...body } = v; return ed25519Verify(key, body, sig); };
export const authorityHash = (r: AuthorityRecord) => b64u.encode(sha256(canonicalBytes(r)));

export type ChainCheck = { ok: true; head: AuthorityRecord; hashes: string[] } | { ok: false; reason: string };

/** Validity of a delegation for `destKey` at time `at` (signature, scope, expiry, revocation). */
export function delegationProblem(d: HostDelegation, o: { clanId: string; ownerKey: string; destKey: string; at: number; revoked: ReadonlySet<string> }): string | null {
  if (!HostDelegation.safeParse(d).success) return 'malformed delegation';
  if (d.clanId !== o.clanId) return 'delegation is for another CLAN';
  if (d.ownerKey !== o.ownerKey || !verifySigned(o.ownerKey, d)) return 'delegation is not signed by the CLAN owner';
  if (d.destKey !== o.destKey) return 'delegation names another device';
  if (!d.actions.includes('host')) return 'delegation does not allow hosting';
  if (o.revoked.has(d.id)) return 'delegation was revoked';
  if (!(d.expiresAt > o.at) || d.issuedAt > o.at + 120_000) return 'delegation expired';
  return null;
}

/** Only owner-signed revocations for this CLAN count. */
export function revokedDelegations(clanId: string, ownerKey: string, revocations: readonly HostRevocation[]): Set<string> {
  const out = new Set<string>();
  for (const r of revocations) if (HostRevocation.safeParse(r).success && r.clanId === clanId && r.ownerKey === ownerKey && verifySigned(ownerKey, r)) out.add(r.delegationId);
  return out;
}

/**
 * Verifies a complete chain from epoch 0. Revocations never rewrite history (devices cannot order them against
 * transitions by clock): the relinquishing host and the destination refuse revoked delegations before signing, and a
 * revoked head is reported by `hostAuthorized` so it stops serving writes.
 */
export function verifyAuthorityChain(chain: unknown, o: { clanId: string; ownerKey?: string }): ChainCheck {
  const p = AuthorityChain.safeParse(chain);
  if (!p.success) return { ok: false, reason: 'malformed authority chain' };
  const rs = p.data, g = rs[0]!;
  if (g.clanId !== o.clanId) return { ok: false, reason: 'authority is for another CLAN' };
  if (o.ownerKey && g.ownerKey !== o.ownerKey) return { ok: false, reason: 'authority names another owner' };
  if (g.epoch !== 0 || g.prevHash !== null || g.hostKey !== g.ownerKey || g.delegation || g.ack || g.checkpointHash !== null || !verifySigned(g.ownerKey, g)) return { ok: false, reason: 'invalid genesis record' };
  const none = new Set<string>();
  const hashes = [authorityHash(g)];
  for (let i = 1; i < rs.length; i++) {
    const prev = rs[i - 1]!, r = rs[i]!;
    if (r.clanId !== g.clanId || r.ownerKey !== g.ownerKey) return { ok: false, reason: 'authority changed CLAN or owner' };
    if (r.epoch !== prev.epoch + 1 || r.prevHash !== hashes[i - 1]) return { ok: false, reason: `broken chain at epoch ${r.epoch}` };
    if (!r.delegation || !r.ack || !r.checkpointHash) return { ok: false, reason: 'transition lacks delegation or acknowledgment' };
    // Owner consent is the destination's delegation; the previous host's signature proves it relinquished its epoch.
    const problem = delegationProblem(r.delegation, { clanId: g.clanId, ownerKey: g.ownerKey, destKey: r.hostKey, at: r.issuedAt, revoked: none });
    if (problem) return { ok: false, reason: problem };
    const a = r.ack;
    if (a.clanId !== g.clanId || a.epoch !== prev.epoch || a.prevHash !== hashes[i - 1] || a.checkpointHash !== r.checkpointHash || a.delegationId !== r.delegation.id || a.destKey !== r.hostKey || !verifySigned(r.hostKey, a)) return { ok: false, reason: 'destination acknowledgment does not match' };
    if (!verifySigned(prev.hostKey, r)) return { ok: false, reason: 'transition is not signed by the previous host' };
    hashes.push(authorityHash(r));
  }
  return { ok: true, head: rs[rs.length - 1]!, hashes };
}

/** Whether the head's host may still serve writes now (owner-hosted genesis never expires). */
export function hostAuthorized(head: AuthorityRecord, at: number, revoked: ReadonlySet<string>): boolean {
  if (!head.delegation) return head.epoch === 0 && head.hostKey === head.ownerKey;
  if (head.hostKey === head.ownerKey) return !revoked.has(head.delegation.id);
  return !revoked.has(head.delegation.id) && head.delegation.expiresAt > at;
}

// Persistent CLAN hosting from the owner's phone (docs/PHASE_14_2_HOSTING_DESIGN.md). Phones do not host CLANs: there is
// no supported embedded runtime (Android/iOS), so a phone-owned CLAN is hosted by one of the owner's linked computers.
// The phone signs ownership with its keystore-held device key, pushes the CLAN to the chosen computer over the native
// pinned transport (resumable), asks the current host to move it, and revokes a computer's permission. It never claims
// to be available while offline.
import { randomUUID } from 'expo-crypto';
import { File, FileMode } from 'expo-file-system';
import { pushClan } from '@classroom/client';
import type { ClanType } from '@classroom/protocol';
import { phoneClan } from '../core/clan';
import { callComputer, hostingSigner } from './phone';

export const PHONE_HOSTING_BLOCKED = 'Phones cannot host CLANs yet: no supported, audited runtime exists for Android or iOS. One of your computers hosts your CLAN while it is on.';

export function linkedComputers() {
  return phoneClan().sync.devices().filter((d) => !d.current && !d.revoked && d.tlsSpki !== 'none').map((d) => ({ fp: d.fp, name: d.name, publicKey: d.publicKey }));
}
const read = (clanId: string) => async (sha: string, offset: number, length: number) => {
  const path = phoneClan().hosting.checkpointBlob(clanId, sha);
  if (!path) throw new Error('The prepared hand-over is no longer available; start it again.');
  const h = new File(path).open(FileMode.ReadOnly);
  try { h.offset = offset; return h.readBytes(length); } finally { h.close(); }
};

/** Hand a CLAN this phone currently holds to one of the owner's linked computers. Safe to call again to resume. */
export async function handToComputer(clanId: string, computerFp: string, acknowledge: string[] = [], onProgress?: (done: number, total: number) => void) {
  const c = phoneClan(), s = await hostingSigner(), dest = linkedComputers().find((d) => d.fp === computerFp);
  if (!dest) throw new Error('Choose one of your linked computers.');
  const signed = c.hosting.pendingTransition(clanId);
  let delegation = signed?.delegation ?? c.hosting.pendingRequest(clanId);
  if (!delegation || delegation.destKey !== dest.publicKey) delegation = c.hosting.requestHandover(c.hosting.delegate(clanId, s, dest.publicKey, { id: randomUUID(), ttlMs: 7 * 86_400_000 }));
  if (!signed) {
    c.hosting.freeze(clanId, s.publicKey);
    await c.hosting.prepareCheckpoint(clanId, s.publicKey, { acknowledge });
  }
  const clan = c.clans.get(clanId)!;
  return pushClan({ call: (path, body) => callComputer(dest.fp, path, body), read: read(clanId), source: c.hosting, clanId, delegation, signer: s,
    clan: { type: clan.type, name: clan.name, expiresAt: clan.expiresAt }, chunkBytes: 2 * 1024 * 1024, onProgress });
}

/** Offline ownership record; this is not a phone-hosted network session. */
export async function createOwnedClan(o: { type: ClanType; name: string; expiresAt?: number }) {
  const c = phoneClan(), s = await hostingSigner();
  const clan = c.clans.create({ type: o.type, name: o.name, createdBy: c.me, expiresAt: o.expiresAt });
  c.hosting.establish(clan.id, c.me, s);
  return clan;
}

/** A new CLAN owned by this phone and hosted by the chosen computer from the start. */
export async function createHostedClan(o: { type: ClanType; name: string; expiresAt?: number; computerFp: string }, onProgress?: (done: number, total: number) => void) {
  const clan = await createOwnedClan(o);
  await handToComputer(clan.id, o.computerFp, [], onProgress);
  return clan;
}

/** Owner: ask the computer that hosts the CLAN now to move it to another linked computer (it confirms and pauses). */
export async function requestMove(clanId: string, toFp: string) {
  const c = phoneClan(), s = await hostingSigner(), dest = linkedComputers().find((d) => d.fp === toFp);
  if (!dest) throw new Error('Choose one of your linked computers.');
  const host = linkedComputers().find((d) => d.publicKey === c.hosting.chainOf(clanId)?.at(-1)?.hostKey);
  if (!host) throw new Error('The computer hosting this CLAN is not linked to this phone.');
  return callComputer(host.fp, '/host/push/request', c.hosting.delegate(clanId, s, dest.publicKey, { id: randomUUID(), ttlMs: 7 * 86_400_000 }));
}

/** Owner: withdraw the hosting permission of the computer that hosts the CLAN now. It stops accepting changes. */
export async function revokeHost(clanId: string) {
  const c = phoneClan(), s = await hostingSigner(), head = c.hosting.chainOf(clanId)?.at(-1);
  if (!head?.delegation) throw new Error('This CLAN has no delegated host to stop.');
  const rev = c.hosting.revoke(clanId, s, head.delegation.id);
  const failed: string[] = [];
  for (const d of linkedComputers()) await callComputer(d.fp, '/host/push/revoke', rev).catch(() => failed.push(d.name));
  return { notReached: failed };
}

export async function hostingOverview(clanId: string) {
  const c = phoneClan(), s = await hostingSigner();
  const st = await c.hosting.handoverStatus(clanId, s.publicKey);
  const name = (k: string) => k === s.publicKey ? 'This phone' : linkedComputers().find((d) => d.publicKey === k)?.name ?? 'Another device';
  return { ...st, me: s.publicKey, hostName: st.hosting ? name(st.hosting.hostKey) : null, isOwner: st.hosting?.ownerKey === s.publicKey, preflight: st.hosting?.hostKey === s.publicKey ? c.hosting.preflight(clanId) : [] };
}

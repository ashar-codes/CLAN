// Persistent CLAN hosting hand-over pushed by the current host to its destination (the owner's phone accepts no
// connections, so it pushes to its linked computer). Portable: the caller supplies the pinned, device-signed JSON call
// (desktop: node https; phone: the native pinned transport) and a reader for the checkpoint's blobs. Resumable at any
// point: the destination reports what it already holds, and a transition already signed is only re-delivered.
import { b64u } from '@classroom/protocol';

export type PushSource = {
  checkpointOf(clanId: string): { header: { files: { sha256: string; size: number }[] } & Record<string, unknown>; hash: string } | null;
  chainOf(clanId: string): unknown[] | null;
  pendingTransition(clanId: string): unknown | null;
  relinquish(clanId: string, signer: { publicKey: string; sign(bytes: Uint8Array): string }, delegation: never, ack: never): unknown;
};
type Missing = { sha256: string; size: number; have: number };

export async function pushClan(o: {
  call(path: string, body: unknown): Promise<unknown>;
  read(sha256: string, offset: number, length: number): Promise<Uint8Array>;
  source: PushSource; clanId: string; delegation: unknown; signer: { publicKey: string; sign(bytes: Uint8Array): string };
  clan: { type: string; name: string; expiresAt: number | null }; chunkBytes?: number; onProgress?(done: number, total: number): void;
}): Promise<{ epoch: number; writable: boolean }> {
  const chain = o.source.chainOf(o.clanId);
  if (!chain) throw new Error('This CLAN has no hosting authority on this device.');
  const signed = o.source.pendingTransition(o.clanId);
  if (signed) return o.call('/host/push/activate', { clanId: o.clanId, chain: [...chain, signed] }) as Promise<{ epoch: number; writable: boolean }>;
  const cp = o.source.checkpointOf(o.clanId);
  if (!cp) throw new Error('Pause hosting and prepare the hand-over first.');
  const begun = await o.call('/host/push/begin', { chain, delegation: o.delegation, header: cp.header, clan: o.clan }) as { missing: Missing[] };
  const chunk = Math.min(o.chunkBytes ?? 4 * 1024 * 1024, 8 * 1024 * 1024);
  const total = begun.missing.reduce((n, m) => n + m.size - m.have, 0); let done = 0;
  for (const m of begun.missing) {
    let at = m.have;
    while (at < m.size) {
      const bytes = await o.read(m.sha256, at, Math.min(chunk, m.size - at));
      if (!bytes.length) throw new Error('A checkpoint file ended early on this device.');
      const r = await o.call('/host/push/blob', { clanId: o.clanId, sha256: m.sha256, offset: at, data: b64u.encode(bytes) }) as { have: number };
      if (r.have === at) throw new Error('The destination did not accept the data.');
      done += Math.max(0, r.have - at); at = r.have; // a lower value: the destination lost a partial file; resend from there
      o.onProgress?.(done, total);
    }
  }
  const { ack } = await o.call('/host/push/complete', { clanId: o.clanId }) as { ack: never };
  const record = o.source.relinquish(o.clanId, o.signer, o.delegation as never, ack); // durable before it is sent
  return o.call('/host/push/activate', { clanId: o.clanId, chain: [...chain, record] }) as Promise<{ epoch: number; writable: boolean }>;
}

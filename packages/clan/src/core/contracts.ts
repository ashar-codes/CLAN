// Boundaries for core services that are not implemented in this phase. Implementations plug in at the composition root.
import type { Principal } from './permissions.ts';

/** Networking: how a device finds and reaches others (LAN classroom transport today; Direct/mesh later). */
export interface Networking {
  discover(onPeers: (peers: { id: string; title: string; addresses: string[] }[]) => void): () => void;
}

/** Sync: exchanging module change sets between a user's devices or CLAN members. Not implemented; no module may assume it. */
export interface SyncAdapter {
  push(scope: { clanId: string }, changes: { module: string; entityId: string; op: 'upsert' | 'delete'; version: number }[]): Promise<void>;
  pull(scope: { clanId: string }, since: number): Promise<{ module: string; entityId: string; op: 'upsert' | 'delete'; version: number }[]>;
}

/** Notifications: in-app/OS notices. Producers publish events; a notifications consumer decides what to show. */
export type Notice = { id: string; userId: string; title: string; body: string; ref?: { module: string; entityId: string }; createdAt: number };
export interface Notifications {
  list(p: Principal, opts?: { unreadOnly?: boolean }): Notice[];
  markRead(p: Principal, id: string): void;
}

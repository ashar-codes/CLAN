// The boundaries higher-level features use, independent of which network mode carries the data (Milestone 2.75).
// Each one exists because a concrete current or scheduled implementation needs it — see docs/TRANSPORT_MODES.md.
import type { ResourceView, SignedManifest, ServerMessage, ClientMessage, PeerEndorsement } from '@classroom/protocol';
import type { Quality } from './index.ts';

/** "I need resource X": teacher-direct or peer-assisted underneath. Implemented by PeerAgent (desktop/Node). */
export interface ResourceTransport {
  acquire(resource: Pick<ResourceView, 'id' | 'name' | 'size' | 'sha256'>, opts: { peerAssist: boolean; signal?: AbortSignal }): Promise<{ path: string; manifest?: SignedManifest }>;
}

/** Teacher-authoritative control/events. Implemented by ClassroomConnection over pinned WSS. Future peer relay must
 *  forward teacher-SIGNED commands only — no gossip of authoritative state. */
export interface EventTransport {
  send(m: ClientMessage): void;
  close(): void;
}
export type EventHandler = (m: ServerMessage) => void;

/** Where peers are. Implemented by the teacher's tracker (/api/peer/sources) + last-known cache. Results are hints;
 *  identity comes only from the teacher-signed endorsement and the pinned TLS key. */
export interface PeerDiscovery {
  peersFor(resourceId: string): Promise<{ fingerprint: string; url: string; endorsement: PeerEndorsement; have: string }[]>;
}

/** Placeholder for Milestone 4 (screen sharing). Topology is the transport's business: local SFU on the teacher,
 *  an elected relay peer, or several relays. Publishing rights still come from the teacher (control plane). */
export interface MediaTransport {
  readonly topology: 'teacher-sfu' | 'relay-peer' | 'multi-relay';
  publish(track: unknown, opts: { maxBitrate?: number }): Promise<{ stop(): void }>;
  subscribe(publisherId: string): Promise<{ stop(): void }>;
}

/** What students see ("Excellent/Good/Poor/Disconnected") and what scheduling may use. */
export interface ConnectionHealth {
  quality(): Quality;
  rttMs(): number | null;
}

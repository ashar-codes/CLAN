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

/** Screen-share quality profiles: classroom content favours sharpness (text, slides, code) over motion. */
export type ScreenProfile = 'auto' | 'text' | 'motion';
export const SCREEN_PROFILES: Record<ScreenProfile, { maxWidth: number; maxHeight: number; fps: number; maxBitrate: number; contentHint: 'detail' | 'motion'; keepResolution: boolean }> = {
  text: { maxWidth: 1920, maxHeight: 1080, fps: 8, maxBitrate: 2_500_000, contentHint: 'detail', keepResolution: true },
  motion: { maxWidth: 1280, maxHeight: 720, fps: 30, maxBitrate: 3_000_000, contentHint: 'motion', keepResolution: false },
  auto: { maxWidth: 1920, maxHeight: 1080, fps: 15, maxBitrate: 3_000_000, contentHint: 'detail', keepResolution: true },
};
export type MediaQuality = 'good' | 'fair' | 'poor' | 'unknown';
export type MediaDiagnostics = { transport: string; codec: string | null; width: number | null; height: number | null; fps: number | null; bitrateKbps: number | null; packetsLost: number | null; rttMs: number | null; layer: string | null };
/** A received screen, attachable to the room wall. */
export type ScreenView = { attach(el: HTMLMediaElement): void; detach(el: HTMLMediaElement): void; hasAudio: boolean };

/**
 * Real-time media for a CLAN (screen sharing now; voice/whiteboard later). Implementations own the topology — today a
 * host-local SFU. Product code depends only on this interface; publishing rights come from the host (control plane).
 */
export interface MediaTransport {
  readonly topology: 'host-sfu';
  connect(o: { url: string; token: string }): Promise<void>;
  publishScreen(stream: MediaStream, profile: ScreenProfile): Promise<void>;
  replaceScreen(stream: MediaStream): Promise<void>;
  unpublishScreen(): Promise<void>;
  onScreen(cb: (view: ScreenView | null, presenterIdentity: string | null) => void): () => void;
  onState(cb: (s: 'connected' | 'reconnecting' | 'disconnected') => void): () => void;
  quality(): MediaQuality;
  diagnostics(): Promise<MediaDiagnostics>;
  disconnect(): Promise<void>;
}

/** What students see ("Excellent/Good/Poor/Disconnected") and what scheduling may use. */
export interface ConnectionHealth {
  quality(): Quality;
  rttMs(): number | null;
}

// The two native capabilities mobile pairing needs:
// 1. OPAQUE client: the official @serenity-kit/opaque 1.1.0 WASM build (the same library and version as the teacher)
//    running in an isolated WebView — see OpaqueBridgeHost.tsx and packages/client/src/opaque-bridge.ts.
// 2. Pinned TLS transport: native module (modules/pinned-transport) trusting only the per-class CA + leaf SPKI pin.
import type { OpaqueClient, Transport } from '@classroom/client';
import type { TlsBinding } from '@classroom/protocol';
import { pinnedNativeTransport as nativeTransport } from '../modules/pinned-transport';
import { opaqueBridgeClient } from './OpaqueBridgeHost';

/** Pinned transport plus the file operations Expo's own networking would otherwise do (and can't pin). */
export type PinnedNativeTransport = Transport & {
  /** GET with Range from `offset`, appending to `fileUri`; resolves with total bytes on disk. */
  downloadToFile(url: string, headers: Record<string, string>, fileUri: string, offset: number, onProgress: (bytes: number) => void, signal?: AbortSignal): Promise<number>;
  /** PUT the bytes of `fileUri` starting at `offset`; resolves with status + body text. */
  uploadFromFile(url: string, headers: Record<string, string>, fileUri: string, offset: number, onProgress: (sent: number) => void): Promise<{ status: number; body: string }>;
};

export const opaqueClient = (): OpaqueClient => opaqueBridgeClient();
export const pinnedNativeTransport = (b: Pick<TlsBinding, 'certificate' | 'spkiSha256'>): PinnedNativeTransport => nativeTransport(b);

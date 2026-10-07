// The two native capabilities mobile pairing needs. Both are explicit seams that are NOT available in this build:
//
// 1. OPAQUE client. `react-native-opaque` (last release 0.3.1, Oct 2023) wraps @serenity-kit/opaque 0.8, which we
//    verified is wire-incompatible with the 1.1 server (login fails in both directions). We will not substitute
//    home-made PAKE code. Options: an updated RN binding of opaque-ke matching @serenity-kit/opaque 1.x, or running
//    the official WASM build inside a hidden WebView. See docs/PAIRING_AND_TRUST.md.
// 2. Pinned TLS transport. Expo's fetch/WebSocket/file-system networking can't trust only the per-session CA from the
//    PAKE-authenticated binding. This needs a small native module (iOS URLSession trust evaluation with the session
//    CA as the only anchor + SPKI pin; Android OkHttp with a custom X509TrustManager doing the same) exposing
//    fetch, WebSocket, ranged download-to-file and offset upload-from-file. Never "trust all certificates".
import type { OpaqueClient, Transport } from '@classroom/client';
import { TransferError } from '@classroom/client';
import type { TlsBinding } from '@classroom/protocol';

export const MOBILE_PAIRING_UNAVAILABLE =
  'Joining from a phone is not available in this build yet: the secure pairing library for phones is not compatible with the teacher app. Join from a laptop for now.';

/** Pinned transport plus the file operations Expo's own networking would otherwise do (and can't pin). */
export type PinnedNativeTransport = Transport & {
  /** GET with Range from `offset`, appending to `fileUri`; resolves with total bytes on disk. */
  downloadToFile(url: string, headers: Record<string, string>, fileUri: string, offset: number, onProgress: (bytes: number) => void, signal?: AbortSignal): Promise<number>;
  /** PUT the bytes of `fileUri` starting at `offset`; resolves with status + body text. */
  uploadFromFile(url: string, headers: Record<string, string>, fileUri: string, offset: number, onProgress: (sent: number) => void): Promise<{ status: number; body: string }>;
};

export function opaqueClient(): OpaqueClient {
  throw new TransferError('unsupported', MOBILE_PAIRING_UNAVAILABLE);
}

export function pinnedNativeTransport(_binding: Pick<TlsBinding, 'certificate' | 'spkiSha256'>): PinnedNativeTransport {
  throw new TransferError('unsupported', MOBILE_PAIRING_UNAVAILABLE);
}

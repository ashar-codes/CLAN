// Share-to-CLAN intake: what another app shared, already copied into this app's sandbox (Android: SEND intents;
// iOS: the Share Extension's hand-off through the app group). Untrusted: the intake screen validates again.
import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

import type { Shared } from '../../src/share/items';
export type { Shared };
type NativeApi = { take(id?: string): Promise<Shared | null>; discard(uris: string[]): void; addListener(e: 'share', cb: () => void): { remove(): void } };
const Native = requireOptionalNativeModule<NativeApi>('ShareIntake');

/** The pending share, if any (Android: the launching/new intent; iOS: the hand-off `id` from clan://share?id=…). */
export async function takeShare(id?: string): Promise<Shared | null> {
  if (!Native) return null;
  if (Platform.OS === 'ios' && id && !/^[0-9A-F-]{36}$/i.test(id)) return null;
  return Native.take(id);
}
export const discardShared = (uris: string[]) => Native?.discard(uris);
/** Android: a share while running. iOS: the extension saved something; check whenever CLAN comes to the foreground. */
export const onShare = (cb: () => void) => {
  const s = Native?.addListener('share', cb);
  const a = Platform.OS === 'ios' ? AppState.addEventListener('change', (st) => { if (st === 'active') cb(); }) : null;
  return () => { s?.remove(); a?.remove(); };
};

import { requireOptionalNativeModule } from 'expo-modules-core';
// Native wake-up verification/presentation (Android: FCM service; iOS: PushKit + CallKit). See push.ts in src/people.
export type ClanPushNative = {
  configured(): boolean;
  /** FCM token (Android) or VoIP token (iOS); null when this build has no push configuration. */
  token(): Promise<string | null>;
  setKeys(json: string): void; setPreviews(on: boolean): void;
  firstTime(key: string): boolean;
  /** Taps/answers/declines since last asked: JSON [{k, id, c?, convId?, action}]. */
  takeEvents(): string;
  cancelCall(id: string): void;
  handle(raw: string): string;
  /** iOS: APNs topic. */
  bundleId?(): string | null;
};
export const ClanPush = requireOptionalNativeModule<ClanPushNative>('ClanPush');

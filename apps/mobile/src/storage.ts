// Profile + device identity. The Ed25519 private key (32-byte seed) lives ONLY in expo-secure-store
// (iOS Keychain / Android Keystore-backed). The profile (names + public key) is not secret.
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64u, keyFingerprint, type StudentProfile } from '@classroom/protocol';
import type { DeviceSigner } from '@classroom/client';

const PROFILE = 'classroom.profile.v1';
const DEVICE_SEED = 'classroom.device.ed25519.v1';

export type OwnProfile = Partial<Pick<StudentProfile, 'fullName' | 'rollNo' | 'deviceName'>> & { devicePublicKey: string; fingerprint: string };

/** Ed25519 signer backed by the secure-store seed (created on first use). */
export async function deviceSigner(): Promise<DeviceSigner> {
  let seedB64 = await SecureStore.getItemAsync(DEVICE_SEED, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (!seedB64) {
    seedB64 = b64u.encode(getRandomBytes(32));
    await SecureStore.setItemAsync(DEVICE_SEED, seedB64, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  const seed = b64u.decode(seedB64);
  return { publicKey: b64u.encode(ed25519.getPublicKey(seed)), sign: (bytes) => b64u.encode(ed25519.sign(bytes, seed)) };
}

export async function loadProfile(): Promise<OwnProfile> {
  const devicePublicKey = (await deviceSigner()).publicKey;
  let p: Partial<StudentProfile> = {};
  try { p = JSON.parse((await SecureStore.getItemAsync(PROFILE)) ?? '{}'); } catch {}
  // A pre-2.5 profile's random deviceId is ignored; identity is the key above.
  return { fullName: p.fullName, rollNo: p.rollNo, deviceName: p.deviceName, devicePublicKey, fingerprint: keyFingerprint(devicePublicKey) };
}

export async function saveProfile(p: Pick<StudentProfile, 'fullName' | 'rollNo' | 'deviceName'>) {
  await SecureStore.setItemAsync(PROFILE, JSON.stringify({ fullName: p.fullName, rollNo: p.rollNo, deviceName: p.deviceName }));
}

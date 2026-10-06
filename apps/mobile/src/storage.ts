// Profile + device identity in OS secure storage (Keychain / Android Keystore-backed).
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import type { StudentProfile } from '@classroom/protocol';

const KEY = 'classroom.profile.v1';

export async function loadProfile(): Promise<Partial<StudentProfile> & { deviceId: string }> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (raw) {
    const p = JSON.parse(raw);
    if (typeof p.deviceId === 'string') return p;
  }
  const fresh = { deviceId: randomUUID() };
  await SecureStore.setItemAsync(KEY, JSON.stringify(fresh));
  return fresh;
}

export async function saveProfile(p: StudentProfile) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(p));
}

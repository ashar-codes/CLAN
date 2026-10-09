// CLAN core on the phone: the same @clan/core modules as the desktop (Notes, Saved, Diary, Capture, Courses, Tasks,
// Exams, Reminders, Flashcards, Study, Files, PersonalSync…) over an SQLCipher database whose key lives only in the
// Keychain / Android Keystore (expo-secure-store). Opened once per app process.
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { Directory, Paths } from 'expo-file-system';
import { openClan, type ClanApp } from '@clan/core';
import { b64u } from '@classroom/protocol';
import { openPhoneDb } from './sqlite';

const DB_KEY = 'clan.db.key.v1';
let app: ClanApp | null = null;
let opening: Promise<ClanApp> | null = null;

async function dbKey() {
  const o = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
  let k = await SecureStore.getItemAsync(DB_KEY, o);
  if (!k) { k = b64u.encode(getRandomBytes(32)); await SecureStore.setItemAsync(DB_KEY, k, o); }
  return k;
}

/** The phone's CLAN (created on first use). `name` is the student's display name for a brand-new profile. */
export function openPhoneClan(name?: string): Promise<ClanApp> {
  if (app) return Promise.resolve(app);
  return (opening ??= (async () => {
    const storage = new Directory(Paths.document, 'CLAN', 'storage');
    if (!storage.exists) storage.create({ intermediates: true, idempotent: true });
    const db = openPhoneDb('clan.db', await dbKey());
    app = openClan(db as never, { storageDir: storage.uri.replace(/\/$/, ''), localName: name });
    return app;
  })());
}
export const phoneClan = () => { if (!app) throw new Error('CLAN is not open yet.'); return app; };
export const me = () => ({ kind: 'user' as const, userId: phoneClan().me });

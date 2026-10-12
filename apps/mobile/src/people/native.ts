// The phone's people runtime on the real native pieces: first contact and certificate-pinned TLS from the
// pinned-transport module, files through expo-file-system, the device identity key from the Keystore/Keychain.
// Phones also speak clan-link/1 directly to other phones (src/people/nearby.ts): the same People store and outbox,
// whichever path reaches the person. Background behaviour follows the Nearby availability setting.
import { AppState, Platform } from 'react-native';
import { getRandomBytes } from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { b64u } from '@classroom/protocol';
import { PeopleChanged } from '@clan/core';
import { firstContactRequest, pinnedNativeTransport } from '../../modules/pinned-transport';
import { deviceSigner } from '../storage';
import { phoneClan } from '../core/clan';
import { bump } from '../ui/kit';
import { startPhonePeople, type PhoneEnv, type PhonePeople } from './runtime';
import { PeerLink } from '../../modules/peer-link';
import { initializePeopleNotifications } from './notifications';
import { nearby } from './nearby';
import type { PeerEnvelope } from '@classroom/protocol';

/** Live call signals from any path go to the call screen (set by it). */
const liveSubs = new Set<(e: PeerEnvelope) => void>();
export const onPeopleLive = (cb: (e: PeerEnvelope) => void) => { liveSubs.add(cb); return () => { liveSubs.delete(cb); }; };
const live = (e: PeerEnvelope) => { for (const f of liveSubs) f(e); };

const dir = () => { const d = new Directory(Paths.document, 'people', 'incoming'); if (!d.exists) d.create({ intermediates: true, idempotent: true }); return d; };

const env: PhoneEnv = {
  firstContact: firstContactRequest,
  transport: (tls) => {
    const t = pinnedNativeTransport(tls);
    return {
      fetch: (url, init) => t.fetch(url, init),
      openWebSocket: (url) => t.openWebSocket(url),
      downloadToFile: (url, headers, fileUri, offset, onProgress) => t.downloadToFile(url, headers, fileUri, offset, onProgress),
      uploadFromFile: (url, headers, fileUri, offset, onProgress) => t.uploadFromFile(url, headers, fileUri, offset, onProgress),
    };
  },
  files: {
    size: async (uri) => { const f = new File(uri); return f.exists ? f.size ?? 0 : 0; },
    async slice(uri, offset, len) {
      const h = new File(uri).open(FileMode.ReadOnly);
      let bytes: Uint8Array;
      try { h.offset = offset; bytes = h.readBytes(len); } finally { h.close(); }
      const out = new File(Paths.cache, `people-chunk-${b64u.encode(getRandomBytes(6))}`);
      out.create({ overwrite: true }); out.write(bytes);
      return { uri: out.uri, bytes };
    },
    remove: async (uri) => { const f = new File(uri); if (f.exists) f.delete(); },
    incoming: (id) => new File(dir(), `${id}.part`).uri,
  },
  nonce: () => b64u.encode(getRandomBytes(18)),
};

let devicesTimer: ReturnType<typeof setInterval> | null = null;
if (Platform.OS === 'android') PeerLink?.addListener('availabilityTick', (e) => {
  if (!nearby.keepInBackground()) return;
  if (e.networkChanged) rt?.reconnect();
  void rt?.tick(); void nearby.cm?.tick(); nearby.advertise();
});
let rt: PhonePeople | null = null, starting: Promise<PhonePeople> | null = null, wanted = false;
// iOS/default Android suspend on background; explicit Android availability retains authenticated networking.
PeerLink?.addListener('availability', (e) => { if (!e.running && e.byUser && AppState.currentState !== 'active') { rt?.stop(); rt = null; if (devicesTimer) clearInterval(devicesTimer); devicesTimer = null; } });
AppState.addEventListener('change', (st) => {
  if (st !== 'active' && !nearby.keepInBackground()) { rt?.stop(); rt = null; if (devicesTimer) clearInterval(devicesTimer); devicesTimer = null; } // the computer path; direct links follow the Nearby setting (nearby.ts)
  else if (wanted) void phonePeople().catch(() => {});
});
/** Starts people networking for this app session (idempotent). */
export function phonePeople(): Promise<PhonePeople> {
  wanted = true;
  if (rt) return Promise.resolve(rt);
  return starting ??= (async () => {
    initializePeopleNotifications();
    await nearby.ensureNotificationConsent();
    const s = await deviceSigner();
    const signer = { publicKey: s.publicKey, sign: (b: Uint8Array) => s.sign(b) as string };
    if (!subscribed) { subscribed = true; phoneClan().bus.subscribe('mobile.people', PeopleChanged, () => bump()); }
    const links = nearby.manager(signer);
    nearby.onLive(live);
    const devices = () => { try { const acc = phoneClan().sync.account(); if (!acc) return; const p = phoneClan().people; p.announceDevice(acc.accountId, `${p.myProfile().name}’s phone`); if (p.shareDeviceLinks()) void rt?.tick(); } catch { /* not linked yet */ } };
    if (devicesTimer) clearInterval(devicesTimer); devicesTimer = setInterval(devices, 60_000);
    rt = startPhonePeople({ people: phoneClan().people, signer, env, links, onLive: live, onChange: () => bump() });
    if (AppState.currentState !== 'active' && !nearby.keepInBackground()) { rt.stop(); rt = null; throw new Error('People networking resumes when CLAN is open.'); }
    void nearby.start();
    devices();
    return rt;
  })().finally(() => { starting = null; });
}
let subscribed = false;

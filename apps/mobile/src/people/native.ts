// The phone's people runtime on the real native pieces: first contact and certificate-pinned TLS from the
// pinned-transport module, files through expo-file-system, the device identity key from the Keystore/Keychain.
// Runs only while the app is in the foreground (no background discovery or connections).
import { AppState } from 'react-native';
import { getRandomBytes } from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { b64u } from '@classroom/protocol';
import { PeopleChanged } from '@clan/core';
import { firstContactRequest, pinnedNativeTransport } from '../../modules/pinned-transport';
import { deviceSigner } from '../storage';
import { phoneClan } from '../core/clan';
import { bump } from '../ui/kit';
import { startPhonePeople, type PhoneEnv, type PhonePeople } from './runtime';

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

let rt: PhonePeople | null = null, starting: Promise<PhonePeople> | null = null, wanted = false;
// Stopped whenever the app leaves the foreground; started again when it returns (if people were in use).
AppState.addEventListener('change', (st) => {
  if (st !== 'active') { rt?.stop(); rt = null; }
  else if (wanted) void phonePeople().catch(() => {});
});
/** Starts people networking for this app session (idempotent). */
export function phonePeople(): Promise<PhonePeople> {
  wanted = true;
  if (rt) return Promise.resolve(rt);
  return starting ??= (async () => {
    const s = await deviceSigner();
    const signer = { publicKey: s.publicKey, sign: (b: Uint8Array) => s.sign(b) as string };
    if (!subscribed) { subscribed = true; phoneClan().bus.subscribe('mobile.people', PeopleChanged, () => bump()); }
    rt = startPhonePeople({ people: phoneClan().people, signer, env, onChange: () => bump() });
    return rt;
  })().finally(() => { starting = null; });
}
let subscribed = false;

import { File, Directory, Paths } from 'expo-file-system';
import { getRandomBytes } from 'expo-crypto';
import { b64u, directoryConfig, type DirectoryConfig, type DirectoryAdvert } from '@classroom/protocol';
import { LanDirectoryAgent, lanDirectoryClient, type PeerKeySigner } from '@classroom/client';
import { pinnedNativeTransport } from '../../modules/pinned-transport';
import { bump } from '../ui/kit';
const file = () => { const d = new Directory(Paths.document, 'people'); if (!d.exists) d.create({ intermediates: true, idempotent: true }); return new File(d, 'lan-directory.json'); };
export function directorySettings(): DirectoryConfig | null { try { const f = file(); return f.exists ? directoryConfig(JSON.parse(f.textSync())) : null; } catch { return null; } }
export let directoryStatus = 'LAN directory disabled.';
let agent: LanDirectoryAgent | null = null, signer: PeerKeySigner | null = null, adverts: DirectoryAdvert[] = [], until = 0;
const listeners = new Set<() => void>();
export const directoryClans = () => Date.now() < until ? adverts.filter((a) => a.kind === 'clan' && a.clan).map((a) => ({ ...a.clan!, url: `http://${a.endpoints[0]}`, alt: a.endpoints.slice(1).map((e) => `http://${e}`), discoverySource: 'directory' as const })) : [];
export const onDirectoryClans = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export function initializeDirectory(s: PeerKeySigner, own: () => DirectoryAdvert[], receive: (a: DirectoryAdvert[], expires: number) => void) {
  signer = s; agent = new LanDirectoryAgent(own, (list, expires) => { adverts = list; until = expires; receive(list, expires); for (const f of listeners) f(); }, (message) => { directoryStatus = message; bump(); });
  try { configure(directorySettings(), false); } catch { directoryStatus = 'Saved LAN directory certificate is invalid. Direct connections still work; check the administrator configuration.'; }
}
function configure(config: DirectoryConfig | null, refresh = true) { agent?.configure(config && signer ? lanDirectoryClient({ config, signer, fetch: pinnedNativeTransport(config).fetch, nonce: () => b64u.encode(getRandomBytes(18)) }) : null); directoryStatus = config ? 'Connecting to enrolled LAN directory…' : 'LAN directory disabled.'; if (refresh) void agent?.refresh(true); }
export function saveDirectory(raw: unknown | null) { const config = raw === null ? null : directoryConfig(raw), previous = directorySettings(); configure(config); try { file().write(JSON.stringify(config)); } catch (e) { try { configure(previous); } catch { configure(null); } throw e; } bump(); }
export const refreshDirectory = (force = false) => agent?.refresh(force);

export const directoryEnrollmentKey = () => signer?.publicKey ?? '';

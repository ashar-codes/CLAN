import { directoryClans, onDirectoryClans } from './people/directory';
// DNS-SD browsing via react-native-zeroconf (NsdManager on Android, NSNetServiceBrowser on iOS).
// iOS requires NSBonjourServices + NSLocalNetworkUsageDescription (app.json); the OS shows the local-network prompt.
// A browse that errors (Android NSD busy, iOS local-network permission, Wi-Fi change) is restarted with backoff and
// again whenever the app returns to the foreground; the last state is kept for diagnostics instead of being dropped.
import { AppState, Platform } from 'react-native';
import { PeerLink } from '../modules/peer-link';
import { discoveryDiagnostics } from './people/nearby';
import Zeroconf from 'react-native-zeroconf';
import { lanUrls, SERVICE_TYPE } from '@classroom/protocol';
import type { Candidate } from '@classroom/client';

export let clanDiscoveryStatus = 'Not started';

export function browse(onChange: (list: (Candidate & { sid: string })[]) => void): () => void {
  if (Platform.OS === 'android' && PeerLink?.clanBrowse) return browseNative(onChange);
  const zc = new Zeroconf();
  const found = new Map<string, Candidate & { sid: string }>();
  const emit = () => { const values = [...directoryClans(), ...found.values()]; onChange([...new Map(values.map((v) => [v.sid, v])).values()]); };
  const unsubscribe = onDirectoryClans(emit), expiry = setInterval(emit, 5000);
  const byName = new Map<string, string>();
  let stopped = false, retry: ReturnType<typeof setTimeout> | null = null, failures = 0;
  const later = () => { if (stopped || retry) return; retry = setTimeout(() => { retry = null; scan(); }, Math.min(30_000, 2000 * 2 ** failures++)); };
  function scan() {
    if (stopped) return;
    try { zc.stop(); } catch { /* not scanning yet */ }
    try { zc.scan(SERVICE_TYPE, 'tcp', 'local.'); clanDiscoveryStatus = 'Looking for CLANs on this network'; }
    catch (e) { clanDiscoveryStatus = `CLAN discovery could not start: ${(e as Error).message}`; later(); }
  }
  zc.on('resolved', (s: { name: string; addresses?: string[]; port: number; txt?: Record<string, string> }) => {
    const [url, ...alt] = lanUrls(s.port, s.addresses ?? [], [s.txt?.a]);
    if (!url || s.txt?.v !== '1' || !s.txt.sid) return;
    failures = 0;
    found.set(s.txt.sid, { sid: s.txt.sid, title: s.txt.title, url, alt });
    byName.set(s.name, s.txt.sid);
    emit();
  });
  zc.on('remove', (name: string) => {
    const sid = byName.get(name);
    if (sid && found.delete(sid)) emit();
  });
  zc.on('error', (e: unknown) => { clanDiscoveryStatus = `CLAN discovery error, retrying: ${e instanceof Error ? e.message : String(e)}`; later(); });
  const app = AppState.addEventListener('change', (st) => { if (st === 'active') { failures = 0; scan(); } });
  scan();
  return () => { stopped = true; if (retry) clearTimeout(retry); app.remove(); clearInterval(expiry); unsubscribe(); try { zc.stop(); } catch { /* stopped */ } zc.removeDeviceListeners(); };
}

/**
 * Android: hosted CLANs through PeerLink's NSD browser, which shares one serialized resolve queue (with deadlines and
 * retries) with People discovery — two independent NSD clients in one app made resolves fail or hang
 * (docs/DISCOVERY_ROOT_CAUSE.md). Untrusted hints only: joining still needs the host's code and authentication.
 */
let nativeUsers = 0; // Join and CLAN Radar may browse at once; the single native browser stops with the last one
function browseNative(onChange: (list: (Candidate & { sid: string })[]) => void): () => void {
  nativeUsers++;
  const found = new Map<string, Candidate & { sid: string }>(), byName = new Map<string, string>();
  const emit = () => { const values = [...directoryClans(), ...found.values()]; onChange([...new Map(values.map((v) => [v.sid, v])).values()]); discoveryDiagnostics.set({ clansFound: found.size }); };
  const unsubscribe = onDirectoryClans(emit), expiry = setInterval(emit, 5000);
  const sub = PeerLink!.addListener('clan', (e) => {
    if (e.type === 'lost') { const sid = byName.get(e.name); if (sid && found.delete(sid)) emit(); return; }
    const [url, ...alt] = lanUrls(e.port, e.hosts, [e.a || undefined]);
    if (!url || e.v !== '1' || !/^[0-9a-f-]{36}$/.test(e.sid)) return;
    found.set(e.sid, { sid: e.sid, title: e.title.slice(0, 80) || 'CLAN', url, alt });
    byName.set(e.name, e.sid);
    clanDiscoveryStatus = 'Looking for CLANs on this network'; emit();
  });
  const start = (why: string) => { try { PeerLink!.clanBrowse!(); discoveryDiagnostics.set({ clanBrowsing: true }, `CLAN discovery started (${why})`); clanDiscoveryStatus = 'Looking for CLANs on this network'; } catch (err) { discoveryDiagnostics.fail('browse', (err as Error).message); clanDiscoveryStatus = 'CLAN discovery could not start.'; } };
  const net = PeerLink!.addListener('network', () => { found.clear(); emit(); start('network changed'); });
  const app = AppState.addEventListener('change', (st) => { if (st === 'active') start('foreground'); });
  start('opened');
  return () => { sub.remove(); net.remove(); app.remove(); clearInterval(expiry); unsubscribe(); if (--nativeUsers === 0) { try { PeerLink!.clanStopBrowse!(); } catch { /* stopped */ } discoveryDiagnostics.set({ clanBrowsing: false }); } };
}

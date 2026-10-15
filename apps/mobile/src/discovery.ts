import { directoryClans, onDirectoryClans } from './people/directory';
// DNS-SD browsing via react-native-zeroconf (NsdManager on Android, NSNetServiceBrowser on iOS).
// iOS requires NSBonjourServices + NSLocalNetworkUsageDescription (app.json); the OS shows the local-network prompt.
// A browse that errors (Android NSD busy, iOS local-network permission, Wi-Fi change) is restarted with backoff and
// again whenever the app returns to the foreground; the last state is kept for diagnostics instead of being dropped.
import { AppState } from 'react-native';
import Zeroconf from 'react-native-zeroconf';
import { lanUrls, SERVICE_TYPE } from '@classroom/protocol';
import type { Candidate } from '@classroom/client';

export let clanDiscoveryStatus = 'Not started';

export function browse(onChange: (list: (Candidate & { sid: string })[]) => void): () => void {
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

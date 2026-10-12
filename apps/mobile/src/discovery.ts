import { directoryClans, onDirectoryClans } from './people/directory';
// DNS-SD browsing via react-native-zeroconf (NsdManager on Android, NSNetServiceBrowser on iOS).
// iOS requires NSBonjourServices + NSLocalNetworkUsageDescription (app.json); the OS shows the local-network prompt.
import Zeroconf from 'react-native-zeroconf';
import { lanUrls, SERVICE_TYPE } from '@classroom/protocol';
import type { Candidate } from '@classroom/client';

export function browse(onChange: (list: (Candidate & { sid: string })[]) => void): () => void {
  const zc = new Zeroconf();
  const found = new Map<string, Candidate & { sid: string }>();
  const emit = () => { const values = [...directoryClans(), ...found.values()]; onChange([...new Map(values.map((v) => [v.sid, v])).values()]); };
  const unsubscribe = onDirectoryClans(emit), expiry = setInterval(emit, 5000);
  const byName = new Map<string, string>();
  zc.on('resolved', (s: { name: string; addresses?: string[]; port: number; txt?: Record<string, string> }) => {
    const [url, ...alt] = lanUrls(s.port, s.addresses ?? [], [s.txt?.a]);
    if (!url || s.txt?.v !== '1' || !s.txt.sid) return;
    found.set(s.txt.sid, { sid: s.txt.sid, title: s.txt.title, url, alt });
    byName.set(s.name, s.txt.sid);
    emit();
  });
  zc.on('remove', (name: string) => {
    const sid = byName.get(name);
    if (sid && found.delete(sid)) emit();
  });
  zc.on('error', () => {});
  zc.scan(SERVICE_TYPE, 'tcp', 'local.');
  return () => { clearInterval(expiry); unsubscribe(); zc.stop(); zc.removeDeviceListeners(); };
}

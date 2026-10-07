import { Bonjour } from 'bonjour-service';
import { SERVICE_TYPE, type Advertisement } from '@classroom/protocol';

export type DiscoveredClassroom = { sid: string; title: string; url: string; type: string };

/** Publish the classroom over DNS-SD on one interface. Returns a stop function. */
export function advertise(o: { host: string; port: number; sid: string; title: string; type: string }): () => Promise<void> {
  // `interface` is forwarded to multicast-dns at runtime; the bundled typings omit it.
  const bonjour = new Bonjour({ interface: o.host } as object, (e: Error) => console.warn('[mdns]', e.message));
  const txt: Advertisement = { v: '1', sid: o.sid, title: o.title, type: o.type };
  bonjour.publish({ name: `CLAN ${o.sid.slice(0, 8)}`, type: SERVICE_TYPE, port: o.port, txt, disableIPv6: true });
  return () => new Promise((resolve) => bonjour.unpublishAll(() => { bonjour.destroy(); resolve(); }));
}

/** Browse for classrooms. Calls onChange with the full current list whenever it changes. Returns stop. */
export function browse(onChange: (list: DiscoveredClassroom[]) => void): () => void {
  const bonjour = new Bonjour({}, (e: Error) => console.warn('[mdns]', e.message));
  const found = new Map<string, DiscoveredClassroom>();
  const browser = bonjour.find({ type: SERVICE_TYPE });
  const emit = () => onChange([...found.values()]);
  browser.on('up', (s) => {
    const txt = (s.txt ?? {}) as Partial<Advertisement>;
    const addr = s.addresses?.find((a) => a.includes('.')) ?? s.referer?.address;
    if (!txt.sid || !addr || txt.v !== '1') return;
    found.set(txt.sid, { sid: txt.sid, title: String(txt.title ?? 'CLAN'), type: /^[A-Z_]{3,20}$/.test(String(txt.type)) ? String(txt.type) : 'CLASSROOM', url: `http://${addr}:${s.port}` });
    emit();
  });
  browser.on('down', (s) => {
    const sid = (s.txt as Partial<Advertisement> | undefined)?.sid;
    if (sid && found.delete(sid)) emit();
  });
  // Re-query periodically: phones and laptops drop multicast packets on busy classroom Wi-Fi.
  const t = setInterval(() => browser.update(), 3000);
  return () => { clearInterval(t); browser.stop(); bonjour.destroy(); };
}

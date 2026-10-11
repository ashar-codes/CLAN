import { Bonjour } from 'bonjour-service';
import { lanUrls, SERVICE_TYPE, type Advertisement } from '@classroom/protocol';

export type DiscoveredClassroom = { sid: string; title: string; url: string; type: string; alt?: string[] };

/** Opt-in discovery diagnostics (CLAN_DEBUG_DISCOVERY=1): advertise/browse lifecycle and endpoints, to stderr. */
export const dlog = (...a: unknown[]) => { if (process.env.CLAN_DEBUG_DISCOVERY === '1') console.error(`[discovery ${new Date().toISOString().slice(11, 23)}]`, ...a); };

/**
 * Publish the session over DNS-SD on one interface. `ready` resolves once the service has been announced.
 * The responder socket is bound to 0.0.0.0: multicast-dns otherwise binds port 5353 to the interface's unicast address,
 * and macOS (and Linux) then never deliver multicast queries to it, so the host only ever sent its startup announcements
 * and late browsers found nothing (the intermittent "No classrooms found"). The interface still selects multicast
 * membership and the outgoing interface.
 */
export function advertise(o: { host: string; port: number; sid: string; title: string; type: string }): (() => Promise<void>) & { ready: Promise<void> } {
  dlog('advertise start', { interface: o.host, port: o.port, sid: o.sid });
  // `interface`/`bind` are forwarded to multicast-dns at runtime; the bundled typings omit them.
  const bonjour = new Bonjour({ interface: o.host, bind: '0.0.0.0' } as object, (e: Error) => console.warn('[mdns]', e.message));
  const txt: Advertisement = { v: '1', sid: o.sid, title: o.title, type: o.type, a: o.host };
  const svc = bonjour.publish({ name: `CLAN ${o.sid.slice(0, 8)}`, type: SERVICE_TYPE, port: o.port, txt, disableIPv6: true });
  const ready = new Promise<void>((r) => { svc.once('up', () => { dlog('advertise ready', o.sid); r(); }); svc.once('error', () => r()); setTimeout(r, 5000).unref(); });
  const stop = () => new Promise<void>((resolve) => bonjour.unpublishAll(() => { bonjour.destroy(); dlog('advertise stop', o.sid); resolve(); }));
  return Object.assign(stop, { ready });
}

/** Browse for classrooms. Calls onChange with the full current list whenever it changes. Returns stop. */
export function browse(onChange: (list: DiscoveredClassroom[]) => void): () => void {
  const bonjour = new Bonjour({}, (e: Error) => console.warn('[mdns]', e.message));
  const found = new Map<string, DiscoveredClassroom>();
  const browser = bonjour.find({ type: SERVICE_TYPE });
  dlog('browse start');
  const emit = () => onChange([...found.values()]);
  browser.on('up', (s) => {
    const txt = (s.txt ?? {}) as Partial<Advertisement>;
    const [url, ...alt] = lanUrls(s.port, s.addresses ?? [], [txt.a, s.referer?.address]);
    if (!txt.sid || !url || txt.v !== '1') return;
    dlog('browse up', { sid: txt.sid, url, alt, port: s.port });
    found.set(txt.sid, { sid: txt.sid, title: String(txt.title ?? 'CLAN'), type: /^[A-Z_]{3,20}$/.test(String(txt.type)) ? String(txt.type) : 'CLASSROOM', url, alt });
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

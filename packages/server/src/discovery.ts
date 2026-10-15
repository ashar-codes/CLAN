import { Bonjour } from 'bonjour-service';
import { candidateInterfaces } from './netinfo.ts';
import { lanUrls, SERVICE_TYPE, type Advertisement } from '@classroom/protocol';

export type DiscoveredClassroom = { sid: string; title: string; url: string; type: string; alt?: string[]; discoverySource?: 'directory' };

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
  const svc = bonjour.publish({ name: `CLAN ${o.sid.slice(0, 8)}`, type: SERVICE_TYPE, port: o.port, host: `clan-${o.sid.slice(0, 8)}.local`, txt, disableIPv6: true });
  // Only the hosting interface's address: the machine's other adapters (VPN, VM, link-local) are unreachable for members
  // and a browser that picks one of them fails (docs/DISCOVERY_ROOT_CAUSE.md).
  if (typeof svc.records === 'function') { const records = svc.records.bind(svc); svc.records = () => records().filter((r) => r.type !== 'A' || r.data === o.host); }
  const ready = new Promise<void>((r) => { svc.once('up', () => { dlog('advertise ready', o.sid); r(); }); svc.once('error', () => r()); setTimeout(r, 5000).unref(); });
  let stopping: Promise<void> | null = null;
  const stop = () => stopping ??= new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(deadline);
      bonjour.destroy(); dlog('advertise stop', o.sid); resolve();
    };
    // A removed network interface can prevent the multicast goodbye callback. Shutdown still
    // must close the sockets and the host; stale discovery never grants an authenticated session.
    const deadline = setTimeout(finish, 1500);
    try { bonjour.unpublishAll(finish); } catch { finish(); }
  });
  return Object.assign(stop, { ready });
}

/** Browse for classrooms. Calls onChange with the full current list whenever it changes. Returns stop. */
export function browse(onChange: (list: DiscoveredClassroom[]) => void, interfaces = candidateInterfaces().map(i => i.address)): () => void {
  // multicast-dns otherwise sends Windows queries through the OS default adapter,
  // which can be a VPN/virtual interface even while advertisements arrive on Wi-Fi.
  // Select bounded real LAN interfaces explicitly; discovery remains an untrusted hint.
  const addresses = [...new Set(interfaces)].slice(0, 8);
  const sources = (addresses.length ? addresses : [undefined]).map(address => {
    const bonjour = new Bonjour({ bind: '0.0.0.0', ...(address ? { interface: address } : {}) } as object, (e: Error) => console.warn('[mdns]', e.message));
    const found = new Map<string, DiscoveredClassroom>();
    const browser = bonjour.find({ type: SERVICE_TYPE });
    return { bonjour, found, browser };
  });
  const emit = () => {
    const merged = new Map<string, DiscoveredClassroom>();
    for (const source of sources) for (const [id, item] of source.found) {
      const previous = merged.get(id);
      const urls = [...new Set([...(previous ? [previous.url, ...(previous.alt ?? [])] : []), item.url, ...(item.alt ?? [])])].slice(0, 8);
      merged.set(id, { ...item, url: urls[0]!, alt: urls.slice(1) });
    }
    onChange([...merged.values()]);
  };
  for (const { browser, found } of sources) {
    const up = (s: (typeof browser.services)[number]) => {
      const txt = (s.txt ?? {}) as Partial<Advertisement>;
      const [url, ...alt] = lanUrls(s.port, s.addresses ?? [], [txt.a, s.referer?.address]);
      if (!txt.sid || !url || txt.v !== '1') return;
      dlog('browse up', { sid: txt.sid, url, alt, port: s.port });
      found.set(txt.sid, { sid: txt.sid, title: String(txt.title ?? 'CLAN'), type: /^[A-Z_]{3,20}$/.test(String(txt.type)) ? String(txt.type) : 'CLASSROOM', url, alt });
      emit();
    };
    browser.on('up', up); browser.on('srv-update', up); browser.on('txt-update', up);
    browser.on('down', s => { const sid = (s.txt as Partial<Advertisement> | undefined)?.sid; if (sid && found.delete(sid)) emit(); });
  }
  dlog('browse start', { interfaces: addresses.length });
  const t = setInterval(() => { for (const { browser } of sources) { browser.expire(); browser.update(); } }, 3000);
  return () => { clearInterval(t); for (const { browser, bonjour } of sources) { browser.stop(); bonjour.destroy(); } };
}

// DNS-SD on the real LAN interfaces only (docs/DISCOVERY_ROOT_CAUSE.md).
// bonjour-service publishes an A record for EVERY non-internal IPv4 address of the machine (VPN, VM, link-local USB
// adapters…) under the OS host name, and receivers pick one of them. A peer that picks an unreachable address fails
// silently. Here each advert is published per LAN interface, under a CLAN-specific host name, with only that
// interface's address; browsers keep every address and rank them so callers can try them in order.
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Bonjour, type Service } from 'bonjour-service';
import { candidateInterfaces } from './netinfo.ts';

export type LanAddr = { name: string; address: string; netmask: string };

/** Real LAN IPv4 interfaces (virtual/VPN adapters excluded), best first; link-local only if nothing else exists. */
export function lanAddresses(ifaces = networkInterfaces()): LanAddr[] {
  const mask = new Map<string, string>();
  for (const [name, list] of Object.entries(ifaces)) for (const a of list ?? []) if (a.family === 'IPv4') mask.set(`${name}|${a.address}`, a.netmask);
  const all = candidateInterfaces(ifaces).map((i) => ({ name: i.name, address: i.address, netmask: mask.get(`${i.name}|${i.address}`) ?? '255.255.255.0' }));
  const routable = all.filter((a) => !a.address.startsWith('169.254.'));
  return (routable.length ? routable : all).slice(0, 4);
}

const toInt = (ip: string) => ip.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
const sameSubnet = (a: string, b: LanAddr) => ((toInt(a) & toInt(b.netmask)) >>> 0) === ((toInt(b.address) & toInt(b.netmask)) >>> 0);
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Every usable IPv4 address of a discovered service, best first: on one of our subnets, then hinted (TXT `a` / the
 * packet's source), then other private addresses. Link-local (169.254/16) only when it is on our own subnet.
 */
export function rankAddresses(addresses: (string | undefined)[], hints: (string | undefined)[] = [], ours: LanAddr[] = lanAddresses()): string[] {
  const all = [...new Set([...hints, ...addresses].filter((a): a is string => !!a && IPV4.test(a)))];
  const score = (a: string) => (ours.some((o) => sameSubnet(a, o)) ? 0 : 4) + (hints.includes(a) ? 0 : 1) + (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) ? 0 : 2);
  return all.filter((a) => !a.startsWith('169.254.') || ours.some((o) => sameSubnet(a, o))).sort((x, y) => score(x) - score(y)).slice(0, 6);
}

export type MdnsState = { interfaces: string[]; published: number; errors: string[] };

/** Publish one service on each LAN interface with only that interface's address. Returns stop + a readiness promise. */
export function publishLan(o: { type: string; name: string; port: number; txt: Record<string, string>; interfaces?: LanAddr[]; onError?(m: string): void }) {
  const lans = o.interfaces ?? lanAddresses(), host = `clan-${randomBytes(5).toString('hex')}.local`;
  const state: MdnsState = { interfaces: lans.map((l) => `${l.name} ${l.address}`), published: 0, errors: [] };
  const sources = lans.map((lan) => {
    const bonjour = new Bonjour({ interface: lan.address, bind: '0.0.0.0' } as object, (e: Error) => { state.errors.push(e.message); o.onError?.(e.message); });
    const svc = bonjour.publish({ name: o.name, type: o.type, port: o.port, host, txt: { ...o.txt, a: lan.address }, disableIPv6: true });
    const records = svc.records.bind(svc);
    // only this interface's address, never the machine's other adapters
    svc.records = () => records().filter((r) => r.type !== 'A' || r.data === lan.address);
    return { bonjour, svc };
  });
  const ready = Promise.all(sources.map(({ svc }) => new Promise<void>((r) => { svc.once('up', () => { state.published++; r(); }); svc.once('error', (e: Error) => { state.errors.push(e.message); r(); }); setTimeout(r, 5000).unref?.(); })));
  let stopping: Promise<void> | null = null;
  const stop = () => stopping ??= Promise.all(sources.map(({ bonjour }) => new Promise<void>((resolve) => {
    let done = false; const finish = () => { if (done) return; done = true; clearTimeout(t); bonjour.destroy(); resolve(); };
    const t = setTimeout(finish, 1500); // a vanished interface may never confirm the goodbye
    try { bonjour.unpublishAll(finish); } catch { finish(); }
  }))).then(() => {});
  return Object.assign(stop, { ready, state });
}

export type LanService = { name: string; port: number; addrs: string[]; txt: Record<string, unknown> };

/** Browse on each LAN interface; `onUp` gets every ranked address (callers try them in order). */
export function browseLan(type: string, onUp: (s: LanService) => void, onDown?: (s: LanService) => void, o: { interfaces?: LanAddr[]; everyMs?: number; onError?(m: string): void } = {}) {
  const lans = o.interfaces ?? lanAddresses();
  const sources = (lans.length ? lans.map((l) => l.address) : [undefined]).map((address) => {
    const bonjour = new Bonjour({ bind: '0.0.0.0', ...(address ? { interface: address } : {}) } as object, (e: Error) => o.onError?.(e.message));
    return { bonjour, browser: bonjour.find({ type }) };
  });
  const view = (s: Service): LanService => {
    const txt = (s.txt ?? {}) as Record<string, unknown>;
    return { name: s.name, port: s.port, txt, addrs: rankAddresses(s.addresses ?? [], [typeof txt.a === 'string' ? txt.a : undefined, s.referer?.address], lans) };
  };
  for (const { browser } of sources) {
    const up = (s: Service) => { const v = view(s); if (v.addrs.length) onUp(v); };
    browser.on('up', up); browser.on('srv-update', up); browser.on('txt-update', up);
    browser.on('down', (s: Service) => onDown?.(view(s)));
  }
  const t = setInterval(() => { for (const { browser } of sources) { browser.expire(); browser.update(); } }, o.everyMs ?? 4000);
  t.unref?.();
  return () => { clearInterval(t); for (const { browser, bonjour } of sources) { browser.stop(); bonjour.destroy(); } };
}

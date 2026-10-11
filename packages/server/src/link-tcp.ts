// clan-link/1 over plain TCP (security comes from the link handshake, not the socket): a listener for incoming links
// and a dialer for `tcp:host:port` addresses. Used by computers on any LAN or hotspot, and by tests.
import { createServer, connect, type Socket } from 'node:net';
import { Bonjour } from 'bonjour-service';
import type { ByteLink } from '@classroom/protocol';

export const LINK_SERVICE = 'clanlink';

export function socketLink(s: Socket): ByteLink {
  s.setNoDelay(true);
  return {
    send: (b) => { if (!s.destroyed) s.write(b); },
    onData: (cb) => { s.on('data', (d: Buffer) => cb(new Uint8Array(d.buffer, d.byteOffset, d.length))); },
    onClose: (cb) => { s.once('close', () => cb()); s.on('error', () => {}); },
    close: () => s.destroy(),
  };
}

/** Accepts raw connections and hands each one over as a ByteLink (at most `max` at once). */
export async function listenLinks(o: { port?: number; bind?: string; onLink(l: ByteLink, remote: string): void; max?: number }) {
  const open = new Set<Socket>();
  const server = createServer((s) => {
    if (open.size >= (o.max ?? 64)) return s.destroy();
    open.add(s); s.once('close', () => open.delete(s));
    s.setTimeout(120_000, () => s.destroy()); // the session pings every 15 s
    o.onLink(socketLink(s), `${s.remoteAddress}:${s.remotePort}`);
  });
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(o.port ?? 0, o.bind ?? '0.0.0.0', () => res()); });
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => { for (const s of open) s.destroy(); server.close(() => r()); }) };
}

const ADDR = /^tcp:(\[([0-9a-fA-F:.]+)(%[\w.-]+)?\]|([0-9.]{7,15})):(\d{2,5})$/;
export const tcpTransport = (timeoutMs = 8000) => ({
  name: 'tcp',
  handles: (a: string) => ADDR.test(a),
  dial: (a: string) => new Promise<ByteLink>((res, rej) => {
    const m = ADDR.exec(a); if (!m) return rej(new Error('Not a TCP address.'));
    const host = m[2] ? m[2] + (m[3] ?? '') : m[4]!, port = Number(m[5]);
    const s = connect({ host, port });
    const t = setTimeout(() => { s.destroy(); rej(new Error('Not reachable.')); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); res(socketLink(s)); });
    s.once('error', (e) => { clearTimeout(t); rej(e); });
  }),
});

/** DNS-SD for link listeners: only a random id, so a nearby observer learns nothing about who is listening. */
export function advertiseLinks(o: { port: number; r: string }) {
  const b = new Bonjour();
  const svc = b.publish({ name: `clan-${o.r.slice(0, 8)}`, type: LINK_SERVICE, port: o.port, txt: { v: '1', r: o.r } });
  return async () => { await new Promise<void>((r) => svc.stop?.(() => r()) ?? r()); b.destroy(); };
}
export function browseLinks(onUp: (s: { addr: string; port: number; r: string }) => void) {
  const b = new Bonjour();
  const br = b.find({ type: LINK_SERVICE }, (s) => {
    const r = String((s.txt as Record<string, unknown> | undefined)?.r ?? '');
    const addr = (s.addresses ?? []).find((a) => /^[0-9.]+$/.test(a));
    if (addr && /^[A-Za-z0-9_-]{8,24}$/.test(r)) onUp({ addr, port: s.port, r });
  });
  return () => { br.stop(); b.destroy(); };
}

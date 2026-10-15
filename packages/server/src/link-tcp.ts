// clan-link/1 over plain TCP (security comes from the link handshake, not the socket): a listener for incoming links
// and a dialer for `tcp:host:port` addresses. Used by computers on any LAN or hotspot, and by tests.
import { createServer, connect, type Socket } from 'node:net';
import { publishLan } from './lan-mdns.ts';
import { browsePeople } from './people-server.ts';
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

/** DNS-SD for link listeners: a random id and the friends-only presence tag, nothing else. */
export function advertiseLinks(o: { port: number; r: string; t?: string; onError?(m: string): void }) {
  return publishLan({ type: LINK_SERVICE, name: `clan-${o.r.slice(0, 8)}`, port: o.port, txt: { v: '1', r: o.r, ...(o.t ? { t: o.t } : {}) }, onError: o.onError });
}
export const browseLinks = (onUp: Parameters<typeof browsePeople>[0], onDown?: (r: string) => void, o: { onError?(m: string): void } = {}) => browsePeople(onUp, onDown, LINK_SERVICE, o);

// JS side of the native peer transport. Turns native sockets into ByteLinks for clan-link/1 and exposes the radios
// (NSD/Bonjour, Wi-Fi Direct, Wi-Fi Aware, local hotspot) that find and connect phones without a router. Optional:
// a build without the module reports no capabilities and the app falls back to what it can do (LAN to computers, QR).
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ByteLink } from '@classroom/protocol';

export type PeerCapabilities = {
  platform: 'android' | 'ios'; sdk?: number; tcp: boolean; nsd: boolean; applePeerToPeer: boolean;
  wifiDirect: boolean; wifiAware: boolean; wifiAwareAvailable: boolean; localHotspot: boolean; joinWifi: boolean;
};
export type RadioEvent =
  | { type: 'found'; via: 'nsd'; r: string; t: string; host: string; port: number; name: string }
  | { type: 'found'; via: 'bonjour'; r: string; t: string; service: string }
  | { type: 'found'; via: 'p2p'; r: string; t: string; port: number; device: string }
  | { type: 'found'; via: 'aware'; r: string; t: string; peer: string }
  | { type: 'connected'; via: 'p2p'; owner: boolean; host: string | null }
  | { type: 'connected'; via: 'aware'; peer: string; host: string; port: number; net: string }
  | { type: 'lost'; via: string; name?: string }
  | { type: 'disconnected'; via: string; peer?: string }
  | { type: 'state'; via: 'p2p'; enabled: boolean }
  | { type: 'hotspotStopped'; via: 'hotspot' }
  | { type: 'error'; via: string; message: string };
type SocketEvent = { id: string; type: 'accepted' | 'data' | 'closed'; data?: string; remote?: string };
type NativeApi = {
  capabilities(): PeerCapabilities;
  listen(port: number): Promise<number>; stopListening(): void;
  connect(host: string, port: number, net: string | null): Promise<string>;
  connectService?(name: string): Promise<string>;
  write(id: string, b64: string): boolean; close(id: string): void;
  addresses(): string[];
  advertise(r: string, t: string, port: number): void; stopAdvertise(): void; browse(): void; stopBrowse(): void;
  p2pStart(r: string, t: string, port: number): Promise<void>; p2pConnect(device: string): Promise<void>; p2pDisconnect(): void; p2pStop(): void;
  awareStart(r: string, t: string, port: number): Promise<void>; awareConnect(peer: string): Promise<void>; awareStop(): void;
  hotspotStart(): Promise<{ ssid: string; passphrase: string }>; hotspotStop(): void;
  joinWifi(ssid: string, passphrase: string): Promise<void>; leaveWifi(): void;
  availabilityStart(text: string): void; availabilityStop(): void; availabilityRunning(): boolean;
  addListener(event: 'socket', cb: (e: SocketEvent) => void): { remove(): void };
  addListener(event: 'radio', cb: (e: RadioEvent) => void): { remove(): void };
  addListener(event: 'availability', cb: (e: { running: boolean; byUser?: boolean }) => void): { remove(): void };
};
export const PeerLink = requireOptionalNativeModule<NativeApi>('PeerLink');

const to64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const from64 = (s: string) => { const b = atob(s), out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; };

// one native event subscription, fanned out per socket id
const handlers = new Map<string, { data: ((b: Uint8Array) => void)[]; close: ((r?: string) => void)[]; pending: Uint8Array[]; closed: boolean }>();
let onAccept: ((l: ByteLink) => void) | null = null;
PeerLink?.addListener('socket', (e) => {
  if (e.type === 'accepted') { const l = socketLink(e.id); if (onAccept) onAccept(l); else PeerLink!.close(e.id); return; }
  const h = handlers.get(e.id); if (!h) return;
  if (e.type === 'data' && e.data) { const b = from64(e.data); if (h.data.length) h.data.forEach((f) => f(b)); else h.pending.push(b); }
  if (e.type === 'closed') { h.closed = true; handlers.delete(e.id); h.close.forEach((f) => f()); }
});
function socketLink(id: string): ByteLink {
  const h = { data: [] as ((b: Uint8Array) => void)[], close: [] as ((r?: string) => void)[], pending: [] as Uint8Array[], closed: false };
  handlers.set(id, h);
  return {
    send: (b) => { if (!h.closed) PeerLink!.write(id, to64(b)); },
    onData: (cb) => { h.data.push(cb); for (const b of h.pending.splice(0)) cb(b); },
    onClose: (cb) => { if (h.closed) cb(); else h.close.push(cb); },
    close: () => { if (!h.closed) PeerLink!.close(id); },
  };
}

/** Start accepting link connections; returns the port. */
export async function listen(port: number, accept: (l: ByteLink) => void) { if (!PeerLink) throw new Error('This build has no peer transport.'); onAccept = accept; return PeerLink.listen(port); }
export function stopListening() { onAccept = null; PeerLink?.stopListening(); }

/**
 * Addresses this transport dials: `tcp:<ipv4>:<port>` / `tcp:[<ipv6>%<if>]:<port>` (any shared network),
 * `aware:<net>:[<ipv6>]:<port>` (a Wi-Fi Aware data path), `svc:<bonjour name>` (iOS Bonjour, incl. peer-to-peer Wi-Fi).
 */
const TCP = /^tcp:(?:\[([0-9a-fA-F:.]+(?:%[\w.-]+)?)\]|([0-9.]{7,15})):(\d{2,5})$/, AWARE = /^aware:(a\d{1,6}):\[([0-9a-fA-F:.]+(?:%[\w.-]+)?)\]:(\d{2,5})$/, SVC = /^svc:(clan-[A-Za-z0-9_-]{1,24})$/;
export const nativeLinkTransport = {
  name: 'native',
  handles: (a: string) => !!PeerLink && (TCP.test(a) || AWARE.test(a) || (SVC.test(a) && !!PeerLink.connectService)),
  async dial(a: string): Promise<ByteLink> {
    let m = TCP.exec(a);
    if (m) return socketLink(await PeerLink!.connect(m[1] ?? m[2]!, Number(m[3]), null));
    m = AWARE.exec(a);
    if (m) return socketLink(await PeerLink!.connect(m[2]!, Number(m[3]), m[1]!));
    m = SVC.exec(a);
    if (m && PeerLink!.connectService) return socketLink(await PeerLink!.connectService(m[1]!));
    throw new Error('Unsupported address.');
  },
};
export const capabilities = (): PeerCapabilities | null => { try { return PeerLink?.capabilities() ?? null; } catch { return null; } };

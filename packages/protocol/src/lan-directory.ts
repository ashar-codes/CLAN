// A trusted administrator directory carries discovery hints, never chat/file bytes or peer authority.
import { z } from 'zod';

export function internalAddress(host: string, loopback = false): boolean {
  if (/^\[(fc|fd)[0-9a-f]{2}:/i.test(host) && z.ipv6().safeParse(host.slice(1, -1)).success) return true; // IPv6 ULA; link-local scope is not routable
  const p = host.split('.').map(Number);
  if (p.length !== 4 || !host.split('.').every((x) => /^\d{1,3}$/.test(x) && String(Number(x)) === x) || p.some((x) => x > 255)) return false;
  return p[0] === 10 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1]! >= 16 && p[1]! <= 31 || loopback && p[0] === 127;
}
export function internalEndpoint(value: string, loopback = false): boolean {
  const m = /^(\[[0-9a-f:]+\]|[0-9.]+):(\d{1,5})$/i.exec(value);
  return !!m && internalAddress(m[1]!, loopback) && Number(m[2]) > 0 && Number(m[2]) <= 65535;
}
export const DirectoryConfig = z.object({
  url: z.string().max(128), certificate: z.string().min(64).max(16384), spkiSha256: z.string().min(40).max(64),
}).strict();
export type DirectoryConfig = z.infer<typeof DirectoryConfig>;
export function directoryConfig(raw: unknown, allowLoopback = false): DirectoryConfig {
  const c = DirectoryConfig.parse(raw), u = new URL(c.url);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' || !internalEndpoint(`${u.hostname}:${u.port || '443'}`, allowLoopback)) throw new Error('Use the administrator’s HTTPS internal IP address and certificate pin.');
  return { ...c, url: u.origin };
}
export const DirectoryAdvert = z.object({
  kind: z.enum(['link', 'people', 'clan']), r: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  t: z.string().max(128).optional(), endpoints: z.array(z.string().max(80)).min(1).max(3),
  clan: z.object({ sid: z.uuid(), title: z.string().min(1).max(80), type: z.string().regex(/^[A-Z_]{3,20}$/) }).strict().optional(),
}).strict().refine((a) => a.kind === 'clan' ? !!a.clan : !a.clan, 'CLAN metadata only for CLAN adverts');
export type DirectoryAdvert = z.infer<typeof DirectoryAdvert>;
export const DirectoryRegistration = z.object({ adverts: z.array(DirectoryAdvert).max(8) }).strict();
export const DirectoryReply = z.object({ ttlMs: z.number().int().positive().max(90_000), adverts: z.array(DirectoryAdvert).max(128) }).strict();
export type RouteNetwork = { address: string; netmask: string };
const v4 = (a: string) => { const x = a.split('.').map(Number); return x.length === 4 && x.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ? ((x[0]! << 24) | (x[1]! << 16) | (x[2]! << 8) | x[3]!) >>> 0 : null; };
export function sameSubnet(endpoint: string, networks: RouteNetwork[]): boolean {
  const host = endpoint.replace(/^tcp:/, '').slice(0, endpoint.replace(/^tcp:/, '').lastIndexOf(':')), ip = v4(host);
  return ip !== null && networks.some((n) => { const a = v4(n.address), mask = v4(n.netmask); return a !== null && mask !== null && (ip & mask) === (a & mask); });
}
/** Preserve a successful route, then actual interface/netmask matches, then routed hints. No address-range scans. */
export function orderLanRoutes(addresses: string[], networks: RouteNetwork[] = [], working?: string): string[] {
  return [...new Set(addresses)].slice(0, 6).sort((a, b) => (a === working ? -1 : sameSubnet(a, networks) ? 0 : 1) - (b === working ? -1 : sameSubnet(b, networks) ? 0 : 1));
}

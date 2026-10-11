// Personal device sync: the shared vocabulary (desktop, phone, any future transport). A student's devices form one
// personal account; they exchange versioned change records over an authenticated transport. Nothing here is CLAN
// authority: a linked device gets the owner's personal data, never host secrets or CLAN membership.
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64u } from './trust.ts';

// ---- versions (hybrid logical clock) ----
/** `<ms base36, 9>-<counter base36, 4>-<device 8>`; lexicographic order = causal-ish order with a device tie-break. */
export const hlc = (ms: number, counter: number, device: string) => `${Math.max(0, Math.floor(ms)).toString(36).padStart(9, '0')}-${counter.toString(36).padStart(4, '0')}-${device.slice(0, 8)}`;
export const hlcParts = (v: string) => { const [a = '0', b = '0', d = ''] = v.split('-'); return { ms: parseInt(a, 36), counter: parseInt(b, 36), device: d }; };

// ---- records ----
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v ?? null);
/** Content hash of a record payload (key order independent): equal content → equal hash on every device. */
export const contentHash = (v: unknown) => b64u.encode(sha256(new TextEncoder().encode(stable(v)))).slice(0, 32);
export const SyncRecord = z.object({
  kind: z.string().regex(/^[a-z][a-z-]{1,30}$/), id: z.string().min(1).max(80),
  version: z.string().max(40), hash: z.string().max(80), history: z.array(z.string().max(80)).max(16),
  deleted: z.boolean(), payload: z.unknown().nullable(),
});
export type SyncRecord = z.infer<typeof SyncRecord>;
export const SyncBatch = z.object({ records: z.array(SyncRecord).max(1000), next: z.number().int().min(0), more: z.boolean() });
export type SyncBatch = z.infer<typeof SyncBatch>;

/** Transport boundary: the engine never knows whether this is the LAN, a direct link or (later) the internet. */
export interface SyncTransport {
  readonly peer: string; // the remote device fingerprint
  pull(since: number, limit: number): Promise<SyncBatch>;
  push(records: SyncRecord[]): Promise<{ accepted: number }>;
  /** Bytes of a stored object from `offset` (resume); the receiver verifies SHA-256. */
  object(sha256: string, offset: number): Promise<AsyncIterable<Uint8Array>>;
}

// ---- device registry (signed) ----
export const DeviceEntry = z.object({
  fp: z.string().min(8).max(64), publicKey: z.string().min(40).max(64), name: z.string().trim().min(1).max(80), platform: z.string().max(20),
  tlsCa: z.string().max(4000), tlsSpki: z.string().max(64), addedAt: z.number().int(), addedBy: z.string().max(64),
  revokedAt: z.number().int().nullable(), revokedBy: z.string().max(64).nullable(),
  /** Ed25519 over `deviceStatement(entry)` by `revokedBy ?? addedBy`. */
  sig: z.string().max(200),
});
export type DeviceEntry = z.infer<typeof DeviceEntry>;
export const deviceStatement = (e: Omit<DeviceEntry, 'sig'>) => new TextEncoder().encode(['clan-sync-device/v1', e.fp, e.publicKey, e.name, e.platform, e.tlsSpki, e.addedAt, e.addedBy, e.revokedAt ?? '', e.revokedBy ?? ''].join('|'));

// ---- request authentication (on top of pinned TLS) ----
/** Each request is signed by the calling device key over method, path, time, nonce and body hash (replay-protected). */
export const requestStatement = (o: { method: string; path: string; ts: number; nonce: string; bodySha: string; fp: string }) =>
  new TextEncoder().encode(['clan-sync-req/v1', o.method.toUpperCase(), o.path, o.ts, o.nonce, o.bodySha, o.fp].join('|'));
export const REQUEST_SKEW_MS = 120_000;

// ---- linking ----
/** A link code is a short, single-use, 2-minute secret shown on the trusted device: `CLAN-XXXX-XXXX-XXXX` (60 bits). */
export const LINK_TTL_MS = 120_000;
export const LINK_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
/**
 * Link code as a QR (`clan://link?c=<code>&a=<host:port>`): exactly what the screen already shows as text — the same
 * one-time, two-minute code, still approved on the existing device — so scanning adds convenience, not authority.
 */
export const linkQr = (code: string, addresses: string[]) => `clan://link?${new URLSearchParams([['c', code], ...addresses.slice(0, 3).map((a) => ['a', a] as [string, string])]).toString()}`;
export function parseLinkQr(text: string): { code: string; address: string } | null {
  const m = /^clan:\/\/link\?(.*)$/.exec(text.trim()); if (!m || text.length > 300) return null;
  const q = new URLSearchParams(m[1]), code = normalizeLinkCode(q.get('c') ?? '');
  if (!code) return null;
  return { code, address: q.getAll('a').find((a) => /^\d+\.\d+\.\d+\.\d+:\d{2,5}$/.test(a)) ?? '' };
}
export const normalizeLinkCode = (s: string) => { const c = s.toUpperCase().replace(/^CLAN-?/, '').replace(/[^0-9A-Z]/g, ''); return c.length === 12 && [...c].every((x) => LINK_ALPHABET.includes(x)) ? c : null; };
export const formatLinkCode = (c: string) => `CLAN-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
/** Proof transcripts bind the code to the TLS key the client actually saw, both device keys and both nonces. */
export const linkTranscript = (role: 'joiner' | 'approver', o: { sessionId: string; serverSpki: string; joinerKey: string; nonceA: string; nonceB: string }) =>
  ['clan-sync-link/v1', role, o.sessionId, o.serverSpki, o.joinerKey, o.nonceA, o.nonceB].join('|');
export const LinkHello = z.object({
  sessionId: z.string().max(64), nonceB: z.string().max(64), proof: z.string().max(128), sig: z.string().max(200),
  device: DeviceEntry.pick({ fp: true, publicKey: true, name: true, platform: true, tlsCa: true, tlsSpki: true }).extend({ endpoints: z.array(z.string().max(80)).max(8) }),
});
export type LinkHello = z.infer<typeof LinkHello>;
export const LinkGrant = z.object({
  accountId: z.string().max(64), accountName: z.string().max(80), discoverySecret: z.string().max(64), devices: z.array(DeviceEntry).max(32),
  approver: z.object({ fp: z.string(), endpoints: z.array(z.string().max(80)).max(8) }),
});
export type LinkGrant = z.infer<typeof LinkGrant>;

/** Standard Wi-Fi QR payload (`WIFI:T:WPA;S:…;P:…;;`) — phones' own camera apps understand it too. */
export const wifiQr = (ssid: string, pass: string) => `WIFI:T:WPA;S:${ssid.replace(/([\\;,:"])/g, '\\$1')};P:${pass.replace(/([\\;,:"])/g, '\\$1')};;`;
export function parseWifiQr(t: string): { ssid: string; passphrase: string } | null {
  if (!/^WIFI:/i.test(t) || t.length > 300) return null;
  const field = (k: string) => { const m = new RegExp(`(?:^WIFI:|;)${k}:((?:\\\\.|[^;\\\\])*)`, 'i').exec(t); return m ? m[1]!.replace(/\\(.)/g, '$1') : null; };
  const ssid = field('S'), passphrase = field('P');
  return ssid && passphrase && passphrase.length >= 8 && passphrase.length <= 63 && new TextEncoder().encode(ssid).length <= 32 ? { ssid, passphrase } : null;
}

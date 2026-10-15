// Internet-assisted wake-ups (optional; docs/FINAL_COMMUNICATION_ARCHITECTURE.md). A phone registers its FCM/APNs token
// with a relay and gives each friend a capability for it. The relay learns no names, keys of friends or content: it
// maps sha256(cap) -> token and forwards {kind, id, expiry, capId, mac}. The phone accepts a wake-up only if `mac`
// verifies with the per-friend key that never reaches the relay, so neither the relay nor Google/Apple can fake a call.
// Content always travels later over the authenticated CLAN link; a wake-up only says "connect to this friend".
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { b64u } from './trust.ts';

export const PUSH_KINDS = ['msg', 'file', 'call', 'call.cancel', 'missed', 'meeting'] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
/** Longest a wake-up may stay deliverable (calls are far shorter: RING window). */
export const PUSH_MAX_TTL_MS = 24 * 3_600_000;
export const PUSH_CALL_TTL_MS = 60_000;
export const PUSH_SKEW_MS = 120_000;

const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Sig = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const CapId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const Nonce = z.string().regex(/^[A-Za-z0-9_-]{16,43}$/);

export const PushEvent = z.object({ k: z.enum(PUSH_KINDS), id: z.string().regex(/^[0-9a-f-]{36}$/), exp: z.number().int().positive(), c: CapId, m: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).strict();
export type PushEvent = z.infer<typeof PushEvent>;

/** Device → relay, signed by the device identity key (so only that device can change its own registration). */
export const PushRegister = z.object({ op: z.literal('register'), device: Key, platform: z.enum(['fcm', 'apns', 'apns-voip']), token: z.string().min(16).max(4096), topic: z.string().max(200).optional(), ts: z.number().int(), nonce: Nonce, sig: Sig }).strict();
export const PushGrant = z.object({ op: z.literal('grant'), device: Key, capId: CapId, capHash: z.string().regex(/^[0-9a-f]{64}$/), ts: z.number().int(), nonce: Nonce, sig: Sig }).strict();
export const PushRevoke = z.object({ op: z.literal('revoke'), device: Key, capId: CapId.nullable(), ts: z.number().int(), nonce: Nonce, sig: Sig }).strict();
/** Sender → relay: authorised by the capability secret alone (the relay never learns who is calling whom). */
export const PushNotify = z.object({ op: z.literal('notify'), cap: Key, event: PushEvent }).strict();
export type PushRegister = z.infer<typeof PushRegister>;
export type PushGrant = z.infer<typeof PushGrant>;
export type PushRevoke = z.infer<typeof PushRevoke>;
export type PushNotify = z.infer<typeof PushNotify>;

/** Bytes a device signs for register/grant/revoke (everything except the signature). */
export const pushStatement = (o: Record<string, unknown>) => {
  const { sig: _s, ...rest } = o;
  return new TextEncoder().encode(['clan-push/v1', ...Object.keys(rest).sort().map((k) => `${k}=${rest[k] === null ? '' : String(rest[k])}`)].join('|'));
};
export const capHash = (cap: string) => Array.from(sha256(b64u.decode(cap)), (x) => x.toString(16).padStart(2, '0')).join('');
export const pushMac = (macKey: string, e: Omit<PushEvent, 'm'>) =>
  b64u.encode(hmac(sha256, b64u.decode(macKey), new TextEncoder().encode(`clan-push-ev/v1|${e.k}|${e.id}|${e.exp}|${e.c}`)).slice(0, 16));
/** Recipient check: genuine (per-friend key), not expired, not absurdly far in the future. */
export function pushEventValid(macKey: string, e: PushEvent, now = Date.now()) {
  if (!PushEvent.safeParse(e).success || e.exp <= now || e.exp > now + PUSH_MAX_TTL_MS + PUSH_SKEW_MS) return false;
  const want = pushMac(macKey, e);
  let diff = want.length ^ e.m.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (e.m.charCodeAt(i) || 0);
  return diff === 0;
}

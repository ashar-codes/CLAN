// Nearby people, friends, private conversations, files, voice notes and calls (Phase 14.3 A+B). Shared vocabulary for
// every device. Identity = the device's Ed25519 key (the same key that proves identity when joining a CLAN); profile
// names are display only. Every envelope is signed end to end by its sender and travels over TLS 1.3 whose certificate
// is bound to the receiver's identity key by `PeerTlsBinding`, so neither discovery nor the network can impersonate a
// person. Discovery adverts carry only a random, rotating id; profiles are released after authentication and only per
// the owner's visibility settings.
import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64u, canonicalBytes, ed25519Verify, keyFingerprint } from './trust.ts';

export const PEER_SERVICE = 'clanpeer';
const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Sig = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Id = z.string().uuid();
const Text = (n: number) => z.string().trim().max(n);

// ---- profiles ----
export const PROFILE_FIELDS = ['university', 'department', 'course', 'interests', 'bio'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
/** Who may see a field: everyone who can see the profile, friends, or nobody (kept on this device). */
export const FieldVisibility = z.enum(['everyone', 'friends', 'nobody']);
export const ProfileView = z.object({
  key: Key, name: Text(80).min(1), avatar: z.object({ sha256: Sha, size: z.number().int().positive().max(512 * 1024), mime: z.enum(['image/png', 'image/jpeg']) }).nullable(),
  university: Text(120).optional(), department: Text(120).optional(), course: Text(120).optional(), interests: z.array(Text(40).min(1)).max(12).optional(), bio: Text(500).optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type ProfileView = z.infer<typeof ProfileView>;
/** A profile signed by its own key (what a peer serves and a QR code points to). */
export const SignedProfile = z.object({ profile: ProfileView, sig: Sig }).strict();
export type SignedProfile = z.infer<typeof SignedProfile>;
export const profileValid = (p: SignedProfile) => SignedProfile.safeParse(p).success && ed25519Verify(p.profile.key, p.profile, p.sig);

// ---- transport binding ----
/** The identity key vouches for the TLS key of its people endpoint (pin = this SPKI; identity = `key`). */
export const PeerTlsBindingBody = z.object({ type: z.literal('clan-peer-tls'), v: z.literal(1), key: Key, spkiSha256: z.string().min(40).max(64), certificate: z.string().max(8192), issuedAt: z.number().int() }).strict();
export const PeerTlsBinding = PeerTlsBindingBody.extend({ sig: Sig }).strict();
export type PeerTlsBinding = z.infer<typeof PeerTlsBinding>;
export const peerBindingValid = (b: PeerTlsBinding) => PeerTlsBinding.safeParse(b).success && ed25519Verify(b.key, (({ sig: _s, ...x }) => x)(b), b.sig);

// ---- discovery ----
/** mDNS TXT: version + random id that changes at least hourly and with every visibility change. No names, no keys. */
export const PeerAdvert = z.object({ v: z.literal('1'), r: z.string().regex(/^[A-Za-z0-9_-]{16,24}$/) });
export type PeerAdvert = z.infer<typeof PeerAdvert>;
export const Visibility = z.enum(['everyone', 'friends', 'invisible']);
export type Visibility = z.infer<typeof Visibility>;

// ---- request authentication (on top of the bound TLS) ----
export const PEER_SKEW_MS = 120_000;
export const peerRequestStatement = (o: { method: string; path: string; ts: number; nonce: string; bodySha: string; key: string; to: string }) =>
  new TextEncoder().encode(['clan-peer-req/v1', o.method.toUpperCase(), o.path, o.ts, o.nonce, o.bodySha, o.key, o.to].join('|'));
export const bodySha = (body: string | Uint8Array) => b64u.encode(sha256(typeof body === 'string' ? new TextEncoder().encode(body) : body));

// ---- envelopes (signed end to end; replay-protected by id) ----
export const CHAT_MODES = ['permanent', 'temporary'] as const;
export const TEMP_TTLS = [3_600_000, 86_400_000, 7 * 86_400_000] as const; // 1 h, 24 h, 7 days
export const FILE_MAX = 2 * 1024 * 1024 * 1024; // 2 GiB per direct transfer
export const VOICE_MAX = 10 * 1024 * 1024; // 10 MiB per voice note (~10 min Opus)
export const VOICE_MIME = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac'] as const;
const FileMeta = z.object({ transferId: Id, name: Text(255).min(1).refine((n) => !/[\\/\0]/.test(n), 'bad name'), mime: Text(120), size: z.number().int().positive().max(FILE_MAX), sha256: Sha,
  retention: z.enum(['temporary', 'permanent']), voice: z.object({ durationMs: z.number().int().positive().max(15 * 60_000) }).optional() }).strict();
export type FileMeta = z.infer<typeof FileMeta>;

export const PeerBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('friend.request'), note: Text(200).optional() }).strict(),
  z.object({ kind: z.literal('friend.accept') }).strict(),
  z.object({ kind: z.literal('friend.reject') }).strict(),
  z.object({ kind: z.literal('friend.cancel') }).strict(),
  z.object({ kind: z.literal('friend.remove') }).strict(),
  z.object({ kind: z.literal('chat.invite'), mode: z.enum(CHAT_MODES), ttlMs: z.number().int().refine((n) => (TEMP_TTLS as readonly number[]).includes(n)).nullable() }).strict(),
  z.object({ kind: z.literal('chat.accept'), mode: z.enum(CHAT_MODES), ttlMs: z.number().int().nullable() }).strict(),
  z.object({ kind: z.literal('chat.decline') }).strict(),
  z.object({ kind: z.literal('chat.end') }).strict(),
  z.object({ kind: z.literal('msg.text'), msgId: Id, text: z.string().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal('msg.read'), upTo: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('file.offer'), msgId: Id, file: FileMeta }).strict(),
  z.object({ kind: z.literal('file.accept'), transferId: Id }).strict(),
  z.object({ kind: z.literal('file.decline'), transferId: Id }).strict(),
  z.object({ kind: z.literal('file.cancel'), transferId: Id }).strict(),
  z.object({ kind: z.literal('call.invite'), callId: Id, sdp: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal('call.answer'), callId: Id, sdp: z.string().max(20_000) }).strict(),
  z.object({ kind: z.literal('call.ice'), callId: Id, candidate: z.string().max(2000), mid: z.string().max(64).nullable(), index: z.number().int().min(0).max(64).nullable() }).strict(),
  z.object({ kind: z.literal('call.reject'), callId: Id, reason: z.enum(['declined', 'busy', 'unavailable']) }).strict(),
  z.object({ kind: z.literal('call.end'), callId: Id, reason: z.enum(['hangup', 'timeout', 'failed', 'cancelled']) }).strict(),
]);
export type PeerBody = z.infer<typeof PeerBody>;
export type PeerKind = PeerBody['kind'];
/** Signaling for calls is live-only: never queued, refused when stale. */
export const LIVE_KINDS: ReadonlySet<PeerKind> = new Set(['call.invite', 'call.answer', 'call.ice', 'call.reject', 'call.end']);
export const LIVE_MAX_AGE_MS = 60_000;

export const PeerEnvelopeBody = z.object({ type: z.literal('clan-peer-msg'), v: z.literal(1), id: Id, from: Key, to: Key, at: z.number().int().nonnegative(), body: PeerBody }).strict();
export const PeerEnvelope = PeerEnvelopeBody.extend({ sig: Sig }).strict();
export type PeerEnvelope = z.infer<typeof PeerEnvelope>;
export type PeerSigner = { publicKey: string; sign(bytes: Uint8Array): string };
export const signEnvelope = (s: PeerSigner, o: { id: string; to: string; at: number; body: PeerBody }): PeerEnvelope => {
  const body = { type: 'clan-peer-msg' as const, v: 1 as const, id: o.id, from: s.publicKey, to: o.to, at: o.at, body: o.body };
  return { ...body, sig: s.sign(canonicalBytes(body)) };
};
export const envelopeValid = (e: PeerEnvelope) => { const { sig, ...b } = e; return ed25519Verify(e.from, b, sig); };
export const signProfile = (s: PeerSigner, profile: ProfileView): SignedProfile => ({ profile, sig: s.sign(canonicalBytes(profile)) });

/** Conversation id both sides derive from the two identity keys (order independent). */
export const conversationId = (a: string, b: string) => {
  const h = b64u.encode(sha256(new TextEncoder().encode(['clan-dm/v1', ...[a, b].sort()].join('|'))));
  const hex = Array.from(b64u.decode(h).slice(0, 16), (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// ---- QR (static profile / invitation) ----
/** `clan://p/<key>?h=<host:port>&s=<spki>&n=<name>` — the key and certificate pin make a scanned connection verified. */
export const profileQr = (o: { key: string; endpoints: string[]; spkiSha256: string; name: string }) =>
  `clan://p/${o.key}?${new URLSearchParams([...o.endpoints.slice(0, 3).map((e) => ['h', e] as [string, string]), ['s', o.spkiSha256], ['n', o.name.slice(0, 40)]]).toString()}`;
export function parseProfileQr(text: string): { key: string; endpoints: string[]; spkiSha256: string; name: string } | null {
  const m = /^clan:\/\/p\/([A-Za-z0-9_-]{43})\?(.*)$/.exec(text.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[2]);
  const endpoints = q.getAll('h').filter((h) => /^[0-9.]{7,15}:\d{2,5}$/.test(h)).slice(0, 3), s = q.get('s') ?? '';
  if (!endpoints.length || !/^[A-Za-z0-9+/=_-]{40,64}$/.test(s)) return null;
  return { key: m[1]!, endpoints, spkiSha256: s, name: (q.get('n') ?? '').slice(0, 40) };
}
/** Short fingerprint people compare to verify each other in person. */
export const safetyNumber = (a: string, b: string) => {
  const h = sha256(new TextEncoder().encode(['clan-safety/v1', ...[keyFingerprint(a), keyFingerprint(b)].sort()].join('|')));
  return Array.from(h.slice(0, 10), (x) => String(x % 100).padStart(2, '0')).join('').match(/.{5}/g)!.join(' ');
};

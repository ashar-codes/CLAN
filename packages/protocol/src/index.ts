// Wire protocol shared by teacher server, desktop, mobile and the load simulator.
// Every inbound message is parsed with these schemas at the trust boundary.
import { z } from 'zod';
import type { ClanCapability, ClanType } from './clan.ts';
import type { SealedDirect } from './direct.ts';
import { ChatClientMessage, type ChatServerMessage } from './chat.ts';

export const PRODUCT_NAME = 'CLAN';
/**
 * Legacy internal identifiers kept for compatibility (see docs/MODULES.md › Legacy names). Never shown to users.
 * The desktop's OS-level storage identity (Keychain item "<name> Safe Storage" and the userData folder) derives from the
 * app name at startup; renaming it would orphan existing data and make every stored key undecryptable (verified).
 */
export const LEGACY_STORAGE_NAME = 'Classroom LAN';
export const PROTOCOL_VERSION = 1;
/** mDNS/DNS-SD service type. The join code is deliberately NOT advertised. */
export const SERVICE_TYPE = 'classroomlan';

export const JoinCode = z.string().regex(/^\d{6}$/, 'Join code must be 6 digits');

const name = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Control characters are not allowed');

/** Raw 32-byte Ed25519 public key, base64url without padding. */
export const PublicKeyB64 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid public key');
const b64url = (min: number, max: number) => z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+$/);

/** The device's public key is the identity; names are display only. */
export const StudentProfile = z.object({
  fullName: name(80),
  rollNo: name(40),
  deviceName: name(60),
  devicePublicKey: PublicKeyB64,
});
export type StudentProfile = z.infer<typeof StudentProfile>;

// ---- Pairing (bootstrap listener, plaintext HTTP, protected by OPAQUE) — see docs/PAIRING_AND_TRUST.md ----
export const PairStart = z.object({ v: z.literal(PROTOCOL_VERSION), sessionId: z.uuid(), startLoginRequest: b64url(1, 4096) });
export const PairFinish = z.object({ v: z.literal(PROTOCOL_VERSION), pairingId: z.uuid(), finishLoginRequest: b64url(1, 4096) });
export type PairStartResponse = { pairingId: string; loginResponse: string };
export const PairAbort = z.object({ v: z.literal(PROTOCOL_VERSION), pairingId: z.uuid() });

/** Sent by the server after OPAQUE succeeds; authenticated with HMAC under a key derived from the OPAQUE session key. */
export type TlsBinding = {
  type: 'classroom-lan/tls-binding'; v: 1;
  sessionId: string; pairingId: string; title: string;
  httpsPort: number;
  /** base64 SHA-256 of the server leaf certificate's DER SubjectPublicKeyInfo (the pin). */
  spkiSha256: string;
  /** The per-session CA certificate, base64 DER; clients trust exactly this CA (and then check the pin). */
  certificate: string;
  teacherPublicKey: string;
  /** Fresh nonce the device must sign to prove key possession. */
  challenge: string;
  issuedAt: number; expiresAt: number;
};
/** `direct`: sealed Direct-network package (only when the host runs a Direct network). */
export type PairFinishResponse = { binding: TlsBinding; mac: string; direct?: SealedDirect };

// ---- Join / reconnect (HTTPS only) ----
export const JoinRequest = z.object({
  v: z.literal(PROTOCOL_VERSION),
  pairingId: z.uuid(),
  profile: StudentProfile,
  proof: z.object({ mac: b64url(43, 43), signature: b64url(86, 86) }),
});
export type JoinRequest = z.infer<typeof JoinRequest>;
/** Signed by the device key and MACed with the OPAQUE-derived join key. Canonical JSON (RFC 8785). */
export type JoinProofPayload = {
  type: 'classroom-lan/join-proof'; v: 1;
  sessionId: string; pairingId: string; challenge: string; deviceKeyFingerprint: string;
  fullName: string; rollNo: string; deviceName: string;
};
export const ReconnectChallengeRequest = z.object({ v: z.literal(PROTOCOL_VERSION), devicePublicKey: PublicKeyB64 });
export type ReconnectChallengeResponse = { challengeId: string; challenge: string; expiresAt: number };
export const ReconnectRequest = z.object({ v: z.literal(PROTOCOL_VERSION), challengeId: z.uuid(), devicePublicKey: PublicKeyB64, signature: b64url(86, 86) });
export type ReconnectProofPayload = { type: 'classroom-lan/reconnect-proof'; v: 1; sessionId: string; challengeId: string; challenge: string; deviceKeyFingerprint: string };

export const MemberStatus = z.enum(['pending', 'approved', 'rejected', 'removed', 'blocked']);
export type MemberStatus = z.infer<typeof MemberStatus>;

export const JoinPolicy = z.enum(['approval', 'known', 'open']);
export type JoinPolicy = z.infer<typeof JoinPolicy>;

export type JoinResponse = { memberId: string; token: string; status: MemberStatus; classroom: ClassroomInfo };

/** Physical connectivity (how devices reach each other). Direct and mesh are interfaces only for now. */
export type Connectivity = 'lan' | 'direct' | 'mesh_experimental';

/** Live CLAN session state (historical name). */
export type ClassroomInfo = {
  sessionId: string;
  title: string;
  /** Canonical CLAN this session belongs to, and its type. */
  clanId: string | null;
  clanType: ClanType;
  /** Host's canonical display name (sent only to paired members). */
  hostName: string | null;
  description: string;
  /** Temporary CLANs end at this time (null = no expiry). */
  expiresAt: number | null;
  connectivity: Connectivity;
  /** Data plane: teacher only (false) or peer-assisted (true). The control plane is always the teacher. */
  peerAssist: boolean;
  /** Member↔member reachability measured on this network (never assumed). 'isolated' disables peer assistance. */
  p2p: 'unknown' | 'available' | 'isolated';
  locked: boolean;
  joinPolicy: JoinPolicy;
  startedAt: number;
  ended: boolean;
};

/** first = never approved before in this course; known = this exact device key was approved before;
 *  new_device = this roll number was approved before but from a different device key; legacy = pre-2.5 record. */
export type DeviceTrust = 'first' | 'known' | 'new_device' | 'legacy';

export type Member = {
  id: string;
  /** SHA-256 fingerprint of the device public key (base64url). */
  deviceFingerprint: string;
  trust: DeviceTrust;
  fullName: string;
  rollNo: string;
  deviceName: string;
  status: MemberStatus;
  connected: boolean;
  joinedAt: number;
  lastSeen: number;
  /** CLAN-scoped chat handle (direct messages, send-to-one). */
  handle?: string;
};

export type TimelineEvent = { id: number; ts: number; type: string; actor: string | null; data: Record<string, unknown> };

/** TXT record published over DNS-SD. */
/** Who is presenting what. Window titles and frames are never part of it. */
export type PresentationView = { id: string; presenter: 'host' | string; presenterName: string; source: 'screen' | 'window'; audio: boolean; startedAt: number; state: 'live' | 'reconnecting' };
export type MediaJoin = { url: string; token: string; identity: string; expiresAt: number };

/** DNS-SD TXT. Untrusted hint only: name + type, nothing else before pairing. */
export type Advertisement = { v: string; sid: string; title: string; type?: string };

// ---- Files & assignments ----
export const TransferState = z.enum(['not_started', 'queued', 'downloading', 'paused', 'verifying', 'completed', 'failed']);
export type TransferState = z.infer<typeof TransferState>;

export type ResourceView = {
  id: string; name: string; size: number; sha256: string | null; mime: string; addedAt: number;
  status: 'importing' | 'ready' | 'failed'; available: boolean; pushed: boolean;
  /** Set when the file was sent to specific CLANmates only (never on the shared table). */
  direct?: { from: string };
};
export type StudentTransfer = { memberId: string; fullName: string; state: TransferState; bytes: number; updatedAt: number | null };
export type TeacherResourceView = ResourceView & { counts: Record<TransferState, number>; students: StudentTransfer[] };
export type TransferStats = {
  activeDownloads: number; activeUploads: number; bytesPerSec: number; servedBytes: number; failedDownloads: number;
  /** Data plane (peer-assisted): registered serving peers and what they report having uploaded. */
  peers: number; peerUploadedBytes: number; peerBytesPerSec: number;
};

export const AssignmentInput = z.object({
  title: z.string().trim().min(1).max(120),
  instructions: z.string().max(5000).default(''),
  dueAt: z.number().int().positive().nullable().default(null),
  // Lower-case extensions without the dot; empty = any type.
  allowedExtensions: z.array(z.string().trim().toLowerCase().transform((e) => e.replace(/^\./, '')).pipe(z.string().regex(/^[a-z0-9]{1,10}$/))).max(30).default([]),
  maxBytes: z.number().int().positive(),
  mode: z.enum(['individual', 'group']).default('individual'),
});
export type AssignmentInput = z.input<typeof AssignmentInput>;

export type AssignmentView = {
  id: string; title: string; instructions: string; dueAt: number | null; allowedExtensions: string[];
  maxBytes: number; mode: 'individual' | 'group'; createdAt: number; closed: boolean;
};

/** Immutable receipt content signed by the teacher's Ed25519 key over its RFC 8785 canonical JSON. */
export type ReceiptPayload = {
  type: 'classroom-lan/receipt'; v: 1;
  receiptId: string; submissionId: string; assignmentId: string; assignmentTitle: string;
  /** In this model a classroom run is a session; courseTitle groups sessions of the same class. */
  sessionId: string; courseTitle: string;
  memberId: string; studentKeyFingerprint: string; fullName: string; rollNo: string;
  version: number; submittedAt: number; late: boolean; fileName: string; size: number; sha256: string; status: 'accepted';
  teacherKeyFingerprint: string;
};
export type Receipt = { payload: ReceiptPayload; alg: 'Ed25519'; signature: string; teacherPublicKey: string };
export type StudentAssignmentView = AssignmentView & { latest: Receipt | null };
export type SubmissionState = 'submitted' | 'late' | 'missing' | 'uploading' | 'failed';
export type StudentSubmissionRow = {
  memberId: string; fullName: string; rollNo: string; state: SubmissionState;
  submissionId: string | null; submittedAt: number | null; fileName: string | null; size: number | null; version: number | null;
};
export type TeacherAssignmentView = AssignmentView & { counts: Record<SubmissionState, number>; students: StudentSubmissionRow[] };

export const UploadInit = z.object({
  assignmentId: z.uuid(),
  fileName: z.string().min(1).max(255),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Generated once per intended submission; retries reuse it so the server never creates duplicates. */
  idempotencyKey: z.uuid(),
});
export type UploadInit = z.infer<typeof UploadInit>;
export type UploadStatus = { uploadId: string; offset: number; size: number; state: 'uploading' | 'complete' | 'failed'; receipt: Receipt | null; error: string | null };
/** A member sharing a file: same resumable upload protocol as submissions; the host turns it into a CLAN resource for
 * everyone (`to: 'clan'`) or for one CLANmate only (their chat handle). */
export const ShareUploadInit = z.object({
  fileName: z.string().min(1).max(255),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.uuid(),
  to: z.union([z.literal('clan'), z.string().regex(/^[A-Za-z0-9_-]{22}$/)]),
});
export type ShareUploadInit = z.infer<typeof ShareUploadInit>;
export type ShareUploadStatus = Omit<UploadStatus, 'receipt'> & { resource: ResourceView | null };
export const UPLOAD_CONTENT_TYPE = 'application/offset+octet-stream';

/**
 * Filesystem-safe name for display names that came from someone else. Never use the result as more than
 * a single path segment; callers still join it under a directory they own.
 */
export function safeFileName(name: string, maxBytes = 120): string {
  let n = String(name).slice(0, 1024).normalize('NFC');
  n = n.split(/[\\/]/).pop() ?? '';
  // Control chars, Windows-forbidden chars and bidi overrides (e.g. "invoice\u202Efdp.exe").
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_');
  n = n.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  const dot = n.lastIndexOf('.');
  let base = dot > 0 ? n.slice(0, dot) : n;
  let ext = dot > 0 ? n.slice(dot) : '';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `_${base}`;
  if (!base) base = 'file';
  if (new TextEncoder().encode(ext).length > 16) ext = '';
  const enc = new TextEncoder();
  while (enc.encode(base + ext).length > maxBytes) base = Array.from(base).slice(0, -1).join('');
  return base + ext;
}

export const extensionOf = (name: string) => { const n = safeFileName(name); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };

// ---- WebSocket: client -> server ----
const id = z.string().min(1).max(64);
export const ClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('auth'), token: z.string().min(16).max(128) }),
  z.object({ t: z.literal('ping'), n: z.number().int() }),
  // teacher-only (enforced server-side)
  z.object({ t: z.literal('member.approve'), memberId: id }),
  z.object({ t: z.literal('member.reject'), memberId: id }),
  z.object({ t: z.literal('member.remove'), memberId: id }),
  z.object({ t: z.literal('member.block'), memberId: id }),
  z.object({ t: z.literal('class.lock'), locked: z.boolean() }),
  z.object({ t: z.literal('class.policy'), policy: JoinPolicy }),
  z.object({ t: z.literal('class.end') }),
  z.object({ t: z.literal('resource.available'), resourceId: id, available: z.boolean() }),
  z.object({ t: z.literal('resource.remove'), resourceId: id }),
  z.object({ t: z.literal('resource.push'), resourceId: id }),
  z.object({ t: z.literal('assignment.create'), assignment: AssignmentInput }),
  z.object({ t: z.literal('assignment.close'), assignmentId: id }),
  z.object({ t: z.literal('class.peerAssist'), enabled: z.boolean() }),
  // student
  z.object({ t: z.literal('transfer.state'), resourceId: id, state: TransferState, bytes: z.number().int().nonnegative() }),
  // presentation (screen sharing) — authority checked server-side per capability; see MESSAGE_CAPABILITY
  z.object({ t: z.literal('present.request') }),
  z.object({ t: z.literal('present.approve'), memberId: id }),
  z.object({ t: z.literal('present.decline'), memberId: id }),
  z.object({ t: z.literal('present.policy'), policy: z.enum(['open', 'request']) }),
  z.object({ t: z.literal('present.start'), source: z.enum(['screen', 'window']), audio: z.boolean(), takeover: z.boolean().optional() }),
  z.object({ t: z.literal('present.source'), source: z.enum(['screen', 'window']), audio: z.boolean() }),
  z.object({ t: z.literal('present.stop'), presentationId: id.optional() }),
  z.object({ t: z.literal('peer.probeResult'), probeId: id, tried: z.number().int().min(0).max(8), reachable: z.number().int().min(0).max(8) }),
  // chat (capability-checked server-side: SEND_MESSAGE; attachments SEND_FILES/SHARE_RESOURCE)
  ...ChatClientMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export const TEACHER_ONLY: ReadonlySet<ClientMessage['t']> = new Set([
  'member.approve', 'member.reject', 'member.remove', 'member.block', 'class.lock', 'class.policy', 'class.end',
  'resource.available', 'resource.remove', 'resource.push', 'assignment.create', 'assignment.close', 'class.peerAssist',
]);
export const STUDENT_ONLY: ReadonlySet<ClientMessage['t']> = new Set(['transfer.state', 'peer.probeResult']);

// ---- WebSocket: server -> client ----
export type ServerMessage =
  /** `role` keeps its legacy wire values: 'teacher' = host, 'student' = member. */
  | { t: 'hello'; role: 'teacher' | 'student'; memberId: string | null; status: MemberStatus | null; classroom: ClassroomInfo; serverTime: number; capabilities: ClanCapability[] }
  /** Member-visible roster for CLANs that grant VIEW_MEMBERS: names + CLAN-scoped chat handles (never device keys or ids). */
  | { t: 'members'; members: { name: string; host: boolean; connected: boolean; handle: string }[]; me: string }
  | { t: 'pong'; n: number; serverTime: number }
  | { t: 'class.state'; classroom: ClassroomInfo }
  | { t: 'roster'; members: Member[] }
  | { t: 'timeline'; events: TimelineEvent[] }
  | { t: 'member.status'; status: MemberStatus }
  | { t: 'resources'; resources: ResourceView[] | TeacherResourceView[] }
  | { t: 'resource.push'; resourceId: string }
  /** Teacher asks a few healthy peers to fetch a large resource early so the swarm forms quickly. */
  | { t: 'resource.seed'; resourceId: string }
  /** Devices no longer authorized; peers must refuse them immediately. */
  | { t: 'peer.revoked'; fingerprints: string[] }
  /** Host asks a member to test plain TCP reachability of other members' peer servers (topology probe). */
  | { t: 'peer.probe'; probeId: string; targets: string[] }
  /** Presentation control state (never media). `requests` only reaches principals with MANAGE_PRESENTERS. */
  | { t: 'presentation'; state: PresentationView | null; policy: 'open' | 'request'; requests: { memberId: string; name: string }[]; mine: 'none' | 'requested' | 'approved' }
  | { t: 'assignments'; assignments: StudentAssignmentView[] | TeacherAssignmentView[] }
  | { t: 'stats'; stats: TransferStats }
  | { t: 'error'; code: string; message: string }
  | ChatServerMessage;

export const WS_CLOSE = { authFailed: 4001, removed: 4003, ended: 4004, badMessage: 4400 } as const;

export * from './trust.ts';
export * from './peer.ts';
export * from './network.ts';
export * from './clan.ts';
export * from './direct.ts';
export * from './chat.ts';
export * from './intake.ts';

// Wire protocol shared by teacher server, desktop, mobile and the load simulator.
// Every inbound message is parsed with these schemas at the trust boundary.
import { z } from 'zod';

export const PRODUCT_NAME = 'Classroom LAN';
export const PROTOCOL_VERSION = 1;
/** mDNS/DNS-SD service type. The join code is deliberately NOT advertised. */
export const SERVICE_TYPE = 'classroomlan';

export const JoinCode = z.string().regex(/^\d{6}$/, 'Join code must be 6 digits');

const name = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'Control characters are not allowed');

export const StudentProfile = z.object({
  fullName: name(80),
  rollNo: name(40),
  deviceName: name(60),
  deviceId: z.uuid(),
});
export type StudentProfile = z.infer<typeof StudentProfile>;

export const JoinRequest = z.object({ code: JoinCode, profile: StudentProfile, protocol: z.literal(PROTOCOL_VERSION) });
export type JoinRequest = z.infer<typeof JoinRequest>;

export const MemberStatus = z.enum(['pending', 'approved', 'rejected', 'removed', 'blocked']);
export type MemberStatus = z.infer<typeof MemberStatus>;

export const JoinPolicy = z.enum(['approval', 'known', 'open']);
export type JoinPolicy = z.infer<typeof JoinPolicy>;

export type JoinResponse = { memberId: string; token: string; status: MemberStatus; classroom: ClassroomInfo };

export type ClassroomInfo = {
  sessionId: string;
  title: string;
  locked: boolean;
  joinPolicy: JoinPolicy;
  startedAt: number;
  ended: boolean;
};

export type Member = {
  id: string;
  deviceId: string;
  fullName: string;
  rollNo: string;
  deviceName: string;
  status: MemberStatus;
  connected: boolean;
  joinedAt: number;
  lastSeen: number;
};

export type TimelineEvent = { id: number; ts: number; type: string; actor: string | null; data: Record<string, unknown> };

/** TXT record published over DNS-SD. */
export type Advertisement = { v: string; sid: string; title: string };

// ---- Files & assignments ----
export const TransferState = z.enum(['not_started', 'queued', 'downloading', 'paused', 'verifying', 'completed', 'failed']);
export type TransferState = z.infer<typeof TransferState>;

export type ResourceView = {
  id: string; name: string; size: number; sha256: string | null; mime: string; addedAt: number;
  status: 'importing' | 'ready' | 'failed'; available: boolean; pushed: boolean;
};
export type StudentTransfer = { memberId: string; fullName: string; state: TransferState; bytes: number; updatedAt: number | null };
export type TeacherResourceView = ResourceView & { counts: Record<TransferState, number>; students: StudentTransfer[] };
export type TransferStats = { activeDownloads: number; activeUploads: number; bytesPerSec: number; servedBytes: number; failedDownloads: number };

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

/** Issued by the teacher server; teacher time is authoritative. */
export type Receipt = {
  submissionId: string; assignmentId: string; assignmentTitle: string; sessionId: string; classTitle: string;
  memberId: string; deviceId: string; fullName: string; rollNo: string;
  version: number; submittedAt: number; late: boolean; fileName: string; size: number; sha256: string; status: 'accepted';
};
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
  // student
  z.object({ t: z.literal('transfer.state'), resourceId: id, state: TransferState, bytes: z.number().int().nonnegative() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export const TEACHER_ONLY: ReadonlySet<ClientMessage['t']> = new Set([
  'member.approve', 'member.reject', 'member.remove', 'member.block', 'class.lock', 'class.policy', 'class.end',
  'resource.available', 'resource.remove', 'resource.push', 'assignment.create', 'assignment.close',
]);
export const STUDENT_ONLY: ReadonlySet<ClientMessage['t']> = new Set(['transfer.state']);

// ---- WebSocket: server -> client ----
export type ServerMessage =
  | { t: 'hello'; role: 'teacher' | 'student'; memberId: string | null; status: MemberStatus | null; classroom: ClassroomInfo; serverTime: number }
  | { t: 'pong'; n: number; serverTime: number }
  | { t: 'class.state'; classroom: ClassroomInfo }
  | { t: 'roster'; members: Member[] }
  | { t: 'timeline'; events: TimelineEvent[] }
  | { t: 'member.status'; status: MemberStatus }
  | { t: 'resources'; resources: ResourceView[] | TeacherResourceView[] }
  | { t: 'resource.push'; resourceId: string }
  | { t: 'assignments'; assignments: StudentAssignmentView[] | TeacherAssignmentView[] }
  | { t: 'stats'; stats: TransferStats }
  | { t: 'error'; code: string; message: string };

export const WS_CLOSE = { authFailed: 4001, removed: 4003, ended: 4004, badMessage: 4400 } as const;

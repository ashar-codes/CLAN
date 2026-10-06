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
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export const TEACHER_ONLY: ReadonlySet<ClientMessage['t']> = new Set([
  'member.approve', 'member.reject', 'member.remove', 'member.block', 'class.lock', 'class.policy', 'class.end',
]);

// ---- WebSocket: server -> client ----
export type ServerMessage =
  | { t: 'hello'; role: 'teacher' | 'student'; memberId: string | null; status: MemberStatus | null; classroom: ClassroomInfo; serverTime: number }
  | { t: 'pong'; n: number; serverTime: number }
  | { t: 'class.state'; classroom: ClassroomInfo }
  | { t: 'roster'; members: Member[] }
  | { t: 'timeline'; events: TimelineEvent[] }
  | { t: 'member.status'; status: MemberStatus }
  | { t: 'error'; code: string; message: string };

export const WS_CLOSE = { authFailed: 4001, removed: 4003, ended: 4004, badMessage: 4400 } as const;

// CLAN vocabulary shared by every host and client. Security decisions use capabilities, never a CLAN type name or the
// word "teacher". The host (authority) is the device that runs the session and signs authority data; legacy wire names
// (`role: 'teacher'`, `teacherPublicKey`, `classroom-lan/*` types) are kept for compatibility (docs/PROTOCOL.md).
import { z } from 'zod';
import type { ClientMessage, JoinPolicy } from './index.ts';

/** Joinable CLAN types. Personal Space is deliberately not one: it can never be hosted or joined. */
export const ClanType = z.enum(['CLASSROOM', 'STUDY_GROUP', 'PROJECT_TEAM', 'FRIENDS', 'TEMPORARY']);
export type ClanType = z.infer<typeof ClanType>;

export const ClanCapability = z.enum([
  'MANAGE_CLAN', 'APPROVE_MEMBERS', 'REMOVE_MEMBERS', 'SHARE_RESOURCE', 'SEND_MESSAGE', 'CREATE_ASSIGNMENT',
  'SUBMIT_ASSIGNMENT', 'PRESENT', 'MANAGE_PERMISSIONS', 'VIEW_MEMBERS',
]);
export type ClanCapability = z.infer<typeof ClanCapability>;
export type ClanRole = 'host' | 'member';

const HOST: ClanCapability[] = ['MANAGE_CLAN', 'APPROVE_MEMBERS', 'REMOVE_MEMBERS', 'SHARE_RESOURCE', 'SEND_MESSAGE', 'PRESENT', 'MANAGE_PERMISSIONS', 'VIEW_MEMBERS'];
/** Defaults per type. Only the host may ever hold authority capabilities; members never get them by default. */
const DEFAULTS: Record<ClanType, Record<ClanRole, readonly ClanCapability[]>> = {
  CLASSROOM: { host: [...HOST, 'CREATE_ASSIGNMENT'], member: ['SEND_MESSAGE', 'SUBMIT_ASSIGNMENT'] },
  STUDY_GROUP: { host: HOST, member: ['SEND_MESSAGE', 'PRESENT', 'VIEW_MEMBERS'] },
  PROJECT_TEAM: { host: HOST, member: ['SEND_MESSAGE', 'PRESENT', 'VIEW_MEMBERS'] },
  FRIENDS: { host: HOST, member: ['SEND_MESSAGE', 'VIEW_MEMBERS'] },
  TEMPORARY: { host: HOST, member: ['SEND_MESSAGE', 'VIEW_MEMBERS'] },
};
export const capabilitiesFor = (type: ClanType, role: ClanRole): readonly ClanCapability[] => DEFAULTS[type][role];

/** Which capability each host-side control message needs (enforced by the host server). */
export const MESSAGE_CAPABILITY: Partial<Record<ClientMessage['t'], ClanCapability>> = {
  'member.approve': 'APPROVE_MEMBERS', 'member.reject': 'APPROVE_MEMBERS', 'member.remove': 'REMOVE_MEMBERS', 'member.block': 'REMOVE_MEMBERS',
  'class.lock': 'MANAGE_CLAN', 'class.policy': 'MANAGE_PERMISSIONS', 'class.end': 'MANAGE_CLAN', 'class.peerAssist': 'MANAGE_CLAN',
  'resource.available': 'SHARE_RESOURCE', 'resource.remove': 'SHARE_RESOURCE', 'resource.push': 'SHARE_RESOURCE',
  'assignment.create': 'CREATE_ASSIGNMENT', 'assignment.close': 'CREATE_ASSIGNMENT',
};

/** Generic join policy names ↔ stored legacy values (sessions.join_policy). */
export const JOIN_POLICY = { APPROVAL_REQUIRED: 'approval', KNOWN_MEMBERS_AUTO_APPROVED: 'known', CODE_ONLY: 'open' } as const satisfies Record<string, JoinPolicy>;

/** Product wording only. Never used for authorization. */
export function clanLabels(type: ClanType) {
  const classroom = type === 'CLASSROOM';
  return {
    type: { CLASSROOM: 'Classroom', STUDY_GROUP: 'Study group', PROJECT_TEAM: 'Project team', FRIENDS: 'Friends', TEMPORARY: 'Temporary' }[type],
    host: classroom ? 'Teacher' : type === 'PROJECT_TEAM' ? 'Owner' : 'Host',
    member: classroom ? 'Student' : 'Member', members: classroom ? 'Students' : 'Members', session: classroom ? 'class' : 'CLAN',
    policy: {
      approval: classroom ? 'Approve every student' : 'Approve every member',
      known: classroom ? 'Auto-approve known students' : 'Auto-approve known members',
      open: 'Anyone with the code',
    } satisfies Record<JoinPolicy, string>,
  };
}

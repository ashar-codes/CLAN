// Classroom network modes (Milestone 2.75). Two independent axes, so features never care which carries their data:
//   connectivity — how devices reach each other (existing LAN today; Windows Direct in M3; mesh is research only)
//   distribution — who serves official data (teacher only, or teacher + authenticated peers)
// The CONTROL PLANE (approvals, permissions, official resources/assignments, lock, end) is always the teacher.
import type { ClassroomInfo, Connectivity } from './index.ts';

export type Distribution = 'teacher' | 'peer_assisted';
export type ClassroomNetworkMode = { connectivity: Connectivity; distribution: Distribution };

/** Named presets used in docs/UI. */
export type ModeName = 'TEACHER_SERVER' | 'LAN' | 'PEER_ASSISTED' | 'DIRECT' | 'MESH_EXPERIMENTAL';
export const MODES: Record<ModeName, ClassroomNetworkMode & { status: 'implemented' | 'interface-only' | 'research' }> = {
  TEACHER_SERVER: { connectivity: 'lan', distribution: 'teacher', status: 'implemented' },
  LAN: { connectivity: 'lan', distribution: 'teacher', status: 'implemented' },
  PEER_ASSISTED: { connectivity: 'lan', distribution: 'peer_assisted', status: 'implemented' },
  DIRECT: { connectivity: 'direct', distribution: 'teacher', status: 'interface-only' }, // Milestone 3; either distribution once it exists
  MESH_EXPERIMENTAL: { connectivity: 'mesh_experimental', distribution: 'teacher', status: 'research' }, // docs/MESH_MODE.md
};

export const modeOf = (i: Pick<ClassroomInfo, 'connectivity' | 'peerAssist'>): ClassroomNetworkMode =>
  ({ connectivity: i.connectivity, distribution: i.peerAssist ? 'peer_assisted' : 'teacher' });

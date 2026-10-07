// 3D is optional: import types freely, load scenes lazily (`React.lazy(loadCommons)`); every screen has a 2D fallback.
import type { BeaconState, CLANmateSpec } from '@clan/design';

export type NearbyPersonViewModel = { id: string; name: string; spec: CLANmateSpec; beacon: BeaconState; distance: 'here' | 'near' | 'far' };
/** Every dimension means something: floors = lectures (solid = attended), lit windows = people studying it now,
 *  kiosks = shared resources, paths = prerequisite links, column = term. */
export type CourseBuildingViewModel = {
  id: string; code: string; name: string; color: string; term: number;
  lectures: { id: string; title: string; done: boolean }[]; studyingNow: number; resources: number; prerequisites: string[];
};

export const loadCommons = () => import('./commons.tsx');
export const loadCampus = () => import('./campus.tsx');
export function webglAvailable() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') ?? c.getContext('webgl')); } catch { return false; }
}

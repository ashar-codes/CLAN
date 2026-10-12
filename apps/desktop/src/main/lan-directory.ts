// Shared discovery hints for classroom Radar; OPAQUE/pinned joining remains the only source of authority.
import type { DiscoveredClassroom } from '@classroom/server/discovery';
let hosted: DiscoveredClassroom | null = null, found: DiscoveredClassroom[] = [], expires = 0;
const listeners = new Set<() => void>();
export const setDirectoryHost = (value: DiscoveredClassroom | null) => { hosted = value; };
export const directoryHost = () => hosted;
export const directoryClassrooms = () => Date.now() < expires ? found : [];
export const onDirectoryClassrooms = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export function setDirectoryClassrooms(list: DiscoveredClassroom[], until: number) { found = list; expires = until; for (const f of listeners) f(); }

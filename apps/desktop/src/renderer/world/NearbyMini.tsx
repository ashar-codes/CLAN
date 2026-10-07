import { CLANBeacon } from '@clan/design';
import type { NearbyClan } from './Commons.tsx';
const LABEL: Record<string, string> = { CLASSROOM: 'Classroom', STUDY_GROUP: 'Study group', PROJECT_TEAM: 'Project team', FRIENDS: 'Friends', TEMPORARY: 'Temporary' };
/** Compact list of live CLANs (untrusted discovery names; the code decides). */
export function NearbyMini({ list, onJoin }: { list: NearbyClan[]; onJoin(): void }) {
  if (!list.length) return <p className="muted">No CLAN sessions on this network right now.</p>;
  return <>{list.map((n) => <div key={n.sid} className="line"><span><CLANBeacon state="available" size={16} /> {n.title} <span className="muted">· {LABEL[n.type] ?? 'CLAN'}</span></span><button className="small" onClick={onJoin}>Join</button></div>)}</>;
}

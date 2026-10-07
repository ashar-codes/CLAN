// Commons: what is live around you right now. Discovery tells us which CLAN sessions are on this network (an untrusted
// hint) — not who is in them, so people appear inside CLAN rooms, where presence is real. Positions are decorative.
import { ClanPlace, type PlaceType } from '@clan/design';
import type { Experience } from './experience.ts';

export type NearbyClan = { sid: string; title: string; type: string };
const TYPES = ['CLASSROOM', 'STUDY_GROUP', 'PROJECT_TEAM', 'FRIENDS', 'TEMPORARY'];
const LABEL: Record<string, string> = { CLASSROOM: 'Classroom', STUDY_GROUP: 'Study group', PROJECT_TEAM: 'Project team', FRIENDS: 'Friends', TEMPORARY: 'Temporary' };

export function Commons({ nearby, experience, onJoin, onCreate }: { nearby: NearbyClan[]; experience: Experience; onJoin(): void; onCreate(): void }) {
  return (
    <div className="commons">
      <header className="page-head">
        <div><span className="eyebrow">Commons</span><h1 className="title world">Who’s around</h1>
          <p className="muted">CLANs running on this network right now. Joining always needs the host’s six-digit code.</p></div>
        <div className="row"><button className="primary" onClick={onJoin}>Join by Code</button><button onClick={onCreate}>Start one here</button></div>
      </header>
      {nearby.length === 0 ? (
        <div className="plaza empty" role="status">
          {experience !== 'minimal' && <svg viewBox="0 0 600 220" aria-hidden className="plaza-art">
            <ellipse cx="300" cy="170" rx="280" ry="46" fill="var(--floor)" /><circle cx="300" cy="150" r="34" fill="var(--paper-2)" stroke="var(--line)" strokeWidth="4" />
            <path d="M120 150c0-40 18-60 18-60s18 20 18 60z M450 150c0-46 20-68 20-68s20 22 20 68z" fill="var(--campus)" opacity=".75" />
            <path d="M136 150v24M470 150v24" stroke="var(--wood-dark)" strokeWidth="6" />
          </svg>}
          <p><b>The Commons is quiet.</b> When someone starts a CLAN on this network it appears here.</p>
        </div>
      ) : (
        <div className={`plaza ${experience === 'minimal' ? 'flat' : ''}`} role="list" aria-label="Nearby CLANs">
          {nearby.map((n, i) => (
            <article key={n.sid} role="listitem" className="plaza-spot" style={{ ['--i' as string]: i }}>
              {experience !== 'minimal' && <ClanPlace type={(TYPES.includes(n.type) ? n.type : 'CLASSROOM') as PlaceType} members={0} files={0} live title={n.title} />}
              <div className="row between"><span><b>{n.title}</b><br /><small className="muted">{LABEL[n.type] ?? 'CLAN'} · live now</small></span>
                <button className="small" onClick={onJoin} aria-label={`Join ${n.title}`}>Join</button></div>
            </article>
          ))}
        </div>
      )}
      <p className="muted small-text people-note">People show up as CLANmates inside a CLAN once you’ve joined it — CLAN never shows where anyone physically is.</p>
    </div>
  );
}

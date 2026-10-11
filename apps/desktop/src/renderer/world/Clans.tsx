// My CLANs as places, and the CLAN room for a CLAN that isn't live right now (members, files, shared work).
import { useCallback, useState } from 'react';
import { ClanPlace, mateFor, RoomStage } from '@clan/design';
import type { ClanDetail, ClanPlaceView, ClanType } from '../../shared.ts';
import { api } from '../App.tsx';
import { errText, useLoad } from './useLoad.ts';
import type { Experience } from './experience.ts';
import { NearbyMini } from './NearbyMini.tsx';
import { HostingPanel } from './HostingPanel.tsx';
import type { NearbyClan } from './Commons.tsx';

export const TYPE_LABEL: Record<ClanType, string> = { CLASSROOM: 'Classroom', STUDY_GROUP: 'Study group', PROJECT_TEAM: 'Project team', FRIENDS: 'Friends', TEMPORARY: 'Temporary' };
const KIND = (m: string) => (/pdf/.test(m) ? 'pdf' : /image/.test(m) ? 'img' : /video/.test(m) ? 'video' : /zip|compressed/.test(m) ? 'zip' : 'file');
type Rehost = { clanId: string; name: string; type: ClanType };

export function Clans({ experience, nearby, onCreate, onJoin, onRehost }: { experience: Experience; nearby: NearbyClan[]; onCreate(t?: ClanType): void; onJoin(): void; onRehost(r: Rehost): void }) {
  const [places, reload] = useLoad<ClanPlaceView[]>(api.clan.places);
  const [archived, reloadArchived] = useLoad(api.clan.archived);
  const [copies, reloadCopies] = useLoad(api.clan.storedCopies);
  const [pending, reloadPending] = useLoad(api.clan.pendingCleanup);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState(''), [retrying, setRetrying] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => { reload(); reloadArchived(); reloadPending(); reloadCopies(); };
  if (open) return <ClanRoomView id={open} experience={experience} onBack={(message) => { setOpen(null); setNotice(message ?? ''); refresh(); }} onRehost={onRehost} />;
  return (
    <div className="stack">
      {notice && <p role="status">{notice}</p>}
      {!!pending?.length && <section className="card" aria-label="Pending CLAN cleanup"><h2>Cleanup pending</h2><p>These CLANs stay unavailable until cleanup finishes. Personal study data is retained.</p>{pending.map((item) => <div className="row between" key={item.id}><span>{item.name}</span><button disabled={retrying === item.id} onClick={() => { setRetrying(item.id); void api.clan.cleanup(item.id, item.kind).then((result) => { setNotice(`Cleanup finished. ${result.retained} modified or shared download copies retained.`); refresh(); }, (e) => setErr(errText(e))).finally(() => setRetrying(null)); }}>Retry cleanup</button></div>)}</section>}
      <header className="page-head">
        <div><span className="eyebrow">Your places</span><h1 className="title world">My CLANs</h1></div>
        <div className="row"><button className="primary" onClick={() => onCreate('STUDY_GROUP')}>Create CLAN</button><button onClick={onJoin}>Join by Code</button></div>
      </header>
      <div className="type-chips" aria-label="Start a CLAN of type">{(['CLASSROOM', 'STUDY_GROUP', 'PROJECT_TEAM', 'FRIENDS', 'TEMPORARY'] as const).map((t) => <button key={t} className={`chip-btn t-${t}`} onClick={() => onCreate(t)}>+ {TYPE_LABEL[t]}</button>)}</div>
      <section aria-label="My CLANs"><span className="eyebrow">My CLANs</span>
        <div className="place-grid">
          {places?.map((p) => (
            <button key={p.id} className={`card clan-card place-card t-${p.type}`} onClick={() => setOpen(p.id)}>
              {experience !== 'minimal' && <ClanPlace type={p.type} members={p.members} files={p.files} title={p.name} />}
              <span className="eyebrow">{TYPE_LABEL[p.type]}</span><b>{p.name}</b>
              <span className="muted small-text">{p.members} member{p.members === 1 ? '' : 's'} · {p.files} file{p.files === 1 ? '' : 's'}{p.host ? ` · host ${p.host}` : ''}{p.expiresAt ? ` · until ${new Date(p.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
            </button>
          ))}
          {places?.length === 0 && <div className="empty-place"><b>No CLANs yet.</b><span className="muted">Start a study group, or join one with its six-digit code.</span></div>}
        </div>
      </section>
      {!!archived?.length && <section className="card" aria-label="Archived CLANs"><span className="eyebrow">Archived on this device</span><p className="muted">Your files and membership are retained.</p>{archived.map((clan) => <div key={clan.id} className="row between"><button onClick={() => setOpen(clan.id)}>{clan.name}</button><button onClick={() => { setErr(''); void api.clan.archiveLocal(clan.id, false).then(refresh, (e) => setErr(errText(e))); }}>Restore</button></div>)}</section>}
      {!!copies?.filter((clan) => !places?.some((p) => p.id === clan.id) && !archived?.some((p) => p.id === clan.id)).length && <section className="card" aria-label="Stored CLAN copies"><h2>Stored copies · left or ended</h2><p>These copies do not restore membership or access to a live room.</p>{copies.filter((clan) => !places?.some((p) => p.id === clan.id) && !archived?.some((p) => p.id === clan.id)).map((clan) => <div key={clan.id} className="row between"><span>{clan.name}</span><button disabled={!!retrying} onClick={() => {
        if (!confirm((clan.mine ? 'This may be the only copy. Delete this CLAN’s history and hosting authority?' : 'Remove this CLAN’s stored history and verified downloads? Remote revocation cannot be confirmed here.') + ' Personal study data, Course files, exports, edited and unknown legacy downloads stay. End any live session first. Failures stay pending for retry.')) return;
        setRetrying(clan.id); setErr(''); void api.clan.cleanup(clan.id, clan.mine ? 'delete' : 'remove').then((result) => setNotice(`Cleanup finished. ${result.retained} modified or shared copies retained.`), (e) => setErr(errText(e))).finally(() => { setRetrying(null); refresh(); });
      }}>{clan.mine ? 'Delete CLAN' : 'Remove copy'}</button></div>)}</section>}
      {err && <p role="alert">{err}</p>}
      <section className="card"><span className="eyebrow">Nearby CLANs</span><NearbyMini list={nearby} onJoin={onJoin} /></section>
    </div>
  );
}

const TABS = ['Overview', 'Files', 'Members', 'Notes', 'Saved', 'Chat', 'Tasks'] as const;
const FUTURE = new Set(['Tasks']);

function ClanRoomView({ id, experience, onBack, onRehost }: { id: string; experience: Experience; onBack(message?: string): void; onRehost(r: Rehost): void }) {
  const [d] = useLoad<ClanDetail>(useCallback(() => api.clan.detail(id), [id]));
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const [archiveConfirm, setArchiveConfirm] = useState(false), [archiveError, setArchiveError] = useState('');
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [cleanupConfirm, setCleanupConfirm] = useState(false), [cleaning, setCleaning] = useState(false);
  if (!d) return null;
  const host = d.members.find((m) => m.role === 'owner');
  return (
    <div className="stack room-page">
      <button className="link back" onClick={() => onBack()}>← CLANs</button>
      <div className="row between"><div><span className="eyebrow">{TYPE_LABEL[d.clan.type]}{d.sessions ? ` · ${d.sessions} session${d.sessions === 1 ? '' : 's'}` : ''}</span>
        <h1 className="title world">{d.clan.name}</h1></div>
        {d.mine && d.clan.type !== 'TEMPORARY' && <button className="primary" onClick={() => onRehost({ clanId: d.clan.id, name: d.clan.name, type: d.clan.type })}>Host again</button>}</div>
      {experience !== 'minimal' && (
        <RoomStage
          wall={<div className="wall-msg"><b>Not live right now</b><span>{d.mine ? 'Host again to open the room — the wall will show your code, and later your screen or a whiteboard.' : 'When the host opens the room, join with their code.'}</span></div>}
          people={d.members.map((m) => ({ id: m.userId, name: m.name, spec: mateFor(m.name), beacon: 'away', host: m.role === 'owner' }))}
          items={d.files.map((f) => ({ id: f.refId, name: f.name, kind: KIND(f.mime) }))} dropLabel="Files shared in this CLAN appear on the table" />
      )}
      <div className="room-tabs" role="tablist">{TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} disabled={FUTURE.has(t)} title={FUTURE.has(t) ? 'Coming in a later update' : undefined} onClick={() => setTab(t)}>{t}{FUTURE.has(t) && <small> · soon</small>}</button>)}</div>
      <section className="card panel-body">
        {tab === 'Overview' && <dl className="kv"><dt>Host</dt><dd>{host?.name ?? '—'}</dd><dt>Members</dt><dd>{d.members.length}</dd><dt>Files</dt><dd>{d.files.length}</dd><dt>Sessions held</dt><dd>{d.sessions}</dd><dt>Type</dt><dd>{TYPE_LABEL[d.clan.type]}</dd></dl>}
        {tab === 'Files' && (d.files.length ? d.files.map((f) => <div key={f.refId} className="line">{f.name}<span className="muted c-num">{(f.size / 1e6).toFixed(1)} MB</span></div>) : <p className="muted">No files yet.</p>)}
        {tab === 'Members' && d.members.map((m) => <div key={m.userId} className="line">{m.name}<span className="muted">{m.role === 'owner' ? 'host' : m.role}</span></div>)}
        {tab === 'Notes' && (d.notes.length ? d.notes.map((n) => <div key={n.id} className="line">{n.title}<span className="muted">{n.mine ? 'yours' : ''}</span></div>) : <p className="muted">Share a note from Study.</p>)}
        {tab === 'Chat' && <OfflineChat clanId={d.clan.id} />}
        {tab === 'Saved' && (d.saved.length ? d.saved.map((s) => <a key={s.id} className="line" href={s.url} target="_blank" rel="noreferrer noopener">{s.title}<span className="muted">{s.source}</span></a>) : <p className="muted">Share a link from Saved.</p>)}
      </section>
      <HostingPanel clanId={d.clan.id} />
      <section className="card"><button onClick={() => setArchiveConfirm(true)}>Archive on this device</button>{archiveConfirm && <div role="group" aria-label="Confirm archive"><p>Hide this CLAN from My CLANs on this device? Files and membership remain available in Archived CLANs.</p><div className="row"><button onClick={() => { void api.clan.archiveLocal(id, true).then(() => onBack(), (e) => setArchiveError(errText(e))); }}>Confirm archive</button><button onClick={() => setArchiveConfirm(false)}>Cancel</button></div></div>}{archiveError && <p role="alert">{archiveError}</p>}</section>
      {!d.mine && <section className="card"><button onClick={() => setLeaveConfirm(true)}>Leave CLAN</button>{leaveConfirm && <div role="group" aria-label="Confirm leave"><p>Leave this CLAN on this device? Personal study data and stored copies stay. This offline action cannot confirm that the host revoked your session. Join again through the host's current approval policy.</p><div className="row"><button onClick={() => { void api.clan.leaveLocal(id).then(() => onBack(), (e) => setArchiveError(errText(e))); }}>Confirm leave</button><button onClick={() => setLeaveConfirm(false)}>Cancel</button></div></div>}</section>}
      <section className="card"><button disabled={cleaning} onClick={() => setCleanupConfirm(true)}>{d.mine ? 'Delete CLAN from this device' : 'Remove CLAN copy from this device'}</button>{cleanupConfirm && <div role="group" aria-label="Confirm CLAN cleanup">
        <p>{d.mine ? 'This device may hold the only copy. Delete its CLAN history and shared files, and remove its hosting authority? Offline copies on other devices remain.' : 'Remove this device’s CLAN chat, boards, shared references and verified downloads, and leave its local membership? Remote revocation cannot be confirmed here.'}</p>
        <p>Personal study data, files used by your Courses, exported and edited files stay. Older downloads without recorded ownership may remain. End any live session first. Once confirmed, failures stay pending and can be retried.</p>
        <div className="row"><button disabled={cleaning} onClick={() => { setCleaning(true); setArchiveError(''); void api.clan.cleanup(id, d.mine ? 'delete' : 'remove').then((result) => onBack(`CLAN cleanup finished. ${result.retained} modified or shared download copies retained.`), (e) => setArchiveError(errText(e))).finally(() => setCleaning(false)); }}>{cleaning ? 'Removing…' : d.mine ? 'Confirm delete' : 'Confirm remove'}</button><button disabled={cleaning} onClick={() => setCleanupConfirm(false)}>Cancel</button></div>
      </div>}</section>
    </div>
  );
}

/** The CLAN's conversations as this device last saw them (read-only while the CLAN isn't live). */
function OfflineChat({ clanId }: { clanId: string }) {
  const [threads] = useLoad(useCallback(() => api.chat.local(clanId), [clanId]));
  const [open, setOpen] = useState<string | null>(null);
  const [msgs] = useLoad(useCallback(() => (open ? api.chat.localPage(open) : Promise.resolve([])), [open]));
  if (!threads?.length) return <p className="muted">No conversation on this device yet. Chat happens in the live room.</p>;
  return (
    <div className="stack">
      <div className="row wrap">{threads.map((t) => <button key={t.id} className={open === t.id ? 'small on' : 'small'} onClick={() => setOpen(t.id)}>{t.kind === 'group' ? 'Everyone' : t.with?.name}{t.unread ? ` · ${t.unread}` : ''}</button>)}</div>
      {open && <div className="chat-log offline" role="log" aria-label="Earlier messages">{msgs?.map((m) => <p key={m.id} className="line"><b>{m.authorName}</b> {m.removed ? <i className="muted">removed</i> : m.body || (m.attachment?.kind === 'file' ? `▤ ${m.attachment.name}` : m.attachment?.kind === 'link' ? `↗ ${m.attachment.title}` : '')}<span className="muted small-text">{new Date(m.createdAt).toLocaleString()}</span></p>)}</div>}
      <p className="muted small-text">Read-only here. When the host opens the room again, the conversation continues where it left off.</p>
    </div>
  );
}

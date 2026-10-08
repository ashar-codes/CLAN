// My CLANs as places, and the CLAN room for a CLAN that isn't live right now (members, files, shared work).
import { useCallback, useState } from 'react';
import { ClanPlace, mateFor, RoomStage } from '@clan/design';
import type { ClanDetail, ClanPlaceView, ClanType } from '../../shared.ts';
import { api } from '../App.tsx';
import { useLoad } from './useLoad.ts';
import type { Experience } from './experience.ts';
import { NearbyMini } from './NearbyMini.tsx';
import type { NearbyClan } from './Commons.tsx';

export const TYPE_LABEL: Record<ClanType, string> = { CLASSROOM: 'Classroom', STUDY_GROUP: 'Study group', PROJECT_TEAM: 'Project team', FRIENDS: 'Friends', TEMPORARY: 'Temporary' };
const KIND = (m: string) => (/pdf/.test(m) ? 'pdf' : /image/.test(m) ? 'img' : /video/.test(m) ? 'video' : /zip|compressed/.test(m) ? 'zip' : 'file');
type Rehost = { clanId: string; name: string; type: ClanType };

export function Clans({ experience, nearby, onCreate, onJoin, onRehost }: { experience: Experience; nearby: NearbyClan[]; onCreate(t?: ClanType): void; onJoin(): void; onRehost(r: Rehost): void }) {
  const [places] = useLoad<ClanPlaceView[]>(api.clan.places);
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <ClanRoomView id={open} experience={experience} onBack={() => setOpen(null)} onRehost={onRehost} />;
  return (
    <div className="stack">
      <header className="page-head">
        <div><span className="eyebrow">Your places</span><h1 className="title world">CLANs</h1></div>
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
      <section className="card"><span className="eyebrow">Nearby CLANs</span><NearbyMini list={nearby} onJoin={onJoin} /></section>
    </div>
  );
}

const TABS = ['Overview', 'Files', 'Members', 'Notes', 'Saved', 'Chat', 'Tasks'] as const;
const FUTURE = new Set(['Tasks']);

function ClanRoomView({ id, experience, onBack, onRehost }: { id: string; experience: Experience; onBack(): void; onRehost(r: Rehost): void }) {
  const [d] = useLoad<ClanDetail>(useCallback(() => api.clan.detail(id), [id]));
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  if (!d) return null;
  const host = d.members.find((m) => m.role === 'owner');
  return (
    <div className="stack room-page">
      <button className="link back" onClick={onBack}>← CLANs</button>
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

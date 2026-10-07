import { useEffect, useRef, useState } from 'react';
import { ClassroomConnection, formatBytes, recommendDistribution, type Quality } from '@classroom/client';
import { clanLabels, shortFingerprint, type ClanCapability, type ClanType, type ClassroomInfo, type JoinPolicy, type Member, type TeacherAssignmentView, type TeacherResourceView, type TimelineEvent, type TransferStats } from '@classroom/protocol';
import { TeacherAssignments, TeacherFiles } from './Files.tsx';
import type { Capabilities, PastClass, StartedClassroom } from '../shared.ts';
import { api } from './App.tsx';

const POLICY_ORDER: JoinPolicy[] = ['approval', 'known', 'open'];
const TYPES: ClanType[] = ['CLASSROOM', 'STUDY_GROUP', 'PROJECT_TEAM', 'FRIENDS', 'TEMPORARY'];
const PLACEHOLDER: Record<ClanType, string> = { CLASSROOM: 'Operating Systems', STUDY_GROUP: 'OS study group', PROJECT_TEAM: 'Project Alpha', FRIENDS: 'Weekend crew', TEMPORARY: 'Library study session' };

/** Create CLAN: one flow for every type; the host device runs the session. */
export function TeacherSetup({ caps, onBack, onStarted, initialType = 'CLASSROOM' }: { caps: Capabilities; onBack(): void; onStarted(s: StartedClassroom): void; initialType?: ClanType }) {
  const [type, setType] = useState<ClanType>(initialType);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [hours, setHours] = useState(2);
  const [policy, setPolicy] = useState<JoinPolicy>('approval');
  const L = clanLabels(type);
  const [host, setHost] = useState(caps.interfaces[0]?.address ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const noNetwork = caps.interfaces.length === 0;

  const start = async () => {
    setBusy(true); setError('');
    try { onStarted(await api.startClassroom({ title: title.trim(), policy, host: host || undefined, type, description: description.trim(), hours: type === 'TEMPORARY' ? hours : undefined })); }
    catch (e) { setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  };

  return (
    <main className="center narrow">
      <button className="link back" onClick={onBack}>← Back</button>
      <h2>{type === 'CLASSROOM' ? 'Create Classroom' : 'Create CLAN'}</h2>
      <div className="seg-types" role="radiogroup" aria-label="CLAN type">
        {TYPES.map((t) => <button key={t} role="radio" aria-checked={type === t} className={type === t ? 'on small' : 'small'} onClick={() => setType(t)}>{clanLabels(t).type}</button>)}
      </div>
      <label>{type === 'CLASSROOM' ? 'Class name' : 'Name'}<input autoFocus value={title} maxLength={80} placeholder={PLACEHOLDER[type]} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Description <span className="muted">(optional, shown only after joining)</span><input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} /></label>
      {type === 'TEMPORARY' && <label>Ends after<select value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[0.5, 1, 2, 3, 4, 8].map((h) => <option key={h} value={h}>{h < 1 ? '30 minutes' : `${h} hour${h > 1 ? 's' : ''}`}</option>)}</select></label>}

      <fieldset>
        <legend>Network</legend>
        <label className="radio"><input type="radio" checked readOnly /> <span><b>Use existing network</b><br /><small className="muted">University Wi-Fi, a router or Ethernet. Internet is not needed.</small></span></label>
        <label className="radio disabled"><input type="radio" disabled /> <span><b>Direct Mode</b> — create a classroom Wi-Fi<br /><small className="muted">{caps.directMode.reason}</small></span></label>
      </fieldset>

      <label>Who can join<select value={policy} onChange={(e) => setPolicy(e.target.value as JoinPolicy)}>{POLICY_ORDER.map((p) => <option key={p} value={p}>{L.policy[p]}</option>)}</select></label>

      {caps.interfaces.length > 1 && (
        <details><summary className="muted">Advanced: network adapter</summary>
          <select value={host} onChange={(e) => setHost(e.target.value)}>{caps.interfaces.map((i) => <option key={i.address} value={i.address}>{i.name} ({i.address})</option>)}</select>
        </details>
      )}
      {noNetwork && <p className="error">This computer isn't connected to any network. Join the classroom Wi-Fi or plug in a cable, then come back.</p>}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={!title.trim() || busy || noNetwork} onClick={start}>{busy ? 'Starting…' : type === 'CLASSROOM' ? 'Start Classroom' : 'Start CLAN'}</button>
      {type === 'CLASSROOM' && <PastClasses />}
    </main>
  );
}

function PastClasses() {
  const [list, setList] = useState<PastClass[]>([]);
  useEffect(() => { api.pastClasses().then(setList); }, []);
  const withData = list.filter((c) => c.files || c.submissions);
  if (!withData.length) return null;
  return (
    <details className="past"><summary className="muted">Previous classes ({withData.length}) — saved on this computer</summary>
      <table className="mini"><tbody>{withData.map((c) => (
        <tr key={c.sessionId}><td>{c.title}</td><td className="muted">{new Date(c.startedAt).toLocaleDateString()}</td><td className="muted">{c.files} files · {c.submissions} submissions</td>
          <td>{c.submissions > 0 && <button className="link small" onClick={() => api.revealPastClass(c.sessionId)}>Submissions folder</button>}</td></tr>
      ))}</tbody></table>
    </details>
  );
}

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function describe(e: TimelineEvent, names: Map<string, string>, L: ReturnType<typeof clanLabels>) {
  const who = (e.actor && names.get(e.actor)) || String(e.data.name ?? `A ${L.member.toLowerCase()}`);
  const m: Record<string, string> = {
    'class.started': `${L.session[0]!.toUpperCase()}${L.session.slice(1)} started`, 'class.ended': `${L.session[0]!.toUpperCase()}${L.session.slice(1)} ended`, 'class.locked': 'Joining locked', 'class.unlocked': 'Joining unlocked',
    'class.policy': `Join rule changed to "${L.policy[e.data.policy as JoinPolicy]}"`,
    'member.requested': `${who} asked to join`, 'member.joined': `${who} joined`, 'member.approved': `${who} approved`,
    'member.rejected': `${who} rejected`, 'member.removed': `${who} removed`, 'member.blocked': `${who} blocked`,
    'resource.added': `${e.data.name} added`, 'resource.pushed': `${e.data.name} sent to everyone`, 'resource.removed': `${e.data.name} removed`,
    'resource.hidden': `${e.data.name} hidden`, 'resource.shown': `${e.data.name} made available`,
    'assignment.published': `Assignment "${e.data.title}" published`, 'assignment.closed': 'Assignment closed',
    'submission.accepted': `${who} submitted "${e.data.title}"${e.data.late ? ' (late)' : ''}`,
  };
  return m[e.type] ?? e.type;
}

export function TeacherDashboard({ caps, started, onEnded }: { caps: Capabilities; started: StartedClassroom; onEnded(): void }) {
  const [info, setInfo] = useState<ClassroomInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [quality, setQuality] = useState<Quality>('disconnected');
  const [notice, setNotice] = useState('');
  const [resources, setResources] = useState<TeacherResourceView[]>([]);
  const [assignments, setAssignments] = useState<TeacherAssignmentView[]>([]);
  const [stats, setStats] = useState<TransferStats | null>(null);
  const [can, setCan] = useState<ClanCapability[]>([]);
  const conn = useRef<ClassroomConnection | null>(null);

  useEffect(() => {
    const c = new ClassroomConnection(started.url, started.teacherToken, {
      onMessage: (m) => {
        if (m.t === 'hello') setCan(m.capabilities);
        if (m.t === 'hello' || m.t === 'class.state') setInfo(m.classroom);
        else if (m.t === 'roster') setMembers(m.members);
        else if (m.t === 'timeline') setTimeline(m.events);
        else if (m.t === 'resources') setResources(m.resources as TeacherResourceView[]);
        else if (m.t === 'assignments') setAssignments(m.assignments as TeacherAssignmentView[]);
        else if (m.t === 'stats') setStats(m.stats);
        else if (m.t === 'error') setNotice(m.message);
      },
      onQuality: setQuality,
      onClosed: () => onEnded(),
    });
    conn.current = c;
    return () => c.close();
  }, [started]);

  const send = conn.current?.send.bind(conn.current) ?? (() => {});
  const pending = members.filter((m) => m.status === 'pending');
  const roster = members.filter((m) => m.status === 'approved');
  const gone = members.filter((m) => m.status === 'removed' || m.status === 'blocked' || m.status === 'rejected');
  const names = new Map(members.map((m) => [m.id, m.fullName]));
  const L = clanLabels(info?.clanType ?? 'CLASSROOM');
  const end = async () => { if (confirm(`End this ${L.session} for everyone?`)) { await api.stopClassroom(); onEnded(); } };

  if (!info) return <main className="center"><p className="muted">Starting…</p></main>;
  return (
    <div className="dash">
      <header className="bar">
        <div><h2>{info.title}</h2><span className="muted">{L.type} · you are the {L.host.toLowerCase()} · started {time(info.startedAt)}{info.expiresAt ? ` · ends ${time(info.expiresAt)}` : ''}</span></div>
        <div className="code" aria-label="Join code">{started.code.slice(0, 3)} {started.code.slice(3)}</div>
        <div className="row">
          <label className="toggle"><input type="checkbox" checked={info.locked} onChange={(e) => send({ t: 'class.lock', locked: e.target.checked })} /> Lock joining</label>
          <button className="danger" onClick={end}>End {L.session}</button>
        </div>
      </header>
      {notice && <p className="error" onClick={() => setNotice('')}>{notice}</p>}

      <section className="grid">
        <TeacherFiles resources={resources} stats={stats} send={send} />
        {can.includes('CREATE_ASSIGNMENT') && <TeacherAssignments assignments={assignments} send={send} />}
        <div className="card">
          <h3>Waiting to join {pending.length > 0 && <span className="badge">{pending.length}</span>}</h3>
          {pending.length === 0 && <p className="muted">{L.members} enter <b>{started.code}</b> in the CLAN app on the same network.</p>}
          {pending.map((m) => (
            <div key={m.id} className="person">
              <Who m={m} />
              <div className="row">
                <button className="primary small" onClick={() => send({ t: 'member.approve', memberId: m.id })}>Approve</button>
                <button className="small" onClick={() => send({ t: 'member.reject', memberId: m.id })}>Reject</button>
              </div>
            </div>
          ))}
          {pending.length > 1 && <button className="link" onClick={() => pending.forEach((m) => send({ t: 'member.approve', memberId: m.id }))}>Approve all {pending.length}</button>}
        </div>

        <div className="card">
          <h3>{L.members} ({roster.filter((m) => m.connected).length}/{roster.length} connected)</h3>
          {roster.length === 0 && <p className="muted">No one has joined yet.</p>}
          {roster.map((m) => (
            <div key={m.id} className="person">
              <Who m={m} />
              <div className="row">
                <button className="small" onClick={() => send({ t: 'member.remove', memberId: m.id })}>Remove</button>
                <button className="small danger" onClick={() => confirm(`Block ${m.fullName}'s device from this ${L.session}?`) && send({ t: 'member.block', memberId: m.id })}>Block</button>
              </div>
            </div>
          ))}
          {gone.length > 0 && <details><summary className="muted">Removed / blocked / rejected ({gone.length})</summary>{gone.map((m) => <div key={m.id} className="person"><Who m={m} /><span className="muted">{m.status}</span></div>)}</details>}
        </div>

        <div className="card">
          <h3>Settings</h3>
          <label>Who can join<select value={info.joinPolicy} onChange={(e) => send({ t: 'class.policy', policy: e.target.value as JoinPolicy })}>{POLICY_ORDER.map((p) => <option key={p} value={p}>{L.policy[p]}</option>)}</select></label>
          <h3>Network</h3>
          <dl className="kv">
            <dt>Connectivity</dt><dd>Existing LAN</dd>
            <dt>Distribution</dt><dd data-testid="distribution">{info.peerAssist ? 'Peer Assistance ON' : `${L.host} only`} <button className="small" data-testid="peer-assist-toggle" onClick={() => send({ t: 'class.peerAssist', enabled: !info.peerAssist })}>{info.peerAssist ? 'Disable Peer Assistance' : 'Enable Peer Assistance'}</button></dd>
            <dt>{L.members}</dt><dd>{roster.length}</dd>
            <dt>Resource sources</dt><dd data-testid="sources">{L.host}{info.peerAssist ? ` + ${stats?.peers ?? 0} peers` : ''}</dd>
            <dt>{L.host} upload</dt><dd>{formatBytes(stats?.bytesPerSec ?? 0)}/s · <span data-testid="teacher-served">{formatBytes(stats?.servedBytes ?? 0)}</span> total</dd>
            {info.peerAssist && <><dt>Peer upload</dt><dd>{formatBytes(stats?.peerBytesPerSec ?? 0)}/s · {formatBytes(stats?.peerUploadedBytes ?? 0)} total</dd></>}
            <dt>Health</dt><dd>{quality === 'disconnected' ? 'Server not responding' : (stats?.failedDownloads ?? 0) > 5 ? 'Fair (some transfers failed)' : 'Good'}</dd>
          </dl>
          {(() => { const r = recommendDistribution({ students: roster.length, largestResourceBytes: Math.max(0, ...resources.map((x) => x.size)), teacherBytesPerSec: stats?.bytesPerSec || undefined });
            return r.peerAssist !== info.peerAssist && roster.length > 0 ? <p className="muted small-text">Suggestion (experimental): {r.peerAssist ? 'turn Peer Assistance on' : 'teacher-only is enough'} — {r.reason}</p> : null; })()}
          <h3>Server</h3>
          <dl className="kv">
            <dt>Adapter</dt><dd>{started.iface}</dd>
            <dt>Address</dt><dd>{started.url.replace('http://', '')}</dd>
            <dt>Server</dt><dd><span className={`dot ${quality}`} /> {quality === 'disconnected' ? 'Not responding' : 'Running'}</dd>
            <dt>System</dt><dd>{caps.platform}</dd>
          </dl>
        </div>

        <div className="card">
          <h3>Timeline</h3>
          <ol className="timeline">{timeline.map((e) => <li key={e.id}><time>{time(e.ts)}</time> {describe(e, names, L)}</li>)}</ol>
        </div>
      </section>
    </div>
  );
}

const TRUST: Record<Member['trust'], string> = { known: 'Known device ✓', new_device: 'New device for this roll number', first: 'First time', legacy: '' };

function Who({ m }: { m: Member }) {
  return (
    <div>
      <b>{m.fullName}</b> <span className="muted">{m.rollNo}</span> {TRUST[m.trust] && <span className={`trust ${m.trust}`} title={`Device key ${shortFingerprint(m.deviceFingerprint)}`}>{TRUST[m.trust]}</span>}<br />
      <small className="muted"><span className={`dot ${m.connected ? 'excellent' : 'disconnected'}`} /> {m.deviceName} · {m.connected ? 'Connected' : 'Disconnected'}</small>
    </div>
  );
}

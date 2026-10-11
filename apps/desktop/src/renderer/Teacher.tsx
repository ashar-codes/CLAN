import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ClassroomConnection, formatBytes, recommendDistribution, type Quality } from '@classroom/client';
import { clanLabels, shortFingerprint, type ClanCapability, type ClanType, type ClassroomInfo, type JoinPolicy, type Member, type TeacherAssignmentView, type TeacherResourceView, type TimelineEvent, type TransferStats, type PendingShare, type FileSharingPolicy } from '@classroom/protocol';
import { TeacherAssignments, TeacherFiles } from './Files.tsx';
import type { Capabilities, DirectAvailability, DirectStatus, PastClass, StartedClassroom } from '../shared.ts';
import { api } from './App.tsx';
import { HostRoom } from './world/LiveRoom.tsx';
import { RoomSurface, usePresentation, type PresentationMsg } from './world/Presentation.tsx';
import { useBoard } from './world/board/useBoard.ts';
import { BoardControls, WallBoard } from './world/board/RoomBoard.tsx';
import { RoomPresentation } from './world/RoomPresentation.tsx';
import { useExperience } from './world/experience.ts';
import { useChat } from './world/chat/useChat.ts';
import { personSender } from './world/chat/send.ts';

const ChatPanel = lazy(() => import('./world/chat/ChatPanel.tsx'));

const POLICY_ORDER: JoinPolicy[] = ['approval', 'known', 'open'];
const TYPES: ClanType[] = ['CLASSROOM', 'STUDY_GROUP', 'PROJECT_TEAM', 'FRIENDS', 'TEMPORARY'];
const PLACEHOLDER: Record<ClanType, string> = { CLASSROOM: 'Operating Systems', STUDY_GROUP: 'OS study group', PROJECT_TEAM: 'Project Alpha', FRIENDS: 'Weekend crew', TEMPORARY: 'Library study session' };

/** Create CLAN: one flow for every type; the host device runs the session. */
export type Rehost = { clanId: string; name: string; type: ClanType };
export function TeacherSetup({ caps, onBack, onStarted, initialType = 'CLASSROOM', rehost }: { caps: Capabilities; onBack(): void; onStarted(s: StartedClassroom): void; initialType?: ClanType; rehost?: Rehost }) {
  const [type, setType] = useState<ClanType>(rehost?.type ?? initialType);
  const [title, setTitle] = useState(rehost?.name ?? '');
  const [connectivity, setConnectivity] = useState<'lan' | 'direct'>('lan');
  const [distribution, setDistribution] = useState<'host' | 'peer'>('host');
  const [direct, setDirect] = useState<DirectAvailability | null>(null);
  useEffect(() => { api.directAvailability().then(setDirect, () => setDirect(null)); }, []);
  const [description, setDescription] = useState('');
  const [hours, setHours] = useState(2);
  const [policy, setPolicy] = useState<JoinPolicy>('approval');
  const L = clanLabels(type);
  const [host, setHost] = useState(caps.interfaces[0]?.address ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const noNetwork = caps.interfaces.length === 0 && connectivity === 'lan';

  const start = async () => {
    setBusy(true); setError('');
    try { onStarted(await api.startClassroom({ title: title.trim(), policy, host: host || undefined, type, description: description.trim(), hours: type === 'TEMPORARY' ? hours : undefined, clanId: rehost?.clanId, connectivity, distribution })); }
    catch (e) { setError(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    finally { setBusy(false); }
  };

  return (
    <main className="center narrow">
      <button className="link back" onClick={onBack}>← Back</button>
      <h2>{rehost ? `Host ${rehost.name} again` : type === 'CLASSROOM' ? 'Create Classroom' : 'Create CLAN'}</h2>
      {rehost && <p className="muted">Same CLAN, members and files. A new code and secure session are created.</p>}
      {!rehost && <div className="seg-types" role="radiogroup" aria-label="CLAN type">
        {TYPES.map((t) => <button key={t} role="radio" aria-checked={type === t} className={type === t ? 'on small' : 'small'} onClick={() => setType(t)}>{clanLabels(t).type}</button>)}
      </div>}
      {!rehost && <label>{type === 'CLASSROOM' ? 'Class name' : 'Name'}<input autoFocus value={title} maxLength={80} placeholder={PLACEHOLDER[type]} onChange={(e) => setTitle(e.target.value)} /></label>}
      <label>Description <span className="muted">(optional, shown only after joining)</span><input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} /></label>
      {type === 'TEMPORARY' && <label>Ends after<select value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[0.5, 1, 2, 3, 4, 8].map((h) => <option key={h} value={h}>{h < 1 ? '30 minutes' : `${h} hour${h > 1 ? 's' : ''}`}</option>)}</select></label>}

      <fieldset>
        <legend>Connectivity</legend>
        <label className="radio"><input type="radio" name="conn" checked={connectivity === 'lan'} onChange={() => setConnectivity('lan')} /> <span><b>Existing Network</b><br /><small className="muted">Wi-Fi, a router or Ethernet. Internet is not needed.</small></span></label>
        <label className={`radio ${direct?.available ? '' : 'disabled'}`}><input type="radio" name="conn" disabled={!direct?.available} checked={connectivity === 'direct'} onChange={() => setConnectivity('direct')} />
          <span><b>Direct Network</b> — this computer creates the network<br />
            {direct?.available ? <small className="muted">No router or internet needed. Members just enter the code.</small>
              : <small className="muted">Unavailable on this device <details className="inline-why"><summary>Why?</summary>{direct?.reason ?? 'Checking…'}</details></small>}
          </span></label>
        {connectivity === 'direct' && direct?.vpn.length ? <p className="warn small-text">A VPN is active ({direct.vpn.join(', ')}). CLAN keeps Direct traffic on the local network; if members can't connect, pause the VPN.</p> : null}
      </fieldset>
      <fieldset>
        <legend>Distribution</legend>
        <label className="radio"><input type="radio" name="dist" checked={distribution === 'host'} onChange={() => setDistribution('host')} /> <span><b>Host Only</b><br /><small className="muted">Everyone downloads from this computer.</small></span></label>
        <label className="radio"><input type="radio" name="dist" checked={distribution === 'peer'} onChange={() => setDistribution('peer')} /> <span><b>Peer Assisted</b><br /><small className="muted">Members also share verified pieces with each other — only if the network allows it (checked automatically).</small></span></label>
      </fieldset>

      <label>Who can join<select value={policy} onChange={(e) => setPolicy(e.target.value as JoinPolicy)}>{POLICY_ORDER.map((p) => <option key={p} value={p}>{L.policy[p]}</option>)}</select></label>

      {caps.interfaces.length > 1 && (
        <details><summary className="muted">Advanced: network adapter</summary>
          <select value={host} onChange={(e) => setHost(e.target.value)}>{caps.interfaces.map((i) => <option key={i.address} value={i.address}>{i.name} ({i.address})</option>)}</select>
        </details>
      )}
      {noNetwork && <p className="error">This computer isn't connected to any network. Join the classroom Wi-Fi or plug in a cable, then come back.</p>}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={!title.trim() || busy || noNetwork} onClick={start}>{busy ? (connectivity === 'direct' ? 'Creating network…' : 'Starting…') : rehost ? 'Host again' : type === 'CLASSROOM' ? 'Start Classroom' : 'Start CLAN'}</button>
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
    'member.bootstrap': 'A device paired over Bluetooth', 'pairing.throttled': 'Joining paused briefly after many wrong codes', 'network.p2p': e.data.p2p === 'isolated' ? 'Network keeps members apart: Peer Assistance off' : 'Members can reach each other: Peer Assistance available',
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
  const [shared, setShared] = useState('');
  const [pendingShares, setPendingShares] = useState<PendingShare[]>([]);
  const [reviewingShare, setReviewingShare] = useState<string | null>(null);
  const [presMsg, setPresMsg] = useState<PresentationMsg | null>(null);
  const [ask, setAsk] = useState(0);
  const presRef = useRef<ReturnType<typeof usePresentation> | null>(null);
  const experience = useExperience();
  const conn = useRef<ClassroomConnection | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  const [clanId, setClanId] = useState<string | null>(null);
  const chat = useChat({ role: 'host', conn: { url: started.url, token: started.teacherToken, sessionId: sid ?? '00000000-0000-4000-8000-000000000000' }, clanId, send: (m) => conn.current?.send(m) });
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const board = useBoard({ kind: 'live', send: (m) => conn.current?.send(m) }, chat.me ?? 'host');
  const boardRef = useRef(board);
  boardRef.current = board;
  const [dm, setDm] = useState<{ handle: string; n: number } | null>(null);
  const toast = (m: string) => { setShared(m); setTimeout(() => setShared(''), 3000); };
  useEffect(() => api.notify.on((n) => { if (n.threadId !== chatRef.current.active || !document.hasFocus()) toast(`${n.title}: ${n.body}`); }), []);

  useEffect(() => {
    const c = new ClassroomConnection(started.url, started.teacherToken, {
      onMessage: (m) => {
        if (m.t === 'hello') { setSid(m.classroom.sessionId); setClanId(m.classroom.clanId ?? m.classroom.sessionId); boardRef.current.connected(); }
        if (m.t.startsWith('wb.')) return boardRef.current.onServer(m as never);
        chatRef.current.onServer(m);
        if (m.t === 'hello') setCan(m.capabilities);
        if (m.t === 'hello' || m.t === 'class.state') setInfo(m.classroom);
        else if (m.t === 'roster') setMembers(m.members);
        else if (m.t === 'timeline') setTimeline(m.events);
        else if (m.t === 'resources') setResources(m.resources as TeacherResourceView[]);
        else if (m.t === 'assignments') setAssignments(m.assignments as TeacherAssignmentView[]);
        else if (m.t === 'stats') setStats(m.stats);
        else if (m.t === 'presentation') setPresMsg(m);
        else if (m.t === 'error') { if (['presenting', 'whiteboard', 'not_shared'].includes(m.code)) boardRef.current.onServer(m); if (['busy', 'forbidden', 'media_unavailable', 'not_presenting', 'whiteboard'].includes(m.code) && presRef.current) void presRef.current.refused(m.message); else if (!['presenting', 'not_shared'].includes(m.code)) setNotice(m.message); }
      },
      onQuality: setQuality,
      onClosed: () => onEnded(),
    });
    conn.current = c;
    return () => c.close();
  }, [started]);

  const send = conn.current?.send.bind(conn.current) ?? (() => {});
  useEffect(() => {
    if (info?.clanType !== 'CLASSROOM') return;
    let alive = true, busy = false;
    const refresh = async () => {
      if (busy) return; busy = true;
      try { const items = await api.chat.pendingShares(); if (alive) setPendingShares(items); }
      catch (e) { if (alive) setNotice((e as Error).message); }
      finally { busy = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [info?.clanType, started]);
  const reviewShare = async (id: string, accept: boolean) => {
    setReviewingShare(id);
    try { await api.chat.reviewShare(id, accept); setPendingShares(await api.chat.pendingShares()); }
    catch (e) { setNotice((e as Error).message); }
    finally { setReviewingShare(null); }
  };
  const pending = members.filter((m) => m.status === 'pending');
  const roster = members.filter((m) => m.status === 'approved');
  const gone = members.filter((m) => m.status === 'removed' || m.status === 'blocked' || m.status === 'rejected');
  const names = new Map(members.map((m) => [m.id, m.fullName]));
  const L = clanLabels(info?.clanType ?? 'CLASSROOM');
  const pres = usePresentation({ baseUrl: started.url, bearer: started.teacherToken, sessionId: info?.sessionId ?? '00000000-0000-4000-8000-000000000000', msg: presMsg, send: (m) => conn.current?.send(m), me: 'host' });
  presRef.current = pres;
  const end = async () => { if (confirm(`End this ${L.session} for everyone?`)) { await api.stopClassroom(); onEnded(); } };
  const boardNode = board.view?.wall === 'WHITEBOARD' && !pres.live ? <WallBoard board={board} resources={resources as never} title={`${info?.title ?? 'CLAN'} board`} /> : undefined;

  if (!info) return <main className="center"><p className="muted">Starting…</p></main>;
  return (
    <div className="dash">
      <header className="bar">
        <div><h2>{info.title}</h2><span className="muted">{L.type} · you are the {L.host.toLowerCase()} · started {time(info.startedAt)}{info.expiresAt ? ` · ends ${time(info.expiresAt)}` : ''}</span></div>
        {experience === 'minimal' && <div className="code" aria-label="Join code">{started.code.slice(0, 3)} {started.code.slice(3)}</div>}
        <div className="row">
          <label className="toggle"><input type="checkbox" checked={info.locked} onChange={(e) => send({ t: 'class.lock', locked: e.target.checked })} /> Lock joining</label>
          <button className="danger" onClick={end}>End {L.session}</button>
        </div>
      </header>
      {notice && <p className="error" onClick={() => setNotice('')}>{notice}</p>}
      {shared && <div className="toast" role="status">{shared}</div>}
      <RoomPresentation pres={pres} msg={presMsg} send={send} can={can} isHost ask={ask} boardOnWall={board.view?.wall === 'WHITEBOARD'} />
      <BoardControls board={board} pres={pres} send={send} clanType={info.clanType} me={null} />
      {experience === 'minimal' && pres.live && <RoomSurface mode="SCREEN_SHARE" screen={{ pres, live: pres.live }}>{null}</RoomSurface>}
      {experience === 'minimal' && boardNode}
      <div className="room-with-chat">
        {experience !== 'minimal' && <HostRoom kind={info.clanType} board={boardNode} pres={pres} onPresent={() => setAsk((n) => n + 1)} onStopPresenter={() => pres.live && send({ t: 'present.stop', presentationId: pres.live.id })} code={started.code} hostName={info.hostName} members={members} resources={resources} onShared={toast}
          people={personSender(chat, (handle) => setDm({ handle, n: Date.now() }), true)}
          onRemove={(id) => send({ t: 'member.remove', memberId: id })} onBlock={(id) => confirm('Block this device from this ' + L.session + '?') && send({ t: 'member.block', memberId: id })} />}
        <Suspense fallback={<section className="card chat"><p className="muted">Loading chat…</p></section>}>
          <ChatPanel chat={chat} role="host" clanName={info.title} canSendFiles conn={null} request={dm}
            people={roster.filter((m) => m.handle).map((m) => ({ handle: m.handle!, name: m.fullName, host: false, connected: m.connected }))} />
        </Suspense>
      </div>

      <section className="grid">
        <TeacherFiles sessionId={info.sessionId} resources={resources} stats={stats} send={send} />
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
          {info.clanType === 'CLASSROOM' && <>
            <label>Student file sharing<select value={info.fileSharingPolicy ?? 'teacher'} onChange={(e) => send({ t: 'class.filePolicy', policy: e.target.value as FileSharingPolicy })}>
              <option value="teacher">Teacher only</option><option value="approval">Teacher approval</option><option value="everyone">Everyone</option>
            </select></label>
            <h3>Files awaiting approval ({pendingShares.length})</h3>
            {pendingShares.map((f) => <div className="person" key={f.uploadId}>
              <span>{f.memberName} · {f.fileName} · {formatBytes(f.size)}</span>
              <div className="row"><button disabled={!!reviewingShare} onClick={() => void reviewShare(f.uploadId, true)}>Approve file</button><button disabled={!!reviewingShare} onClick={() => void reviewShare(f.uploadId, false)}>Decline file</button></div>
            </div>)}
          </>}
          <h3>Network</h3>
          {started.direct && <DirectCard started={started} />}
          {info.p2p === 'isolated' && <p className="muted small-text" data-testid="p2p-isolated">Peer Assistance unavailable: this network keeps members apart, so files come from you.</p>}
          <dl className="kv">
            <dt>Connectivity</dt><dd>{started.direct ? 'Direct network' : 'Existing network'}</dd>
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

/** Direct host status: plain words up front, details under Diagnostics. */
function DirectCard({ started }: { started: StartedClassroom }) {
  const [st, setSt] = useState<DirectStatus>(null);
  const [qr, setQr] = useState<{ dataUrl: string; expiresAt: number } | null>(null);
  useEffect(() => { const t = setInterval(() => api.directStatus().then(setSt).catch(() => {}), 3000); api.directStatus().then(setSt).catch(() => {}); return () => clearInterval(t); }, []);
  const d = started.direct!;
  return (
    <div className="direct-card" data-testid="direct-status">
      <b>{d.ssid}</b>
      <span>{st?.connected ?? 0} connected{st?.band ? ` · ${st.band} GHz` : ''}</span>
      <span>{st?.p2p === 'available' ? 'Peer Assistance available' : st?.p2p === 'isolated' ? 'Peer Assistance unavailable' : 'Peer Assistance not checked yet'}</span>
      <span>Health: {st ? (st.up ? 'Good' : 'Network down — reconnecting') : '…'}</span>
      <button className="small" onClick={async () => setQr(qr ? null : await api.directQr())}>{qr ? 'Hide QR' : 'Show QR to join'}</button>
      {qr && <figure className="qr"><img src={qr.dataUrl} alt="Join this CLAN" width={220} height={220} /><figcaption className="muted small-text">Join this CLAN — scan inside the CLAN app, then enter the code. Expires {new Date(qr.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</figcaption></figure>}
      <details><summary className="muted">Diagnostics</summary>
        <dl className="kv"><dt>Method</dt><dd>{d.strategy}</dd><dt>Interface</dt><dd>{st?.interfaceName ?? '—'}</dd><dt>Address</dt><dd>{st?.hostAddress ?? '—'}</dd><dt>VPN</dt><dd>{d.vpn.length ? d.vpn.join(', ') : 'none'}</dd></dl>
      </details>
    </div>
  );
}

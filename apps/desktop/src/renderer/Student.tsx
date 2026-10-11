import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClassroomConnection, type Candidate, type Quality } from '@classroom/client';
import { clanLabels, shortFingerprint, type ClanCapability, type ClassroomInfo, type ClientMessage, type MemberStatus, type ResourceView, type StudentAssignmentView } from '@classroom/protocol';
import type { Joined, OwnProfile } from '../shared.ts';
import { StudentAssignments, StudentFiles as FilesCard } from './Files.tsx';
import { api } from './App.tsx';
import { MemberRoom } from './world/LiveRoom.tsx';
import { RoomSurface, usePresentation, type PresentationMsg } from './world/Presentation.tsx';
import { useBoard } from './world/board/useBoard.ts';
import { BoardControls, WallBoard } from './world/board/RoomBoard.tsx';
import { RoomPresentation } from './world/RoomPresentation.tsx';
import { useExperience } from './world/experience.ts';
import { useChat } from './world/chat/useChat.ts';
import { personSender } from './world/chat/send.ts';

const ChatPanel = lazy(() => import('./world/chat/ChatPanel.tsx'));

type Names = { fullName: string; rollNo: string; deviceName: string };
const QUALITY_LABEL: Record<Quality, string> = { excellent: 'Excellent', good: 'Good', poor: 'Poor', disconnected: 'Reconnecting…' };
const errText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const complete = (p: OwnProfile | null) => !!(p?.fullName && p.rollNo && p.deviceName);

export function StudentFlow({ onExit }: { onExit(): void }) {
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [editing, setEditing] = useState(false);
  const [joined, setJoined] = useState<Joined | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getProfile().then((p) => { setProfile(p); if (!complete(p)) setEditing(true); }).catch((e) => setError(errText(e)));
  }, []);

  if (error) return <main className="center narrow"><h2>Secure storage unavailable</h2><p className="error">{error}</p><button onClick={onExit}>Back</button></main>;
  if (editing || (profile && !complete(profile))) return profile && <ProfileForm initial={profile} onSaved={(p) => { setProfile(p); setEditing(false); }} onBack={complete(profile) ? () => setEditing(false) : onExit} />;
  if (!profile) return null;
  if (joined) return <InClass joined={joined} onLeave={() => setJoined(null)} />;
  return <JoinForm profile={profile} onJoined={setJoined} onEditProfile={() => setEditing(true)} onBack={onExit} />;
}

function ProfileForm({ initial, onSaved, onBack }: { initial: OwnProfile; onSaved(p: OwnProfile): void; onBack(): void }) {
  const [p, setP] = useState<Names>({ fullName: initial.fullName ?? '', rollNo: initial.rollNo ?? '', deviceName: initial.deviceName ?? '' });
  const [error, setError] = useState('');
  const save = async () => {
    try { onSaved(await api.saveProfile(p)); } catch { setError('Please fill in every field (no special control characters).'); }
  };
  return (
    <main className="center narrow">
      <button className="link back" onClick={onBack}>← Back</button>
      <h2>Your details</h2>
      <p className="muted">Shown to your teacher so they know who is joining. Saved on this device only.</p>
      <label>Full name<input autoFocus value={p.fullName} maxLength={80} placeholder="Ashar Khan" onChange={(e) => setP({ ...p, fullName: e.target.value })} /></label>
      <label>Student / roll number<input value={p.rollNo} maxLength={40} placeholder="FA23-CS-114" onChange={(e) => setP({ ...p, rollNo: e.target.value })} /></label>
      <label>Device name<input value={p.deviceName} maxLength={60} placeholder="Ashar-MacBook" onChange={(e) => setP({ ...p, deviceName: e.target.value })} /></label>
      <p className="muted small-text">Device key {shortFingerprint(initial.fingerprint)} — created on this computer and protected by the system keychain. Your teacher recognises this device by it.</p>
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={!p.fullName.trim() || !p.rollNo.trim() || !p.deviceName.trim()} onClick={save}>Save</button>
    </main>
  );
}

function JoinForm({ profile, onJoined, onEditProfile, onBack }: { profile: OwnProfile; onJoined(j: Joined): void; onEditProfile(): void; onBack(): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<Candidate[]>([]);
  const [manual, setManual] = useState('');
  const [last, setLast] = useState<{ sessionId: string; title: string } | null>(null);

  useEffect(() => api.discover(setFound), []);
  useEffect(() => { api.lastSession().then(setLast); }, []);

  const [manualNet, setManualNet] = useState<{ ssid: string; passphrase: string } | null>(null);
  const run = async (f: () => Promise<Joined>) => {
    setBusy(true); setError(''); setManualNet(null);
    try { onJoined(await f()); } catch (e) {
      const m = /DIRECT_MANUAL:(\{.*\})/.exec(errText(e));
      if (m) setManualNet(JSON.parse(m[1]!)); else setError(errText(e));
    } finally { setBusy(false); }
  };

  return (
    <main className="center narrow">
      <button className="link back" onClick={onBack}>← Back</button>
      <h2>Join CLAN</h2>
      <p className="muted">Joining as <b>{profile.fullName}</b> ({profile.rollNo}) · <button className="link" onClick={onEditProfile}>edit</button></p>
      <input className="code-input" autoFocus inputMode="numeric" autoComplete="off" maxLength={6} placeholder="••••••" value={code} aria-label="Join code"
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && run(() => api.joinClass(code, manual))} />
      {error && <p className="error">{error}</p>}
      {manualNet && (
        <div className="card" data-testid="manual-network">
          <b>Connect to this network, then press Join again</b>
          <p className="muted small-text">This device can't switch Wi-Fi automatically. Your code was verified; this network belongs to the CLAN host.</p>
          <dl className="kv"><dt>Network</dt><dd>{manualNet.ssid} <button className="small" onClick={() => navigator.clipboard.writeText(manualNet.ssid)}>Copy</button></dd>
            <dt>Password</dt><dd>••••••••••• <button className="small" onClick={() => navigator.clipboard.writeText(manualNet.passphrase)}>Copy</button></dd></dl>
        </div>
      )}
      <button className="primary" disabled={code.length !== 6 || busy} onClick={() => run(() => api.joinClass(code, manual))}>{busy ? 'Joining…' : 'Join'}</button>
      {last && <button disabled={busy} onClick={() => run(() => api.rejoin(last.sessionId))}>Rejoin {last.title} (no code needed)</button>}
      <details className="diag">
        <summary className="muted">Can't find it?</summary>
        <p className="muted">{found.length === 0 ? 'No CLANs found on this network yet.' : `Visible on this network: ${found.map((f) => f.title).join(', ')}`}</p>
        <ul className="muted">
          <li>Make sure you are on the same Wi-Fi as the host (internet is not needed).</li>
          <li>Some guest/university networks block devices from seeing each other ("client isolation"). Ask the host to use a local router.</li>
          <li>If your firewall asked about CLAN, choose Allow.</li>
        </ul>
        <label>Host address (shown on the host's screen under Network)<input value={manual} placeholder="192.168.1.20:52345" onChange={(e) => setManual(e.target.value.trim())} /></label>
        <p className="muted small-text">The address only helps find the teacher's computer. Your code still proves you're talking to the real CLAN.</p>
      </details>
    </main>
  );
}

function InClass({ joined, onLeave }: { joined: Joined; onLeave(): void }) {
  const [session, setSession] = useState(joined);
  const [status, setStatus] = useState<MemberStatus>(joined.status);
  const [info, setInfo] = useState<ClassroomInfo>(joined.classroom);
  const [quality, setQuality] = useState<Quality>('disconnected');
  const [closed, setClosed] = useState('');
  const [handSupported, setHandSupported] = useState(false);
  const [handRaised, setHandRaised] = useState(false), [handError, setHandError] = useState('');
  const [leaving, setLeaving] = useState(false), [leaveError, setLeaveError] = useState('');
  const [teacherWarn, setTeacherWarn] = useState(joined.teacherTrust === 'changed');
  const [resources, setResources] = useState<ResourceView[]>([]);
  const [assignments, setAssignments] = useState<StudentAssignmentView[]>([]);
  const [pushed, setPushed] = useState<string | null>(null);
  const [can, setCan] = useState<ClanCapability[]>([]);
  const experience = useExperience();
  const [presMsg, setPresMsg] = useState<PresentationMsg | null>(null);
  const presRef = useRef<ReturnType<typeof usePresentation> | null>(null);
  const [people, setPeople] = useState<{ name: string; host: boolean; connected: boolean; handle: string }[]>([]);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const revoked = useRef<string[]>([]);
  const connRef = useRef<ClassroomConnection | null>(null);
  const chat = useChat({ role: 'member', conn: { url: session.url, token: session.token, sessionId: session.classroom.sessionId }, clanId: info.clanId ?? info.sessionId, send: (m) => connRef.current?.send(m) });
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const board = useBoard({ kind: 'live', send: (m) => connRef.current?.send(m) }, chat.me ?? session.memberId);
  const boardRef = useRef(board);
  boardRef.current = board;
  const [dm, setDm] = useState<{ handle: string; n: number } | null>(null);
  const [toastMsg, setToast] = useState('');
  const toast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000); };
  useEffect(() => api.notify.on((n) => { if (n.threadId !== chatRef.current.active || !document.hasFocus()) toast(`${n.title}: ${n.body}`); }), []);

  useEffect(() => {
    let retried = false;
    // Renderer WSS: Chromium accepts only the PAKE-pinned certificate (main-process verify proc).
    const c = new ClassroomConnection(session.url, session.token, {
      onMessage: (m) => {
        if (m.t.startsWith('wb.')) return boardRef.current.onServer(m as never);
        chatRef.current.onServer(m);
        if (m.t === 'hello') boardRef.current.connected();
        if (m.t === 'hello') { setInfo(m.classroom); setCan(m.capabilities); if (m.status) setStatus(m.status); }
        if (m.t === 'hands') { setHandSupported(true); setHandRaised(m.mine); setHandError(''); }
        if (m.t === 'error' && m.code === 'rate_limited') setHandError(m.message);
        if (m.t === 'members') setPeople(m.members);
        if (m.t === 'presentation') setPresMsg(m);
        if (m.t === 'error' && ['presenting', 'whiteboard', 'not_shared'].includes(m.code)) boardRef.current.onServer(m);
        if (m.t === 'error' && ['busy', 'forbidden', 'media_unavailable', 'not_presenting', 'whiteboard'].includes(m.code)) void presRef.current?.refused(m.message);
        if (m.t === 'peer.probe') void api.peerProbe(m.targets).then((r) => connRef.current?.send({ t: 'peer.probeResult', probeId: m.probeId, ...r })).catch(() => {});
        if (m.t === 'class.state') { setInfo(m.classroom); if (m.capabilities) setCan(m.capabilities); }
        if (m.t === 'member.status') { setStatus(m.status); if (m.status === 'approved') void api.peerState(connOf(), { peerAssist: infoRef.current.peerAssist, revoked: [] }); } // register the peer server as soon as we're in
        if (m.t === 'resources') setResources(m.resources as ResourceView[]);
        if (m.t === 'assignments') { setAssignments(m.assignments as StudentAssignmentView[]); void api.study.assignmentsSeen(infoRef.current.clanId ?? infoRef.current.sessionId, m.assignments).catch(() => {}); } // offline projection for Today / Course
        if (m.t === 'resource.push' || m.t === 'resource.seed') setPushed(m.resourceId);
        if (m.t === 'peer.revoked') { revoked.current = [...revoked.current, ...m.fingerprints]; void api.peerState(connOf(), { peerAssist: infoRef.current.peerAssist, revoked: m.fingerprints }); }
        if (m.t === 'hello' || m.t === 'class.state') { infoRef.current = m.classroom; void api.peerState(connOf(), { peerAssist: m.classroom.peerAssist, revoked: [] }); }
      },
      onQuality: (q) => { setQuality(q); setOfflineSince((t) => (q === 'disconnected' ? t ?? Date.now() : null)); },
      onClosed: (reason) => {
        // Token expired (idle/absolute lifetime): prove the device key again for a fresh one, once.
        if (/expired|invalid/.test(reason) && !retried) {
          retried = true;
          api.rejoin(session.classroom.sessionId).then(setSession, () => setClosed(reason));
        } else setClosed(reason);
      },
    });
    connRef.current = c;
    return () => c.close();
  }, [session]);
  const infoRef = useRef(joined.classroom);
  const connOf = () => ({ url: session.url, token: session.token, sessionId: session.classroom.sessionId, classTitle: session.classroom.title });
  const send = useCallback((m: ClientMessage) => connRef.current?.send(m), []);
  const conn = useMemo(() => ({ url: session.url, token: session.token, sessionId: session.classroom.sessionId, classTitle: session.classroom.title }), [session]);

  // Approved: this device now holds a canonical membership in that CLAN (profile and identity are not copied).
  useEffect(() => {
    if (status === 'approved') void api.clan.joined({ sessionId: info.sessionId, clanId: info.clanId, type: info.clanType, name: info.title, hostKey: joined.teacherPublicKey, expiresAt: info.expiresAt, hostName: info.hostName, authority: info.authority }).catch(() => {});
  }, [status, info.sessionId, info.clanId, info.clanType, info.title, info.expiresAt, joined.teacherPublicKey]);
  const L = clanLabels(info.clanType);
  const pres = usePresentation({ baseUrl: session.url, bearer: session.token, sessionId: info.sessionId, msg: presMsg, send: (m) => connRef.current?.send(m), me: session.memberId });
  presRef.current = pres;
  const boardNode = board.view?.wall === 'WHITEBOARD' && !pres.live ? <WallBoard board={board} resources={resources} title={`${info.title} board`} /> : undefined;

  const over = info.ended ? `The ${L.session} has ended.` : status === 'rejected' ? `The ${L.host.toLowerCase()} declined your request.` : status === 'removed' ? `You were removed from this ${L.session}.`
    : status === 'blocked' ? `This device was blocked from this ${L.session}.` : closed ? 'Your session expired. Join again with the code.' : '';
  if (over && !leaving) return <main className="center narrow"><h2>{info.title}</h2><p>{over}</p><button className="primary" onClick={onLeave}>OK</button></main>;

  const banner = teacherWarn && (
    <div className="warning-banner" role="alert">
      <b>This class is now hosted from a different teacher computer</b> ({shortFingerprint(joined.teacherFingerprint)}). Your code proved this computer is running the class you joined, but it is not the teacher computer you used for "{info.title}" before. Check with your teacher.
      <div className="row"><button className="small" onClick={async () => { await api.trustTeacher(info.title, joined.teacherPublicKey); setTeacherWarn(false); }}>It's my teacher — trust this computer</button><button className="small" onClick={onLeave}>Leave</button></div>
    </div>
  );

  if (status === 'pending') return (
    <main className="center narrow">
      {banner}
      <h2>{info.title}</h2>
      <div className="spinner" aria-hidden />
      <p>Waiting for the {L.host.toLowerCase()} to let you in…</p>
      <button onClick={onLeave}>Cancel</button>
    </main>
  );

  return (
    <div className="dash">
      {banner}
      {offlineSince !== null ? (
        <div className="warning-banner" role="status" data-testid="teacher-offline">{L.host} temporarily disconnected. Previously published resources remain available.</div>
      ) : null}
      <header className="bar">
        <div><h2>{info.title}</h2><span className="muted" data-testid="secure-state">🔒 Secure connection · {info.clanType !== 'CLASSROOM' && `${L.type} · `}{L.host.toLowerCase()} {shortFingerprint(joined.teacherFingerprint)}{joined.teacherTrust === 'known' ? ' ✓' : ''}</span>{info.hostName && <p className="muted small-text" data-testid="host-name">Hosted by {info.hostName}</p>}{info.description && <p className="muted small-text">{info.description}</p>}</div>
        {handSupported && <button disabled={quality === 'disconnected'} aria-pressed={handRaised} onClick={() => send({ t: 'hand.set', raised: !handRaised })}>{handRaised ? 'Lower hand' : 'Raise hand'}</button>}
        {handError && <p role="alert">{handError}</p>}
        <div className="row"><span className={`pill ${quality}`}><span className={`dot ${quality}`} /> {QUALITY_LABEL[quality]}</span><button onClick={onLeave}>Leave</button><button disabled={leaving} onClick={async () => {
          if (!confirm('Leave this CLAN membership? Personal data and stored copies stay. If the host is unavailable, remote revocation cannot be confirmed.')) return;
          setLeaving(true); setLeaveError(''); connRef.current?.close();
          try { const result = await api.clan.leaveMembership(conn, info.clanId ?? info.sessionId); if (!result.confirmed) alert('Left on this device. The host did not confirm remote revocation; it may still retain your session rights until they expire.'); onLeave(); }
          catch (e) { setLeaveError(errText(e)); setLeaving(false); }
        }}>Leave membership</button></div>
      </header>
      {leaving && <p role="status">Leaving on this device and requesting host revocation…</p>}{leaveError && <p role="alert">{leaveError}</p>}
      <RoomPresentation pres={pres} msg={presMsg} send={send} can={can} isHost={false} boardOnWall={board.view?.wall === 'WHITEBOARD'} />
      <BoardControls board={board} pres={pres} send={send} clanType={info.clanType} me={null} />
      {experience === 'minimal' && pres.live && <RoomSurface mode="SCREEN_SHARE" screen={{ pres, live: pres.live }}>{null}</RoomSurface>}
      {experience === 'minimal' && boardNode}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
      <div className="room-with-chat">
        {experience !== 'minimal' && <MemberRoom kind={info.clanType} board={boardNode} pres={pres} presenterName={pres.live?.presenterName ?? null} hostName={info.hostName} hostLabel={L.host} people={can.includes('VIEW_MEMBERS') ? people : chat.host ? [{ name: info.hostName ?? L.host, host: true, connected: true, handle: chat.host }] : null} resources={resources}
          actions={{ ...personSender(chat, (handle) => setDm({ handle, n: Date.now() }), can.includes('SEND_FILES')), me: chat.me }} onToast={toast}
          onTableDrop={can.includes('SEND_FILES') ? async (files) => { const r = await api.chat.sendDropped(chat.conn, files, 'clan'); if (r.some((f) => 'pending' in f)) return 'File sent for teacher approval.'; return r.length ? `Shared ${r.length === 1 ? r[0]!.name : `${r.length} files`} with everyone in the ${L.session}` : 'Nothing was shared.'; } : undefined} />}
        <Suspense fallback={<section className="card chat"><p className="muted">Loading chat…</p></section>}>
          <ChatPanel chat={chat} role="member" clanName={info.title} canSendFiles={can.includes('SEND_FILES')} conn={conn} request={dm}
            people={can.includes('VIEW_MEMBERS') ? people.map((p) => ({ handle: p.handle, name: p.name, host: p.host, connected: p.connected })) : []} />
        </Suspense>
      </div>
      <section className="grid">
        <FilesCard conn={conn} resources={resources} pushed={pushed} send={send} host={L.host.toLowerCase()} />
        {can.includes('SUBMIT_ASSIGNMENT') && <StudentAssignments conn={conn} assignments={assignments} />}
        {can.includes('VIEW_MEMBERS') && (
          <div className="card" data-testid="clan-members">
            <h3>{L.members} ({people.length})</h3>
            {people.map((p, i) => <div key={i} className="person"><span><span className={`dot ${p.connected ? 'excellent' : 'disconnected'}`} /> {p.host ? `${p.name} (${L.host.toLowerCase()})` : p.name}</span></div>)}
          </div>
        )}
      </section>
    </div>
  );
}

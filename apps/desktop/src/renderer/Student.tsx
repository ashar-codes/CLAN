import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClassroomConnection, type Candidate, type Quality } from '@classroom/client';
import { clanLabels, shortFingerprint, type ClanCapability, type ClassroomInfo, type ClientMessage, type MemberStatus, type ResourceView, type StudentAssignmentView } from '@classroom/protocol';
import type { Joined, OwnProfile } from '../shared.ts';
import { StudentAssignments, StudentFiles as FilesCard } from './Files.tsx';
import { api } from './App.tsx';
import { MemberRoom } from './world/LiveRoom.tsx';
import { useExperience } from './world/experience.ts';

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
  const [teacherWarn, setTeacherWarn] = useState(joined.teacherTrust === 'changed');
  const [resources, setResources] = useState<ResourceView[]>([]);
  const [assignments, setAssignments] = useState<StudentAssignmentView[]>([]);
  const [pushed, setPushed] = useState<string | null>(null);
  const [can, setCan] = useState<ClanCapability[]>([]);
  const experience = useExperience();
  const [people, setPeople] = useState<{ name: string; host: boolean; connected: boolean }[]>([]);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const revoked = useRef<string[]>([]);
  const connRef = useRef<ClassroomConnection | null>(null);

  useEffect(() => {
    let retried = false;
    // Renderer WSS: Chromium accepts only the PAKE-pinned certificate (main-process verify proc).
    const c = new ClassroomConnection(session.url, session.token, {
      onMessage: (m) => {
        if (m.t === 'hello') { setInfo(m.classroom); setCan(m.capabilities); if (m.status) setStatus(m.status); }
        if (m.t === 'members') setPeople(m.members);
        if (m.t === 'peer.probe') void api.peerProbe(m.targets).then((r) => connRef.current?.send({ t: 'peer.probeResult', probeId: m.probeId, ...r })).catch(() => {});
        if (m.t === 'class.state') setInfo(m.classroom);
        if (m.t === 'member.status') { setStatus(m.status); if (m.status === 'approved') void api.peerState(connOf(), { peerAssist: infoRef.current.peerAssist, revoked: [] }); } // register the peer server as soon as we're in
        if (m.t === 'resources') setResources(m.resources as ResourceView[]);
        if (m.t === 'assignments') setAssignments(m.assignments as StudentAssignmentView[]);
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
    if (status === 'approved') void api.clan.joined({ sessionId: info.sessionId, clanId: info.clanId, type: info.clanType, name: info.title, hostKey: joined.teacherPublicKey, expiresAt: info.expiresAt, hostName: info.hostName }).catch(() => {});
  }, [status, info.sessionId, info.clanId, info.clanType, info.title, info.expiresAt, joined.teacherPublicKey]);
  const L = clanLabels(info.clanType);

  const over = info.ended ? `The ${L.session} has ended.` : status === 'rejected' ? `The ${L.host.toLowerCase()} declined your request.` : status === 'removed' ? `You were removed from this ${L.session}.`
    : status === 'blocked' ? `This device was blocked from this ${L.session}.` : closed ? 'Your session expired. Join again with the code.' : '';
  if (over) return <main className="center narrow"><h2>{info.title}</h2><p>{over}</p><button className="primary" onClick={onLeave}>OK</button></main>;

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
        <div className="row"><span className={`pill ${quality}`}><span className={`dot ${quality}`} /> {QUALITY_LABEL[quality]}</span><button onClick={onLeave}>Leave</button></div>
      </header>
      {experience !== 'minimal' && <MemberRoom hostName={info.hostName} hostLabel={L.host} people={can.includes('VIEW_MEMBERS') ? people : null} resources={resources} />}
      <section className="grid">
        <FilesCard conn={conn} resources={resources} pushed={pushed} send={send} host={L.host.toLowerCase()} />
        {can.includes('SUBMIT_ASSIGNMENT') && <StudentAssignments conn={conn} assignments={assignments} />}
        {can.includes('VIEW_MEMBERS') && (
          <div className="card" data-testid="clan-members">
            <h3>{L.members} ({people.length})</h3>
            {people.map((p, i) => <div key={i} className="person"><span><span className={`dot ${p.connected ? 'excellent' : 'disconnected'}`} /> {p.host ? `${p.name} (${L.host.toLowerCase()})` : p.name}</span></div>)}
          </div>
        )}
        {info.clanType !== 'CLASSROOM' && <div className="card"><h3>Chat</h3><p className="muted">Coming in the next update. Your membership here is already set up for it.</p></div>}
      </section>
    </div>
  );
}

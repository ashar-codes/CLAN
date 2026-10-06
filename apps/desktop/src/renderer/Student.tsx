import { useEffect, useRef, useState } from 'react';
import { ClassroomConnection, joinByCode, JoinFailed, type Candidate, type JoinResult, type Quality } from '@classroom/client';
import type { ClassroomInfo, MemberStatus, StudentProfile } from '@classroom/protocol';
import { api } from './App.tsx';

type Profile = Omit<StudentProfile, 'deviceId'>;
const QUALITY_LABEL: Record<Quality, string> = { excellent: 'Excellent', good: 'Good', poor: 'Poor', disconnected: 'Reconnecting…' };

export function StudentFlow({ onExit }: { onExit(): void }) {
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [editing, setEditing] = useState(false);
  const [joined, setJoined] = useState<JoinResult | null>(null);

  useEffect(() => {
    api.getProfile().then((p) => {
      const ok = StudentProfileComplete(p);
      if (ok) setProfile(p as StudentProfile); else setEditing(true);
    });
  }, []);

  if (editing) return <ProfileForm initial={profile} onSaved={(p) => { setProfile(p); setEditing(false); }} onBack={profile ? () => setEditing(false) : onExit} />;
  if (!profile) return null;
  if (joined) return <InClass joined={joined} onLeave={() => setJoined(null)} />;
  return <JoinForm profile={profile} onJoined={setJoined} onEditProfile={() => setEditing(true)} onBack={onExit} />;
}

const StudentProfileComplete = (p: Partial<StudentProfile>) => !!(p.fullName && p.rollNo && p.deviceName);

function ProfileForm({ initial, onSaved, onBack }: { initial: StudentProfile | null; onSaved(p: StudentProfile): void; onBack(): void }) {
  const [p, setP] = useState<Profile>({ fullName: initial?.fullName ?? '', rollNo: initial?.rollNo ?? '', deviceName: initial?.deviceName ?? '' });
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
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={!p.fullName.trim() || !p.rollNo.trim() || !p.deviceName.trim()} onClick={save}>Save</button>
    </main>
  );
}

function JoinForm({ profile, onJoined, onEditProfile, onBack }: { profile: StudentProfile; onJoined(j: JoinResult): void; onEditProfile(): void; onBack(): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<Candidate[]>([]);
  const [manual, setManual] = useState('');
  const foundRef = useRef<Candidate[]>([]);

  useEffect(() => api.discover((list) => { foundRef.current = list; setFound(list); }), []);

  const join = async () => {
    setBusy(true); setError('');
    try {
      // Give discovery a few seconds if nothing has answered yet (multicast can be slow on busy Wi-Fi).
      for (let i = 0; i < 20 && foundRef.current.length === 0 && !manual; i++) await new Promise((r) => setTimeout(r, 250));
      const candidates = manual ? [{ url: manualUrl(manual) }] : foundRef.current;
      onJoined(await joinByCode(candidates, code, profile));
    } catch (e) {
      setError(e instanceof JoinFailed ? e.message : 'Something went wrong. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <main className="center narrow">
      <button className="link back" onClick={onBack}>← Back</button>
      <h2>Join Classroom</h2>
      <p className="muted">Joining as <b>{profile.fullName}</b> ({profile.rollNo}) · <button className="link" onClick={onEditProfile}>edit</button></p>
      <input className="code-input" autoFocus inputMode="numeric" autoComplete="off" maxLength={6} placeholder="••••••" value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && join()} />
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={code.length !== 6 || busy} onClick={join}>{busy ? 'Finding classroom…' : 'Join'}</button>
      <details className="diag">
        <summary className="muted">Can't find the class?</summary>
        <p className="muted">{found.length === 0 ? 'No classrooms found on this network yet.' : `Classrooms visible on this network: ${found.map((f) => f.title).join(', ')}`}</p>
        <ul className="muted">
          <li>Make sure you are on the same Wi-Fi as the teacher (internet is not needed).</li>
          <li>Some guest/university networks block devices from seeing each other ("client isolation"). Ask the teacher to use a classroom router.</li>
          <li>If your firewall asked about Classroom LAN, choose Allow.</li>
        </ul>
        <label>Teacher address (shown on the teacher's screen under Network)<input value={manual} placeholder="192.168.1.20:52345" onChange={(e) => setManual(e.target.value.trim())} /></label>
      </details>
    </main>
  );
}

const manualUrl = (s: string) => (s.startsWith('http') ? s : `http://${s}`).replace(/\/+$/, '');

function InClass({ joined, onLeave }: { joined: JoinResult; onLeave(): void }) {
  const [status, setStatus] = useState<MemberStatus>(joined.status);
  const [info, setInfo] = useState<ClassroomInfo>(joined.classroom);
  const [quality, setQuality] = useState<Quality>('disconnected');
  const [closed, setClosed] = useState('');

  useEffect(() => {
    const c = new ClassroomConnection(joined.url, joined.token, {
      onMessage: (m) => {
        if (m.t === 'hello') { setInfo(m.classroom); if (m.status) setStatus(m.status); }
        if (m.t === 'class.state') setInfo(m.classroom);
        if (m.t === 'member.status') setStatus(m.status);
      },
      onQuality: setQuality,
      onClosed: (reason) => setClosed(reason),
    });
    return () => c.close();
  }, [joined]);

  const over = info.ended ? 'The class has ended.' : status === 'rejected' ? 'The teacher declined your request.' : status === 'removed' ? 'You were removed from the class.'
    : status === 'blocked' ? 'This device was blocked from the class.' : closed ? 'Your session expired. Join again with the code.' : '';
  if (over) return <main className="center narrow"><h2>{info.title}</h2><p>{over}</p><button className="primary" onClick={onLeave}>OK</button></main>;

  if (status === 'pending') return (
    <main className="center narrow">
      <h2>{info.title}</h2>
      <div className="spinner" aria-hidden />
      <p>Waiting for the teacher to let you in…</p>
      <button onClick={onLeave}>Cancel</button>
    </main>
  );

  return (
    <div className="dash">
      <header className="bar">
        <div><h2>{info.title}</h2><span className="muted">You're in the class</span></div>
        <div className="row"><span className={`pill ${quality}`}><span className={`dot ${quality}`} /> {QUALITY_LABEL[quality]}</span><button onClick={onLeave}>Leave</button></div>
      </header>
      <section className="grid">
        <div className="card"><h3>Classroom</h3><p className="muted">Files, presentations, chat and quizzes from your teacher will appear here as they are added in upcoming builds.</p></div>
      </section>
    </div>
  );
}

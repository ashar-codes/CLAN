import { useEffect, useState } from 'react';
import type { Capabilities, DesktopApi } from '../shared.ts';
import { TeacherSetup, TeacherDashboard, type Rehost } from './Teacher.tsx';
import { StudentFlow } from './Student.tsx';
import { Chats } from './world/people/Chats.tsx';
import { Friends } from './world/people/Friends.tsx';
import { CallProvider } from './world/people/Call.tsx';
import { Shell } from './Shell.tsx';
import { Onboarding } from './Onboarding.tsx';
import { AIHost } from './world/ai/ctx.tsx';
import { RecorderHost } from './world/tape/recorder.tsx';
import type { StartedClassroom } from '../shared.ts';
import type { ClanType } from '@classroom/protocol';

declare global { interface Window { classroom: DesktopApi } }
export const api = window.classroom;

type Screen = { s: 'home' } | { s: 'teacher-setup'; type?: ClanType; rehost?: Rehost } | { s: 'teacher'; started: StartedClassroom } | { s: 'student' };

export function App() {
  const [screen, setScreen] = useState<Screen>({ s: 'home' });
  const [notice, setNotice] = useState<{ id: string | null } | null>(null);
  useEffect(() => api.people.onOpen((id) => { if (screen.s !== 'home') setNotice({ id }); }), [screen.s]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => { api.capabilities().then(setCaps); }, []);
  const [named, setNamed] = useState<boolean | null>(null);
  useEffect(() => { void api.getProfile().then((p) => setNamed(!!(p.fullName?.trim() && p.deviceName?.trim()))); }, []);
  if (!caps || named === null) return null;
  if (!named) return <Onboarding onDone={() => setNamed(true)} />;

  const ks = caps.keystore;
  const keyBanner = ks.insecureDev
    ? <div className="danger-banner">Development mode: identity keys are stored WITHOUT OS protection (CLASSROOM_DEV_INSECURE_KEYSTORE). Never use this for real classes.</div>
    : ks.regenerated.length ? <div className="warning-banner">Stored keys could not be unlocked and were replaced ({ks.regenerated.join(', ')}). Teachers will see this as a new device and must approve it again.</div> : null;
  return <AIHost><RecorderHost><CallProvider>{keyBanner}<Screens screen={screen} setScreen={setScreen} caps={caps} />{notice && screen.s !== 'home' && <div className="modal-overlay"><div className="modal card" style={{ width: 'min(900px, 95vw)', maxHeight: '90vh', overflow: 'auto' }}><button onClick={() => setNotice(null)}>Return to CLAN</button>{notice.id ? <Chats openId={notice.id} setOpenId={(id) => setNotice({ id })} /> : <Friends onChat={(id) => setNotice({ id })} />}</div></div>}</CallProvider></RecorderHost></AIHost>;
}

function Screens({ screen, setScreen, caps }: { screen: Screen; setScreen(s: Screen): void; caps: Capabilities }) {
  const home = () => setScreen({ s: 'home' });
  switch (screen.s) {
    case 'home':
      return <Shell onCreate={(type) => setScreen({ s: 'teacher-setup', type })} onRehost={(rehost) => setScreen({ s: 'teacher-setup', rehost })} onJoin={() => setScreen({ s: 'student' })} />;
    case 'teacher-setup':
      return <TeacherSetup caps={caps} initialType={screen.type} rehost={screen.rehost} onBack={home} onStarted={(started) => setScreen({ s: 'teacher', started })} />;
    case 'teacher':
      return <TeacherDashboard caps={caps} started={screen.started} onEnded={home} />;
    case 'student':
      return <StudentFlow onExit={home} />;
  }
}

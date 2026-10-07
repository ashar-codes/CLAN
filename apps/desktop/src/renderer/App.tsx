import { useEffect, useState } from 'react';
import type { Capabilities, DesktopApi } from '../shared.ts';
import { TeacherSetup, TeacherDashboard } from './Teacher.tsx';
import { StudentFlow } from './Student.tsx';
import { Shell } from './Shell.tsx';
import type { StartedClassroom } from '../shared.ts';

declare global { interface Window { classroom: DesktopApi } }
export const api = window.classroom;

type Screen = { s: 'home' } | { s: 'teacher-setup' } | { s: 'teacher'; started: StartedClassroom } | { s: 'student' };

export function App() {
  const [screen, setScreen] = useState<Screen>({ s: 'home' });
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => { api.capabilities().then(setCaps); }, []);
  if (!caps) return null;

  const ks = caps.keystore;
  const keyBanner = ks.insecureDev
    ? <div className="danger-banner">Development mode: identity keys are stored WITHOUT OS protection (CLASSROOM_DEV_INSECURE_KEYSTORE). Never use this for real classes.</div>
    : ks.regenerated.length ? <div className="warning-banner">Stored keys could not be unlocked and were replaced ({ks.regenerated.join(', ')}). Teachers will see this as a new device and must approve it again.</div> : null;
  if (keyBanner) return <>{keyBanner}<Screens screen={screen} setScreen={setScreen} caps={caps} /></>;
  return <Screens screen={screen} setScreen={setScreen} caps={caps} />;
}

function Screens({ screen, setScreen, caps }: { screen: Screen; setScreen(s: Screen): void; caps: Capabilities }) {
  const home = () => setScreen({ s: 'home' });
  switch (screen.s) {
    case 'home':
      return <Shell onCreateClassroom={() => setScreen({ s: 'teacher-setup' })} onJoinClassroom={() => setScreen({ s: 'student' })} />;
    case 'teacher-setup':
      return <TeacherSetup caps={caps} onBack={home} onStarted={(started) => setScreen({ s: 'teacher', started })} />;
    case 'teacher':
      return <TeacherDashboard caps={caps} started={screen.started} onEnded={home} />;
    case 'student':
      return <StudentFlow onExit={home} />;
  }
}

import { useEffect, useState } from 'react';
import type { Capabilities, DesktopApi } from '../shared.ts';
import { TeacherSetup, TeacherDashboard } from './Teacher.tsx';
import { StudentFlow } from './Student.tsx';
import type { StartedClassroom } from '../shared.ts';

declare global { interface Window { classroom: DesktopApi } }
export const api = window.classroom;

type Screen = { s: 'home' } | { s: 'teacher-setup' } | { s: 'teacher'; started: StartedClassroom } | { s: 'student' };

export function App() {
  const [screen, setScreen] = useState<Screen>({ s: 'home' });
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => { api.capabilities().then(setCaps); }, []);
  if (!caps) return null;
  const home = () => setScreen({ s: 'home' });

  switch (screen.s) {
    case 'home':
      return (
        <main className="center">
          <h1 className="brand">Classroom LAN</h1>
          <p className="muted">Works with no internet. Everyone just needs to be on the same network.</p>
          <div className="choices">
            <button className="choice" onClick={() => setScreen({ s: 'teacher-setup' })}><b>Create Classroom</b><span>I'm the teacher</span></button>
            <button className="choice" onClick={() => setScreen({ s: 'student' })}><b>Join Classroom</b><span>I have a 6-digit code</span></button>
          </div>
        </main>
      );
    case 'teacher-setup':
      return <TeacherSetup caps={caps} onBack={home} onStarted={(started) => setScreen({ s: 'teacher', started })} />;
    case 'teacher':
      return <TeacherDashboard caps={caps} started={screen.started} onEnded={home} />;
    case 'student':
      return <StudentFlow onExit={home} />;
  }
}

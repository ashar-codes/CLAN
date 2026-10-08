// Production shell: My Space / Commons / CLANs / Study / Saved / Me. The world is the navigation, every place also has a
// conventional equivalent, and the Visual Experience setting (Full / Reduced / Minimal) decides how much of it is drawn.
import { useCallback, useEffect, useState } from 'react';
import type { ClanType, HomeView } from '../shared.ts';
import { api } from './App.tsx';
import { useExperience } from './world/experience.ts';
import { useLoad } from './world/useLoad.ts';
import { MySpace, type SpaceTarget } from './world/MySpace.tsx';
import { Commons, type NearbyClan } from './world/Commons.tsx';
import { Clans } from './world/Clans.tsx';
import { Study } from './world/Study.tsx';
import { Ctx, SessionBar, useActiveSession, type StudyCtx, type StudyTarget } from './world/study/common.tsx';
import { Saved } from './world/Saved.tsx';
import { Me } from './world/Me.tsx';
import { QuickCapture } from './world/QuickCapture.tsx';

type Tab = 'space' | 'commons' | 'clans' | 'study' | 'saved' | 'me';
const TABS: [Tab, string, string][] = [['space', 'My Space', '⌂'], ['commons', 'Commons', '◎'], ['clans', 'CLANs', '▦'], ['study', 'Study', '▥'], ['saved', 'Saved', '❏'], ['me', 'Me', '☺']];
type Rehost = { clanId: string; name: string; type: ClanType };

export function Shell({ onCreate, onJoin, onRehost }: { onCreate(type?: ClanType): void; onJoin(): void; onRehost(r: Rehost): void }) {
  const experience = useExperience();
  const [tab, setTab] = useState<Tab>('space');
  const [studyTarget, setStudyTarget] = useState<StudyTarget>({ tab: 'campus' });
  const [session, setSession] = useActiveSession();
  const [meSection, setMeSection] = useState<'profile' | 'diary'>('profile');
  const [nearby, setNearby] = useState<NearbyClan[]>([]);
  const [toast, setToast] = useState('');
  const [guide, setGuide] = useState(false);
  const [manualFocus, setFocus] = useState(false);
  // A Focus study session turns Focus Mode on; ending it restores whatever was set before. No penalties, no streaks.
  const focus = manualFocus || !!session?.focus;
  const [h, reloadHome] = useLoad<HomeView>(useCallback(() => api.clan.home(), []));
  useEffect(() => api.discover((l) => setNearby(l)), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2400); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { if (tab === 'space') reloadHome(); }, [tab, reloadHome]);
  useEffect(() => { void api.notify.context({ focus }); }, [focus]);
  useEffect(() => api.notify.on((n) => { if (document.hasFocus()) setToast(`${n.title}: ${n.body}`); }), []);

  const go = (t: SpaceTarget) => {
    if (t === 'guide') return setGuide(true);
    if (t === 'notes' || t === 'exams' || t === 'study' || t === 'board' || t === 'tasks') { setStudyTarget({ tab: t === 'study' ? 'campus' : t }); return setTab('study'); }
    if (t.startsWith('course:')) { setStudyTarget({ tab: 'campus', courseId: t.slice(7) }); return setTab('study'); }
    if (t === 'diary' || t === 'me') { setMeSection(t === 'diary' ? 'diary' : 'profile'); return setTab('me'); }
    setTab(t as Tab);
  };
  const study: StudyCtx = {
    target: studyTarget, go: (t) => { setStudyTarget(t); setTab('study'); }, session,
    start: async (o) => { try { setSession(await api.study.startSession(o)); setToast(o.focus ? 'Study session started · Focus on' : 'Study session started'); } catch (e) { setToast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); } },
    end: async (reflection) => { if (!session) return; const s = await api.study.endSession(session.id, reflection || undefined); setSession(null); setToast(`Session saved · ${Math.max(1, Math.round((s.endedAt! - s.startedAt!) / 60_000))} min`); reloadHome(); },
  };
  const quick = (
    <div className="quick-actions" aria-label="Quick actions">
      <button className="primary" onClick={() => go('notes')}>New note</button>
      <button onClick={() => onCreate('CLASSROOM')}>Create Classroom</button>
      <button onClick={onJoin}>Join Classroom</button>
      <button onClick={() => onCreate('STUDY_GROUP')}>New CLAN</button>
      {session ? null : <button onClick={() => void study.start({ goal: 'Study', focus: true })}>Start studying</button>}
      <button aria-pressed={manualFocus} onClick={() => setFocus(!manualFocus)}>{manualFocus ? 'End focus' : 'Focus'}</button>
    </div>
  );

  return (
    <Ctx.Provider value={study}>
    <div className={`shell ${focus ? 'is-focus' : ''}`}>
      <header className="shell-top">
        <span className="brand-sm">CLAN</span>
        <nav className="tabs-main" aria-label="Main">
          {TABS.map(([t, l, ic]) => <button key={t} className={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}><span className="tab-ic" aria-hidden>{ic}</span>{l}</button>)}
        </nav>
      </header>
      <main className="shell-body" key={tab}>
        {tab === 'space' && h && <MySpace h={h} nearby={nearby.length} beacon={focus ? 'focus' : 'available'} experience={experience} go={go} quick={quick} />}
        {tab === 'commons' && <Commons nearby={nearby} experience={experience} onJoin={onJoin} onCreate={() => onCreate('STUDY_GROUP')} />}
        {tab === 'clans' && <Clans experience={experience} nearby={nearby} onCreate={onCreate} onJoin={onJoin} onRehost={onRehost} />}
        {tab === 'study' && <Study experience={experience} />}
        {tab === 'saved' && <Saved experience={experience} />}
        {tab === 'me' && <Me experience={experience} section={meSection} />}
      </main>
      {guide && (
        <div className="guide-panel card" role="dialog" aria-label="CLAN Guide">
          <div className="row between"><span className="eyebrow ai">Guide</span><button className="small" onClick={() => setGuide(false)}>Close</button></div>
          <p>No AI provider is set up on this device, so the Guide has nothing to say yet.</p>
          <p className="muted small-text">When one is, it will only see what the screen you’re on shows. Your Diary stays closed to it unless you allow it in Me › Privacy.</p>
        </div>
      )}
      {focus && <div className="focus-veil" aria-hidden />}
      <SessionBar onNote={() => go('notes')} />
      <QuickCapture onDone={(m, g) => { setToast(m); reloadHome(); if (g) go(g); }} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
    </Ctx.Provider>
  );
}

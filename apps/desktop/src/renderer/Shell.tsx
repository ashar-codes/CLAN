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
import { Study, type StudyTab } from './world/Study.tsx';
import { Saved } from './world/Saved.tsx';
import { Me } from './world/Me.tsx';
import { QuickCapture } from './world/QuickCapture.tsx';

type Tab = 'space' | 'commons' | 'clans' | 'study' | 'saved' | 'me';
const TABS: [Tab, string, string][] = [['space', 'My Space', '⌂'], ['commons', 'Commons', '◎'], ['clans', 'CLANs', '▦'], ['study', 'Study', '▥'], ['saved', 'Saved', '❏'], ['me', 'Me', '☺']];
type Rehost = { clanId: string; name: string; type: ClanType };

export function Shell({ onCreate, onJoin, onRehost }: { onCreate(type?: ClanType): void; onJoin(): void; onRehost(r: Rehost): void }) {
  const experience = useExperience();
  const [tab, setTab] = useState<Tab>('space');
  const [studyTab, setStudyTab] = useState<StudyTab>('campus');
  const [meSection, setMeSection] = useState<'profile' | 'diary'>('profile');
  const [nearby, setNearby] = useState<NearbyClan[]>([]);
  const [toast, setToast] = useState('');
  const [guide, setGuide] = useState(false);
  const [focus, setFocus] = useState(false);
  const [h, reloadHome] = useLoad<HomeView>(useCallback(() => api.clan.home(), []));
  useEffect(() => api.discover((l) => setNearby(l)), []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2400); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { if (tab === 'space') reloadHome(); }, [tab, reloadHome]);
  useEffect(() => { void api.notify.context({ focus }); }, [focus]);
  useEffect(() => api.notify.on((n) => { if (document.hasFocus()) setToast(`${n.title}: ${n.body}`); }), []);

  const go = (t: SpaceTarget) => {
    if (t === 'guide') return setGuide(true);
    if (t === 'notes' || t === 'exams' || t === 'study') { setStudyTab(t === 'study' ? 'campus' : t); return setTab('study'); }
    if (t === 'diary' || t === 'me') { setMeSection(t === 'diary' ? 'diary' : 'profile'); return setTab('me'); }
    setTab(t);
  };
  const quick = (
    <div className="quick-actions" aria-label="Quick actions">
      <button className="primary" onClick={() => go('notes')}>New note</button>
      <button onClick={() => onCreate('CLASSROOM')}>Create Classroom</button>
      <button onClick={onJoin}>Join Classroom</button>
      <button onClick={() => onCreate('STUDY_GROUP')}>New CLAN</button>
      <button aria-pressed={focus} onClick={() => setFocus(!focus)}>{focus ? 'End focus' : 'Focus'}</button>
    </div>
  );

  return (
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
        {tab === 'study' && <Study experience={experience} tab={studyTab} setTab={setStudyTab} />}
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
      <QuickCapture onDone={(m, g) => { setToast(m); reloadHome(); if (g) go(g); }} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

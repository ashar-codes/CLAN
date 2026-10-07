import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/figtree';
import '@clan/design/tokens.css';
import './lab.css';
import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useEffect, useState } from 'react';
import { BEACON_LABEL, BEACON_STATES, CLANBeacon, type BeaconState } from '@clan/design';
import { webglAvailable } from '@clan/world';
import { SAVED, type SavedItem } from './demo/fixtures.ts';
import { QuickCapture, Guide, FocusOverlay, PerfHud } from './overlays.tsx';
import { Home } from './screens/home.tsx';
import { Commons, Mate } from './screens/commons.tsx';
import { StudyRoom } from './screens/study.tsx';
import { Saved } from './screens/saved.tsx';
import { Diary } from './screens/diary.tsx';
import { Exam } from './screens/exam.tsx';

const Campus = lazy(() => import('./screens/campus.tsx'));
export type Route = 'home' | 'commons' | 'mate' | 'study' | 'campus' | 'saved' | 'diary' | 'exam';
const NAV: [Route, string][] = [['home', 'My Space'], ['commons', 'Commons'], ['study', 'Study'], ['campus', 'Campus'], ['saved', 'Saved'], ['diary', 'Diary'], ['exam', 'Exams']];
const q = new URLSearchParams(location.search);

export type Lab = {
  go(r: Route, arg?: string): void; arg?: string; threeD: boolean; beacon: BeaconState; setBeacon(b: BeaconState): void;
  saved: SavedItem[]; setSaved(s: SavedItem[]): void; toast(t: string): void;
};

const parse = (): [Route, string | undefined] => { const [r, a] = location.hash.slice(2).split('/'); return [(NAV.some(([n]) => n === r) || r === 'mate' ? r : 'home') as Route, a]; };

function App() {
  const [[route, arg], setRoute] = useState(parse);
  const [threeD, setThreeD] = useState(q.get('3d') !== '0' && webglAvailable());
  const [beacon, setBeacon] = useState<BeaconState>('available');
  const [saved, setSaved] = useState(SAVED);
  const [focus, setFocus] = useState(false);
  const [toastText, setToast] = useState('');
  useEffect(() => { const on = () => setRoute(parse()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  useEffect(() => { if (q.get('theme')) document.documentElement.dataset.theme = q.get('theme')!; }, []);
  useEffect(() => { if (!toastText) return; const t = setTimeout(() => setToast(''), 2200); return () => clearTimeout(t); }, [toastText]);
  useEffect(() => { document.documentElement.dataset.mode = route === 'exam' ? 'exam' : ''; }, [route]);
  const lab: Lab = { go: (r, a) => { location.hash = `/${r}${a ? `/${a}` : ''}`; }, arg, threeD, beacon, setBeacon, saved, setSaved, toast: setToast };
  const toggleFocus = () => { setFocus(!focus); setBeacon(focus ? 'available' : 'focus'); };

  return (
    <div className={`lab ${focus ? 'is-focus' : ''}`}>
      <header className="topbar">
        <a className="brand" href="#/home">CLAN</a>
        <span className="c-chip demo-chip" title="Everything here is invented demo data">Visual Lab · demo data</span>
        <div className="top-actions">
          <label className="beacon-pick" title="Your Beacon">
            <CLANBeacon state={beacon} size={20} />
            <select value={beacon} onChange={(e) => setBeacon(e.target.value as BeaconState)} aria-label="Your Beacon">
              {BEACON_STATES.map((s) => <option key={s} value={s}>{BEACON_LABEL[s]}</option>)}
            </select>
          </label>
          <button className="c-btn" onClick={toggleFocus} aria-pressed={focus}>{focus ? 'End focus' : 'Focus'}</button>
          <button className="c-btn ghost hide-sm" onClick={() => setThreeD(!threeD)} aria-pressed={threeD} disabled={!webglAvailable()}>3D {threeD ? 'on' : 'off'}</button>
        </div>
      </header>
      <nav className="nav" aria-label="Screens">
        {NAV.map(([r, label]) => <a key={r} href={`#/${r}`} aria-current={route === r || (r === 'commons' && route === 'mate') ? 'page' : undefined}>{label}</a>)}
      </nav>
      <main className="stage" key={route}>
        {route === 'home' && <Home lab={lab} />}
        {route === 'commons' && <Commons lab={lab} />}
        {route === 'mate' && <Mate lab={lab} />}
        {route === 'study' && <StudyRoom lab={lab} />}
        {route === 'campus' && <Suspense fallback={<p className="muted pad">Loading campus…</p>}><Campus lab={lab} /></Suspense>}
        {route === 'saved' && <Saved lab={lab} />}
        {route === 'diary' && <Diary />}
        {route === 'exam' && <Exam lab={lab} />}
      </main>
      {route !== 'diary' && <Guide route={route} />}
      <QuickCapture onCapture={(item) => { setSaved([item, ...saved]); setToast(`Saved to Inbox: ${item.title}`); }} />
      {focus && <FocusOverlay onEnd={toggleFocus} />}
      {toastText && <div className="toast" role="status">{toastText}</div>}
      {q.get('perf') === '1' && <PerfHud />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

// Knowledge Campus. Legend states what each dimension means; the 2D fallback encodes the same data.
import { lazy, Suspense, useState } from 'react';
import { loadCampus, type CourseBuildingViewModel } from '@clan/world';
import { COURSES } from '../demo/fixtures.ts';
import { markScene } from '../overlays.tsx';
import type { Lab } from '../main.tsx';

const t0 = { v: 0 };
const CampusScene = lazy(() => { t0.v = performance.now(); return loadCampus(); });

function Flat({ focus, onSelect }: { focus?: string; onSelect(id: string): void }) {
  const terms = [...new Set(COURSES.map((c) => c.term))].sort();
  return (
    <div className="campus-2d">
      {terms.map((t) => (
        <div key={t} className="term"><span className="c-eyebrow">Term {t}</span>
          <div className="blocks">{COURSES.filter((c) => c.term === t).map((c) => <Tower key={c.id} c={c} on={c.id === focus} onClick={() => onSelect(c.id)} />)}</div>
        </div>
      ))}
    </div>
  );
}
function Tower({ c, on, onClick }: { c: CourseBuildingViewModel; on: boolean; onClick(): void }) {
  return (
    <button className={`tower ${on ? 'on' : ''}`} onClick={onClick} aria-label={`${c.code}: ${c.lectures.filter((l) => l.done).length}/${c.lectures.length} lectures, ${c.studyingNow} studying now`}>
      <span className="floors">{[...c.lectures].reverse().map((l) => <span key={l.id} className="floor" style={{ background: l.done ? c.color : undefined }} />)}</span>
      <span className="lit">{Array.from({ length: c.studyingNow }, (_, i) => <i key={i} />)}</span>
      <span className="kiosks">{Array.from({ length: c.resources }, (_, i) => <i key={i} />)}</span>
      <b>{c.code}</b>
    </button>
  );
}

export default function Campus({ lab }: { lab: Lab }) {
  const [focus, setFocus] = useState<string | undefined>();
  const c = COURSES.find((x) => x.id === focus);
  return (
    <div className="split">
      <div className="scene">
        {lab.threeD
          ? <Suspense fallback={<Flat focus={focus} onSelect={setFocus} />}><CampusScene courses={COURSES} focusId={focus} onSelect={(id) => setFocus(id ?? undefined)} onReady={() => markScene('campus', t0.v)} /></Suspense>
          : <Flat focus={focus} onSelect={setFocus} />}
      </div>
      <aside className="side">
        {!c ? <>
          <h1 className="c-title">Knowledge Campus</h1>
          <p className="muted">Your courses as buildings. Select one to walk in.</p>
          <dl className="legend">
            <dt><i className="lg floor" /></dt><dd><b>Floor</b> = one lecture. Solid when attended, pale when still ahead.</dd>
            <dt><i className="lg lit" /></dt><dd><b>Lit window</b> = someone in your CLANs studying it right now.</dd>
            <dt><i className="lg kiosk" /></dt><dd><b>Kiosk</b> = a shared resource (notes, past paper, slides).</dd>
            <dt><i className="lg path" /></dt><dd><b>Path</b> = prerequisite. Column = term.</dd>
          </dl>
          {COURSES.map((x) => <button key={x.id} className="person-row" onClick={() => setFocus(x.id)}><i className="swatch" style={{ background: x.color }} /><span><b>{x.code}</b><small>{x.name}</small></span><small>{x.lectures.filter((l) => l.done).length}/{x.lectures.length}</small></button>)}
        </> : <div className="enter">
          <button className="c-btn ghost" onClick={() => setFocus(undefined)}>← Campus</button>
          <span className="c-eyebrow">{c.code} · term {c.term}</span>
          <h1 className="c-title">{c.name}</h1>
          <p className="muted">{c.studyingNow} studying now · {c.resources} resources{c.prerequisites.length ? ` · needs ${c.prerequisites.map((p) => COURSES.find((x) => x.id === p)?.code).join(', ')}` : ''}</p>
          <ol className="floors-list">{[...c.lectures].reverse().map((l, i) => <li key={l.id} className={l.done ? 'done' : ''} style={{ ['--c' as string]: c.color }}><span>Floor {c.lectures.length - i}</span>{l.title}</li>)}</ol>
          <button className="c-btn primary" onClick={() => lab.go('study')}>Study this course</button>
        </div>}
      </aside>
    </div>
  );
}

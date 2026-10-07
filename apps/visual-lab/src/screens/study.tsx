// Study Room: one wall (screen share ⇄ whiteboard), one shared table, and practical panels.
import { useRef, useState, type PointerEvent } from 'react';
import { BEACON_LABEL, CLANBeacon, CLANmate, ResourceCard, StudyTable } from '@clan/design';
import { FILES, ME, PEOPLE } from '../demo/fixtures.ts';
import type { Lab } from '../main.tsx';

const TABS = ['Chat', 'Files', 'Notes', 'Members', 'AI', 'Tasks'] as const;
const members = [PEOPLE[0]!, PEOPLE[2]!, PEOPLE[4]!, PEOPLE[1]!];

function Slide() {
  return (
    <div className="slide">
      <span className="c-eyebrow">Lucía is sharing · Lecture 6</span>
      <h2>Dijkstra's shortest paths</h2>
      <svg viewBox="0 0 300 140" aria-label="Graph diagram">
        {[[40, 70, 120, 30], [40, 70, 120, 110], [120, 30, 210, 30], [120, 110, 210, 110], [120, 30, 120, 110], [210, 30, 270, 70], [210, 110, 270, 70]].map(([a, b, c, d], i) =>
          <line key={i} x1={a} y1={b} x2={c} y2={d} stroke={i < 2 || i === 5 ? 'var(--clay)' : 'var(--line)'} strokeWidth="4" />)}
        {[[40, 70, 'S'], [120, 30, 'A'], [120, 110, 'B'], [210, 30, 'C'], [210, 110, 'D'], [270, 70, 'T']].map(([x, y, l]) => <g key={l}><circle cx={x} cy={y} r="15" fill="var(--surface)" stroke="var(--ink)" strokeWidth="3" /><text x={x} y={Number(y) + 5} textAnchor="middle" style={{ font: '700 13px var(--font-body)' }}>{l}</text></g>)}
      </svg>
    </div>
  );
}

function Whiteboard() {
  const [paths, setPaths] = useState<string[]>([]);
  const drawing = useRef(false);
  const pt = (e: PointerEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); return `${Math.round(((e.clientX - r.left) / r.width) * 600)} ${Math.round(((e.clientY - r.top) / r.height) * 188)}`; };
  return (
    <div className="board">
      <svg viewBox="0 0 600 188" aria-label="Whiteboard — draw with mouse, pen or finger"
        onPointerDown={(e) => { drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId); setPaths([...paths, `M${pt(e)}`]); }}
        onPointerMove={(e) => { if (drawing.current) setPaths((p) => [...p.slice(0, -1), `${p.at(-1)} L${pt(e)}`]); }}
        onPointerUp={() => { drawing.current = false; }}>
        <text x="20" y="34" className="board-hint">{paths.length ? '' : 'Draw here — everyone at the table sees it'}</text>
        {paths.map((d, i) => <path key={i} d={d} fill="none" stroke="var(--ink)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />)}
      </svg>
      {paths.length > 0 && <button className="c-btn ghost" onClick={() => setPaths([])}>Clear</button>}
    </div>
  );
}

export function StudyRoom({ lab }: { lab: Lab }) {
  const [wall, setWall] = useState<'screen' | 'board'>('screen');
  const [tab, setTab] = useState<(typeof TABS)[number]>('Chat');
  const [tasks, setTasks] = useState([{ t: 'Finish PS4 Q2', done: true }, { t: 'Trace Dijkstra on the slide graph', done: false }, { t: 'Swap notes with Hana', done: false }]);
  const [msgs, setMsgs] = useState(['Hana: anyone got the heap proof?', 'Mei: page 4 of my notes', 'Lucía: sharing the slides now']);
  return (
    <div className="study">
      <div className="study-main">
        <div className="row between"><div><span className="c-eyebrow">Study Room · Thursday group</span><h1 className="c-title">CS-201 — Graphs</h1></div>
          <div className="seg" role="tablist" aria-label="Wall">
            <button role="tab" aria-selected={wall === 'screen'} onClick={() => setWall('screen')}>Screen</button>
            <button role="tab" aria-selected={wall === 'board'} onClick={() => setWall('board')}>Whiteboard</button>
          </div></div>
        <div className={`wall ${wall}`}>{wall === 'screen' ? <Slide /> : <Whiteboard />}</div>
        <StudyTable seats={[{ name: 'You', spec: ME.spec, beacon: lab.beacon }, ...members.map((p) => ({ name: p.name, spec: p.spec, beacon: p.beacon }))]}
          items={[{ label: 'PS4', tint: 'var(--clay-soft)' }, { label: 'Notes', tint: 'var(--mustard-soft)' }, { label: 'Slides', tint: 'var(--sky-soft)' }]} />
      </div>
      <aside className="panel">
        <div className="tabs" role="tablist">{TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
        <div className="panel-body">
          {tab === 'Chat' && <form onSubmit={(e) => { e.preventDefault(); const i = e.currentTarget.elements.namedItem('m') as HTMLInputElement; if (i.value.trim()) { setMsgs([...msgs, `You: ${i.value.trim()}`]); i.value = ''; } }}>
            {msgs.map((m, i) => <p key={i} className={`msg ${m.startsWith('You') ? 'me' : ''}`}>{m}</p>)}<input name="m" placeholder="Message the table" /></form>}
          {tab === 'Files' && FILES.map((f) => <ResourceCard key={f.id} title={f.title} kind={f.kind} bytes={f.bytes} from="on the table" />)}
          {tab === 'Notes' && <textarea className="notes" defaultValue={'Dijkstra\n- greedy: always expand the closest unvisited node\n- fails with negative edges → Bellman-Ford'} aria-label="Shared notes" />}
          {tab === 'Members' && members.map((p) => <div key={p.id} className="person-row static"><CLANmate spec={p.spec} size={40} /><span><b>{p.name}</b><small>{BEACON_LABEL[p.beacon]}</small></span><CLANBeacon state={p.beacon} size={18} /></div>)}
          {tab === 'AI' && <div className="ai-panel"><span className="c-eyebrow">Guide · sees the wall and table files only</span>
            {['Make 5 flashcards from the slide', 'Explain why negative edges break it', 'Quiz the table for 10 minutes'].map((s) => <button key={s} className="c-btn" onClick={() => lab.toast('AI is not connected in the Visual Lab')}>{s}</button>)}</div>}
          {tab === 'Tasks' && tasks.map((t, i) => <label key={t.t} className="task"><input type="checkbox" checked={t.done} onChange={() => setTasks(tasks.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))} />{t.t}</label>)}
        </div>
      </aside>
    </div>
  );
}

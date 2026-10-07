import { useEffect, useRef, useState } from 'react';
import type { SavedItem } from './demo/fixtures.ts';
import type { Route } from './main.tsx';

type Kind = 'Note' | 'Voice' | 'Scan' | 'Link' | 'File' | 'Idea';
const KINDS: { k: Kind; icon: string; ready: boolean }[] = [
  { k: 'Note', icon: '✎', ready: true }, { k: 'Voice', icon: '◉', ready: false }, { k: 'Scan', icon: '▣', ready: false },
  { k: 'Link', icon: '↗', ready: true }, { k: 'File', icon: '▤', ready: true }, { k: 'Idea', icon: '✦', ready: true },
];

/** + → pick a kind → one field → Inbox. Voice and Scan need device capture and are not part of the lab. */
export function QuickCapture({ onCapture }: { onCapture(i: SavedItem): void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const [text, setText] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const done = (title: string, source: string, url = '#') => { onCapture({ id: crypto.randomUUID(), col: 'Inbox', title, source, url, tags: [] }); setOpen(false); setKind(null); setText(''); };
  const submit = () => {
    if (!text.trim()) return;
    if (kind === 'Link') { try { const u = new URL(text.trim()); done(u.hostname + u.pathname.replace(/\/$/, ''), u.hostname.replace(/^www\./, ''), u.href); } catch { /* keep the sheet open */ } return; }
    done(text.trim(), kind === 'Idea' ? 'idea' : 'note');
  };
  return (
    <div className={`qc ${open ? 'open' : ''}`}>
      {open && !kind && (
        <div className="qc-menu" role="menu">
          {KINDS.map(({ k, icon, ready }, i) => (
            <button key={k} role="menuitem" className="qc-item" style={{ ['--i' as string]: i }} disabled={!ready}
              onClick={() => (k === 'File' ? file.current?.click() : setKind(k))}>
              <span className="qc-icon" aria-hidden>{icon}</span>{k}{!ready && <small>not in lab</small>}
            </button>
          ))}
        </div>
      )}
      {kind && (
        <form className="qc-sheet c-card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <span className="c-eyebrow">{kind} → Inbox</span>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'Link' ? 'https://…' : kind === 'Idea' ? 'What if…' : 'Write it down'} />
          <div className="row"><button type="button" className="c-btn ghost" onClick={() => setKind(null)}>Back</button><button className="c-btn primary">Save</button></div>
        </form>
      )}
      <input ref={file} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) done(f.name, 'file'); }} />
      <button className="qc-fab" aria-expanded={open} aria-label="Quick Capture" onClick={() => { setOpen(!open); setKind(null); }}>+</button>
    </div>
  );
}

const HINTS: Partial<Record<Route, string[]>> = {
  home: ['Your CS-201 exam is in 6 days — Shortest paths is your weakest topic.', 'Hana is at your table and has the lecture 6 notes.'],
  commons: ['Mei is in focus mode — send files now, she will see them later.'],
  mate: ['Drag a file onto Hana to send it directly; nothing leaves the local network.'],
  study: ['Lecture 6 slides are on the wall. Ask the Guide to make 5 flashcards from them?'],
  campus: ['CS-310 needs CS-201 and MATH-210 — both still have open floors.'],
  saved: ['3 items in Inbox. Most look like CS-201 — file them there?'],
  exam: ['Two 25-minute blocks on Shortest paths today would lift readiness the most.'],
};

/** The Guide is a quiet shape, not a character. It speaks only when it has something about this screen. Never on Diary. */
export function Guide({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const hints = HINTS[route] ?? [];
  useEffect(() => setOpen(false), [route]);
  useEffect(() => { const on = () => setOpen(true); addEventListener('clan:guide', on); return () => removeEventListener('clan:guide', on); }, []);
  return (
    <div className="guide">
      {open && <div className="guide-card c-card" role="dialog" aria-label="CLAN Guide">
        <span className="c-eyebrow">Guide · demo suggestions</span>
        {hints.map((h) => <p key={h}>{h}</p>)}
        <p className="muted small">Only sees what this screen shows you. Never your Diary.</p>
      </div>}
      <button className={`guide-orb ${hints.length ? 'has' : ''}`} aria-label="CLAN Guide" aria-expanded={open} onClick={() => setOpen(!open)}><i /><i /><i /></button>
    </div>
  );
}

export function FocusOverlay({ onEnd }: { onEnd(): void }) {
  const [left, setLeft] = useState(25 * 60);
  useEffect(() => { const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="focus-overlay" role="status">
      <div className="focus-timer"><span className="c-eyebrow">Focus · Beacon set to do-not-disturb</span><b>{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}</b><button className="c-btn" onClick={onEnd}>End focus</button></div>
    </div>
  );
}

declare global { interface Window { __clanPerf?: { fps: number; heapMB: number | null; sceneMs: Record<string, number> } } }
export function PerfHud() {
  const [s, set] = useState({ fps: 0, heap: null as number | null });
  useEffect(() => {
    let frames = 0, raf = 0, last = performance.now();
    const loop = (t: number) => {
      frames++;
      if (t - last >= 1000) {
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        const v = { fps: Math.round((frames * 1000) / (t - last)), heap: mem ? Math.round(mem.usedJSHeapSize / 1e6) : null };
        set(v); window.__clanPerf = { sceneMs: {}, ...window.__clanPerf, fps: v.fps, heapMB: v.heap };
        frames = 0; last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div className="perf">{s.fps} fps{s.heap !== null && ` · ${s.heap} MB heap`}</div>;
}

/** Records how long a lazily-loaded 3D scene took from request to first rendered frame. */
export const markScene = (name: string, start: number) => { window.__clanPerf = { fps: 0, heapMB: null, ...window.__clanPerf, sceneMs: { ...window.__clanPerf?.sceneMs, [name]: Math.round(performance.now() - start) } }; };

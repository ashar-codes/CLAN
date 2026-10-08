// The whiteboard surface: one 2D canvas with viewport culling (only objects in view are drawn; redraws happen on change,
// never in a loop), pan/zoom, and a small toolset for diagrams, math sketches, brainstorming and explaining.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as RKE, type PointerEvent as RPE } from 'react';
import { bounds, hit, intersects, simplify, visible, type WbObject, type WbObjectData } from '@classroom/protocol';
import type { BoardModel } from './useBoard.ts';
import { api } from '../../App.tsx';

export type Tool = 'select' | 'hand' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'sticky';
const TOOLS: [Tool, string, string][] = [['select', '↖', 'Select / move'], ['hand', '✋', 'Pan'], ['pen', '✎', 'Pen'], ['highlighter', '▬', 'Highlighter'], ['eraser', '⌫', 'Eraser'], ['text', 'T', 'Text'],
  ['line', '╱', 'Line'], ['arrow', '➚', 'Arrow'], ['rect', '▭', 'Rectangle'], ['ellipse', '◯', 'Circle'], ['sticky', '▤', 'Sticky note']];
const COLORS = ['#17233b', '#c0392b', '#1f6feb', '#1a7f37', '#b7791f', '#8250df'];
export type Placeable = { module: 'resource' | 'notes' | 'saved'; id: string; title: string; mime?: string; url?: string };
type View = { x: number; y: number; z: number };

export function BoardView({ board, placeables = [], onPlace, title, readOnlyReason }: { board: BoardModel; placeables?: Placeable[]; onPlace?(p: Placeable): Promise<boolean> | boolean; title: string; readOnlyReason?: string }) {
  const can = board.view?.canEdit ?? false;
  const box = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>(can ? 'pen' : 'hand');
  const [color, setColor] = useState(COLORS[0]!);
  const [width, setWidth] = useState(3);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ x: number; y: number; kind: 'text' | 'sticky'; obj?: string; value: string } | null>(null);
  const [placing, setPlacing] = useState(false);
  const draft = useRef<{ kind: Tool; pts: [number, number][]; start: [number, number]; cur: [number, number]; pressure: number[] } | null>(null);
  const drag = useRef<{ mode: 'pan' | 'move' | 'erase'; sx: number; sy: number; vx: number; vy: number; obj?: string; ox?: number; oy?: number; erased?: Set<string> } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const pendingText = useRef<{ x: number; y: number; kind: 'text' | 'sticky' } | null>(null);
  useEffect(() => { if (!can && !['hand', 'select'].includes(tool)) setTool('hand'); }, [can, tool]);
  useLayoutEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: Math.max(320, el.clientHeight) })); ro.observe(el); return () => ro.disconnect(); }, []);
  const toWorld = (e: { clientX: number; clientY: number }) => { const r = cv.current!.getBoundingClientRect(); return [(e.clientX - r.left) / view.z + view.x, (e.clientY - r.top) / view.z + view.y] as [number, number]; };

  // ---- render (on change only) ----
  useEffect(() => {
    const c = cv.current; if (!c) return;
    const t0 = performance.now(), dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr; c.height = size.h * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, size.w, size.h);
    g.save(); g.scale(view.z, view.z); g.translate(-view.x, -view.y);
    const vr = { x: view.x, y: view.y, w: size.w / view.z, h: size.h / view.z };
    let drawn = 0;
    const erasing = drag.current?.erased;
    for (const o of visible(board.state.current, 0)) { if (erasing?.has(o.id) || !intersects(bounds(o), vr)) continue; draw(g, o, o.id === sel); drawn++; }
    const d = draft.current;
    if (d) draw(g, draftObj(d, color, width), false);
    g.restore();
    for (const c2 of Object.values(board.cursors)) { const sx = (c2.x - view.x) * view.z, sy = (c2.y - view.y) * view.z; g.fillStyle = '#8250df'; g.beginPath(); g.arc(sx, sy, 4, 0, 7); g.fill(); g.font = '12px sans-serif'; g.fillText(c2.name, sx + 6, sy - 6); }
    (window as unknown as { __clanBoardPerf?: object }).__clanBoardPerf = { renderMs: performance.now() - t0, drawn, objects: board.state.current.objects.size };
  });

  const finishDraft = () => {
    const d = draft.current; draft.current = null; if (!d) return;
    const data = draftObj(d, color, width);
    if (d.kind === 'pen' || d.kind === 'highlighter') { if ((data.points?.length ?? 0) < 2) return; }
    else if (Math.hypot(data.w, data.h) < 3) return;
    board.commit([board.op.put(data)]);
  };
  const down = (e: RPE<HTMLCanvasElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const [x, y] = toWorld(e);
    if (tool === 'hand' || e.button === 1 || e.shiftKey && tool === 'select') { drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; return; }
    if (!can) return;
    if (tool === 'select') { const o = hit(board.state.current, 0, x, y, 6 / view.z); setSel(o?.id ?? null); if (o) drag.current = { mode: 'move', sx: x, sy: y, vx: 0, vy: 0, obj: o.id, ox: o.x, oy: o.y }; return; }
    if (tool === 'eraser') { drag.current = { mode: 'erase', sx: x, sy: y, vx: 0, vy: 0, erased: new Set() }; eraseAt(x, y); return; }
    if (tool === 'text' || tool === 'sticky') { e.preventDefault(); pendingText.current = { x, y, kind: tool }; return; } // opens on release, so the click doesn't blur it
    draft.current = { kind: tool, pts: [[0, 0]], start: [x, y], cur: [x, y], pressure: [e.pressure || 0.5] };
  };
  const move = (e: RPE<HTMLCanvasElement>) => {
    const [x, y] = toWorld(e);
    board.cursor(x, y, 0);
    const dr = drag.current;
    if (dr?.mode === 'pan') { setView({ ...view, x: dr.vx - (e.clientX - dr.sx) / view.z, y: dr.vy - (e.clientY - dr.sy) / view.z }); return; }
    if (dr?.mode === 'erase') { eraseAt(x, y); return; }
    if (dr?.mode === 'move') { const o = board.state.current.objects.get(dr.obj!); if (o) { o.x = dr.ox! + x - dr.sx; o.y = dr.oy! + y - dr.sy; setView({ ...view }); } return; }
    const d = draft.current; if (!d) return;
    d.cur = [x, y];
    if (d.kind === 'pen' || d.kind === 'highlighter') { d.pts.push([x - d.start[0], y - d.start[1]]); d.pressure.push(e.pressure || 0.5); }
    setView({ ...view }); // repaint
  };
  const up = (e: RPE<HTMLCanvasElement>) => {
    const pt = pendingText.current; pendingText.current = null;
    if (pt) { setEditing({ ...pt, value: '' }); return; }
    const dr = drag.current; drag.current = null;
    if (dr?.mode === 'move') { const [x, y] = toWorld(e); const nx = dr.ox! + x - dr.sx, ny = dr.oy! + y - dr.sy; const o = board.state.current.objects.get(dr.obj!);
      if (o) { o.x = dr.ox!; o.y = dr.oy!; if (Math.hypot(nx - dr.ox!, ny - dr.oy!) > 0.5) board.commit([board.op.patch(dr.obj!, { x: nx, y: ny })]); } }
    if (dr?.mode === 'erase' && dr.erased?.size) board.commit([...dr.erased].map((id) => board.op.del(id)));
    finishDraft();
  };
  const eraseAt = (x: number, y: number) => { const o = hit(board.state.current, 0, x, y, 8 / view.z); if (o && drag.current?.erased && !drag.current.erased.has(o.id)) { drag.current.erased.add(o.id); setView({ ...view }); } }; // hidden in the preview; deleted on release (undo-able)
  const wheel = (e: React.WheelEvent) => { const [x, y] = toWorld(e); const z = Math.min(8, Math.max(0.1, view.z * (e.deltaY < 0 ? 1.1 : 0.9))); setView({ z, x: x - (x - view.x) * (view.z / z), y: y - (y - view.y) * (view.z / z) }); };
  const key = (e: RKE) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) board.redo(); else board.undo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && can && !editing) { board.commit([board.op.del(sel)]); setSel(null); }
    else if (e.key === 'Escape') { setSel(null); setEditing(null); }
  };
  const commitText = () => {
    const ed = editing; setEditing(null); if (!ed || !ed.value.trim()) return;
    if (ed.obj) board.commit([board.op.patch(ed.obj, { text: ed.value })]);
    else board.commit([board.op.put(ed.kind === 'sticky' ? { kind: 'sticky', page: 0, x: ed.x, y: ed.y, w: 170, h: 120, color: '#17233b', fill: '#fde68a', width: 1, z: Date.now() % 1e9, text: ed.value } : { kind: 'text', page: 0, x: ed.x, y: ed.y, w: 0, h: 0, color, width: Math.max(14, width * 5), z: Date.now() % 1e9, text: ed.value })]);
  };
  const place = async (p: Placeable) => {
    setPlacing(false);
    if (onPlace && !(await onPlace(p))) return;
    const cx = view.x + size.w / view.z / 2 - 100, cy = view.y + size.h / view.z / 2 - 40;
    board.commit([board.op.put({ kind: p.module === 'resource' ? 'resource' : p.module === 'notes' ? 'note' : 'link', page: 0, x: cx, y: cy, w: 200, h: 80, color: '#17233b', width: 1, z: Date.now() % 1e9,
      ref: { module: p.module, id: p.id, title: p.title.slice(0, 200), ...(p.mime ? { mime: p.mime } : {}), ...(p.url ? { url: p.url } : {}) } })]);
  };
  const exportAs = async (fmt: 'png' | 'pdf') => {
    const objs = visible(board.state.current, 0); if (!objs.length) return board.setError('The board is empty.');
    const b = objs.map(bounds).reduce((a, c) => ({ x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.max(a.x + a.w, c.x + c.w), h: Math.max(a.y + a.h, c.y + c.h) }), { x: Infinity, y: Infinity, w: -Infinity, h: -Infinity });
    const pad = 24, W = Math.min(8000, b.w - b.x + 2 * pad), H = Math.min(8000, b.h - b.y + 2 * pad);
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), g = c.getContext('2d')!;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H); g.translate(pad - b.x, pad - b.y);
    for (const o of objs) draw(g, o, false);
    try { const where = await api.board.export(fmt, c.toDataURL('image/png'), title); if (where) board.setError(`Exported to ${where}`); } catch (e) { board.setError(String((e as Error).message)); }
  };
  const texts = visible(board.state.current, 0).filter((o) => o.text || o.ref);
  return (
    <div className="board" data-testid="board" onKeyDown={key}>
      <div className="board-tools" role="toolbar" aria-label="Whiteboard tools">
        {TOOLS.filter(([t]) => can || t === 'hand' || t === 'select').map(([t, ic, label]) => <button key={t} className={`small tool ${tool === t ? 'on' : ''}`} aria-pressed={tool === t} aria-label={label} title={label} onClick={() => setTool(t)}>{ic}</button>)}
        {can && <>
          <span className="tool-sep" />
          {COLORS.map((c) => <button key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={color === c} onClick={() => setColor(c)} />)}
          <input type="range" min={1} max={20} value={width} onChange={(e) => setWidth(Number(e.target.value))} aria-label="Stroke width" />
          <button className="small" onClick={() => setPlacing(!placing)} aria-expanded={placing}>Place…</button>
          <button className="small" onClick={board.undo} aria-label="Undo">↶</button><button className="small" onClick={board.redo} aria-label="Redo">↷</button>
          <button className="small" onClick={() => setSel(null)} disabled={!sel}>Clear selection</button>
        </>}
        <span className="grow" />
        <button className="small" onClick={() => setView({ x: 0, y: 0, z: 1 })} aria-label="Reset view">⟲</button>
        <button className="small" onClick={() => void exportAs('png')}>PNG</button><button className="small" onClick={() => void exportAs('pdf')}>PDF</button>
      </div>
      {placing && <div className="board-place card" role="listbox" aria-label="Place on the board">
        {placeables.length ? placeables.map((p) => <button key={p.module + p.id} className="line link-row" role="option" onClick={() => void place(p)}><span>{p.module === 'resource' ? '▤' : p.module === 'notes' ? '✎' : '↗'} {p.title}</span><small className="muted">{p.module === 'resource' ? 'on the table' : p.module === 'notes' ? 'note card (title only)' : 'link card'}</small></button>)
          : <p className="muted small-text">Nothing to place. Put a file on the table first; only shared files can go on a CLAN board.</p>}
      </div>}
      {!can && <p className="muted small-text board-ro" role="status">{readOnlyReason ?? 'View only'}</p>}
      {board.error && <p className="error small-text" role="alert">{board.error} <button className="link small" onClick={() => board.setError('')}>dismiss</button></p>}
      <div className="board-canvas" ref={box}>
        <canvas ref={cv} style={{ width: size.w, height: size.h, cursor: tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair', touchAction: 'none' }} tabIndex={0}
          role="img" aria-label={`${title}: ${visible(board.state.current, 0).length} objects`} data-testid="board-canvas"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { draft.current = null; drag.current = null; }} onWheel={wheel}
          onDoubleClick={(e) => { if (!can) return; const [x, y] = toWorld(e); const o = hit(board.state.current, 0, x, y); if (o && (o.kind === 'text' || o.kind === 'sticky')) setEditing({ x: o.x, y: o.y, kind: o.kind, obj: o.id, value: o.text ?? '' }); }} />
        {editing && <textarea autoFocus className="board-edit" aria-label={editing.kind === 'sticky' ? 'Sticky note text' : 'Text on the board'} value={editing.value}
          style={{ left: (editing.x - view.x) * view.z, top: (editing.y - view.y) * view.z }} onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); } if (e.key === 'Escape') setEditing(null); }} onBlur={commitText} />}
      </div>
      <ul className="sr-only" aria-label="Board text">{texts.map((o) => <li key={o.id}>{o.kind}: {o.text ?? o.ref?.title}</li>)}</ul>
    </div>
  );
}

function draftObj(d: NonNullable<{ kind: Tool; pts: [number, number][]; start: [number, number]; cur: [number, number]; pressure: number[] }>, color: string, width: number): WbObjectData {
  const z = Date.now() % 1e9;
  if (d.kind === 'pen' || d.kind === 'highlighter') {
    // simplified and capped: one stroke stays a small message (< ~25 KB)
    let pts = simplify(d.pts, d.kind === 'highlighter' ? 1.5 : 0.6);
    if (pts.length > 1500) pts = simplify(d.pts, 3).slice(0, 1500);
    return { kind: 'stroke', page: 0, x: d.start[0], y: d.start[1], w: 0, h: 0, points: pts, color, width: d.kind === 'highlighter' ? Math.max(12, width * 4) : width, z, ...(d.kind === 'highlighter' ? { highlighter: true } : {}) };
  }
  const kind = d.kind === 'line' ? 'line' : d.kind === 'arrow' ? 'arrow' : d.kind === 'rect' ? 'rect' : 'ellipse';
  return { kind, page: 0, x: d.start[0], y: d.start[1], w: d.cur[0] - d.start[0], h: d.cur[1] - d.start[1], color, width, z };
}

function draw(g: CanvasRenderingContext2D, o: WbObjectData, selected: boolean) {
  g.save();
  g.strokeStyle = o.color; g.fillStyle = o.color; g.lineWidth = o.width; g.lineCap = 'round'; g.lineJoin = 'round';
  if (o.highlighter) g.globalAlpha = 0.32;
  switch (o.kind) {
    case 'stroke': { const p = o.points ?? []; g.beginPath(); p.forEach(([x, y], i) => (i ? g.lineTo(o.x + x, o.y + y) : g.moveTo(o.x + x, o.y + y))); if (p.length === 1) g.lineTo(o.x + p[0]![0] + 0.1, o.y + p[0]![1]); g.stroke(); break; }
    case 'line': case 'arrow': {
      g.beginPath(); g.moveTo(o.x, o.y); g.lineTo(o.x + o.w, o.y + o.h); g.stroke();
      if (o.kind === 'arrow') { const a = Math.atan2(o.h, o.w), L = 10 + o.width * 2; g.beginPath(); g.moveTo(o.x + o.w, o.y + o.h); g.lineTo(o.x + o.w - L * Math.cos(a - 0.45), o.y + o.h - L * Math.sin(a - 0.45)); g.moveTo(o.x + o.w, o.y + o.h); g.lineTo(o.x + o.w - L * Math.cos(a + 0.45), o.y + o.h - L * Math.sin(a + 0.45)); g.stroke(); }
      break;
    }
    case 'rect': g.strokeRect(o.x, o.y, o.w, o.h); break;
    case 'ellipse': g.beginPath(); g.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.abs(o.w / 2), Math.abs(o.h / 2), 0, 0, 7); g.stroke(); break;
    case 'text': g.font = `${o.width}px sans-serif`; g.textBaseline = 'top'; (o.text ?? '').split('\n').forEach((l, i) => g.fillText(l, o.x, o.y + i * o.width * 1.25)); break;
    case 'sticky': g.fillStyle = o.fill ?? '#fde68a'; g.shadowColor = 'rgba(0,0,0,.18)'; g.shadowBlur = 6; g.fillRect(o.x, o.y, o.w, o.h); g.shadowBlur = 0; g.fillStyle = o.color; g.font = '15px sans-serif'; g.textBaseline = 'top'; wrap(g, o.text ?? '', o.x + 10, o.y + 10, o.w - 20, 19); break;
    case 'resource': case 'note': case 'link': {
      g.fillStyle = '#ffffff'; g.strokeStyle = '#c9c2b4'; g.lineWidth = 1.5; g.fillRect(o.x, o.y, o.w, o.h); g.strokeRect(o.x, o.y, o.w, o.h);
      g.fillStyle = '#17233b'; g.font = '22px sans-serif'; g.textBaseline = 'top'; g.fillText(o.kind === 'resource' ? (/image/.test(o.ref?.mime ?? '') ? '🖼' : /pdf/.test(o.ref?.mime ?? '') ? '📄' : '▤') : o.kind === 'note' ? '✎' : '↗', o.x + 10, o.y + 10);
      g.font = 'bold 14px sans-serif'; wrap(g, o.ref?.title ?? '', o.x + 44, o.y + 12, o.w - 54, 18); g.font = '11px sans-serif'; g.fillStyle = '#6b6457';
      g.fillText(o.kind === 'resource' ? 'File on the CLAN table' : o.kind === 'note' ? 'Note' : (o.ref?.url ?? '').slice(0, 34), o.x + 44, o.y + o.h - 20); break;
    }
  }
  if (selected) { const b = bounds(o); g.globalAlpha = 1; g.setLineDash([5, 4]); g.strokeStyle = '#1f6feb'; g.lineWidth = 1; g.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8); }
  g.restore();
}
function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, lh: number) {
  let line = '', yy = y;
  for (const word of text.split(/\s+/)) { const t = line ? `${line} ${word}` : word; if (g.measureText(t).width > w && line) { g.fillText(line, x, yy); line = word; yy += lh; } else line = t; }
  if (line) g.fillText(line, x, yy);
}
export type { WbObject };

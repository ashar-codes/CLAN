// Tools over an immersive presentation: the floating + menu and a private note editor. Everything here is local UI —
// nothing is published as media, and notes stay in the person's own Inbox (docs/PRESENTATION_FULLSCREEN_UX.md).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../App.tsx';
import { errText } from './useLoad.ts';

export type ToolItem = { id: string; label: string; icon: string; run(): void };

/** Discreet + in the corner: fades while the pointer rests, opens a menu of tools without leaving fullscreen. */
export function ToolsFab({ items, idle }: { items: ToolItem[]; idle: boolean }) {
  const [open, setOpen] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) first.current?.focus(); }, [open]);
  return (
    <div className={`pt-fab-wrap ${idle && !open ? 'idle' : ''}`} onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}>
      {open && (
        <div className="pt-menu" role="menu" aria-label="Presentation tools">
          {items.map((it, i) => <button key={it.id} ref={i === 0 ? first : undefined} role="menuitem" className="qc-item" style={{ ['--i' as string]: i }} onClick={() => { setOpen(false); it.run(); }}><span className="qc-icon" aria-hidden>{it.icon}</span>{it.label}</button>)}
        </div>
      )}
      <button className="pt-fab" aria-label="Presentation tools" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)} data-testid="presentation-tools">+</button>
    </div>
  );
}

/** Small movable, resizable, collapsible panel over the presentation. */
export function FloatPanel({ title, onClose, children, testid, wide }: { title: string; onClose(): void; children: ReactNode; testid?: string; wide?: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [min, setMin] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const drag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = box.current!.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (m: PointerEvent) => setPos({ x: Math.max(0, Math.min(innerWidth - 80, m.clientX - dx)), y: Math.max(0, Math.min(innerHeight - 40, m.clientY - dy)) });
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  return (
    <div ref={box} className={`pt-panel card ${min ? 'min' : ''} ${wide ? 'wide' : ''}`} role="dialog" aria-label={title} data-testid={testid}
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}>
      <div className="pt-head" onPointerDown={drag}><b>{title}</b>
        <span className="row"><button className="small" onClick={() => setMin(!min)} aria-expanded={!min}>{min ? 'Expand' : 'Minimize'}</button><button className="small" onClick={onClose}>Close</button></span></div>
      <div className="pt-body" hidden={min}>{children}</div>
    </div>
  );
}

/** Private note taken while watching. Saved to the Inbox (works offline); never sent to the room or the chat. */
export function NoteEditor({ context, onClose, onSaved }: { context: string; onClose(): void; onSaved(msg: string): void }) {
  const [title, setTitle] = useState(`Notes — ${context}`);
  const [body, setBody] = useState('');
  const [stamp, setStamp] = useState(true);
  const [saved, setSaved] = useState<{ id: string; title: string; body: string } | null>(null);
  const [err, setErr] = useState('');
  const started = useRef(new Date());
  const text = () => (stamp ? `${body}\n\n— Taken during ${context}, ${started.current.toLocaleString()}` : body);
  const dirty = !!body.trim() && (!saved || saved.title !== title || saved.body !== text());
  const save = async () => {
    const t = title.trim() || 'Presentation notes', b = text();
    if (saved) await api.clan.updateNote(saved.id, { title: t, body: b });
    else { const it = await api.capture.add({ kind: 'note', title: t, body: b }); setSaved({ id: it.entityId, title: t, body: b }); return; }
    setSaved({ id: saved.id, title: t, body: b });
  };
  // Closing the presentation (or the window) while typing must not lose the note: save what is there.
  const latest = useRef({ dirty, save });
  latest.current = { dirty, save };
  useEffect(() => () => { if (latest.current.dirty) void latest.current.save().then(() => onSaved('Your presentation note was saved to your Inbox.')).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (dirty && !confirm('Discard the unsaved changes to this note?')) return; latest.current.dirty = false; onClose(); };
  return (
    <FloatPanel title="Notes" onClose={close} testid="presentation-notes">
      <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Note title" maxLength={200} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label="Note" placeholder="Type your notes…" autoFocus rows={8} maxLength={100_000} />
      <label className="check small-text"><input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} /> Add when and where this was taken</label>
      <p className="muted small-text">Private — saved to your Inbox, not shared with the room.</p>
      {err && <p className="error small-text">{err}</p>}
      <div className="row"><span className="muted small-text" role="status">{saved && !dirty ? 'Saved' : dirty ? 'Not saved yet' : ''}</span>
        <button className="primary small" disabled={!dirty} onClick={() => { setErr(''); void save().then(() => onSaved('Note saved to your Inbox.'), (x) => setErr(errText(x))); }}>Save</button></div>
    </FloatPanel>
  );
}

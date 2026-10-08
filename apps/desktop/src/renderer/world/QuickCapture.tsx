// Quick Capture: Note, Link, Text/Idea, File — everything lands in Personal Space › Inbox first (private until filed).
import { useState, type DragEvent } from 'react';
import { api } from '../App.tsx';
import { errText, useLoad } from './useLoad.ts';

export function QuickCapture({ onDone }: { onDone(msg: string, go?: 'notes' | 'saved'): void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'link' | 'text' | null>(null);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [col, setCol] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [cols] = useLoad(api.clan.collections);
  const close = () => { setOpen(false); setMode(null); setUrl(''); setNote(''); setTags(''); setCol(''); setText(''); setErr(''); };
  const run = async (f: () => Promise<unknown>, msg: string, go?: 'notes' | 'saved') => { try { await f(); close(); onDone(msg, go); } catch (x) { setErr(errText(x)); } };
  const drop = (e: DragEvent) => { e.preventDefault(); const files = [...e.dataTransfer.files]; if (files.length) void run(() => api.capture.dropped(files), `${files.length} file${files.length === 1 ? '' : 's'} added to your Inbox`, 'saved'); };
  return (
    <div className={`qc ${open ? 'open' : ''}`} onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={drop}>
      {open && !mode && (
        <div className="qc-menu" role="menu" aria-label="Quick Capture">
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 0 }} onClick={() => run(() => api.capture.add({ kind: 'note', title: 'Untitled' }), 'New note in your Inbox', 'notes')}><span className="qc-icon">✎</span>Note</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 1 }} onClick={() => setMode('link')}><span className="qc-icon">↗</span>Link</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 2 }} onClick={() => setMode('text')}><span className="qc-icon">❝</span>Text / idea</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 3 }} onClick={() => run(async () => { if (!(await api.capture.pick())) throw new Error('No file chosen.'); }, 'Added to your Inbox', 'saved')}><span className="qc-icon">▤</span>File</button>
        </div>
      )}
      {mode === 'link' && (
        <form className="qc-sheet card" onSubmit={(e) => { e.preventDefault(); void run(() => api.capture.add({ kind: 'link', url, note: note || undefined, tags: tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean), collectionId: col || undefined }), col ? 'Saved' : 'Saved to your Inbox — the title fills in when online', 'saved'); }}>
          <span className="eyebrow">Link → {col ? 'Saved' : 'Inbox'}</span>
          <input autoFocus type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="Link to save" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note about this link" maxLength={5000} />
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#tags (optional)" aria-label="Tags for this link" />
          <select value={col} onChange={(e) => setCol(e.target.value)} aria-label="Collection"><option value="">Inbox</option>{cols?.filter((c) => c.kind !== 'inbox').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <small className="muted">Only the link and its title are kept — never the video or page itself.</small>
          {err && <span className="error small-text">{err}</span>}
          <div className="row"><button type="button" onClick={() => setMode(null)}>Back</button><button className="primary" disabled={!url}>Save</button></div>
        </form>
      )}
      {mode === 'text' && (
        <form className="qc-sheet card" onSubmit={(e) => { e.preventDefault(); void run(() => api.capture.add({ kind: 'text', text }), 'Idea saved to your Inbox', 'saved'); }}>
          <span className="eyebrow">Text / idea → Inbox</span>
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={20000} aria-label="Text or idea" />
          {err && <span className="error small-text">{err}</span>}
          <div className="row"><button type="button" onClick={() => setMode(null)}>Back</button><button className="primary" disabled={!text.trim()}>Save</button></div>
        </form>
      )}
      {err && !mode && <span className="error small-text qc-err">{err}</span>}
      <button className="qc-fab" aria-expanded={open} aria-label="Quick Capture" title="Quick Capture (drop files here too)" onClick={() => (open ? close() : setOpen(true))}>+</button>
    </div>
  );
}

// Quick Capture: only what really works today — Note, Link (→ Inbox), File (→ your files / Backpack).
import { useState } from 'react';
import { api } from '../App.tsx';
import { errText } from './useLoad.ts';

export function QuickCapture({ onDone }: { onDone(msg: string, go?: 'notes' | 'saved'): void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'link' | null>(null);
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const close = () => { setOpen(false); setMode(null); setUrl(''); setErr(''); };
  return (
    <div className={`qc ${open ? 'open' : ''}`}>
      {open && !mode && (
        <div className="qc-menu" role="menu" aria-label="Quick Capture">
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 0 }} onClick={async () => { await api.clan.createNote({ title: 'Untitled' }); close(); onDone('New note created', 'notes'); }}><span className="qc-icon">✎</span>Note</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 1 }} onClick={() => setMode('link')}><span className="qc-icon">↗</span>Link</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 2 }} onClick={async () => { const n = await api.clan.addPersonalFile(); close(); if (n) onDone(`${n} file${n === 1 ? '' : 's'} added to your Backpack`); }}><span className="qc-icon">▤</span>File</button>
        </div>
      )}
      {mode === 'link' && (
        <form className="qc-sheet card" onSubmit={async (e) => { e.preventDefault(); try { await api.clan.save({ url }); close(); onDone('Saved to Inbox', 'saved'); } catch (x) { setErr(errText(x)); } }}>
          <span className="eyebrow">Link → Inbox</span>
          <input autoFocus type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="Link to save" />
          {err && <span className="error small-text">{err}</span>}
          <div className="row"><button type="button" onClick={() => setMode(null)}>Back</button><button className="primary" disabled={!url}>Save</button></div>
        </form>
      )}
      <button className="qc-fab" aria-expanded={open} aria-label="Quick Capture" onClick={() => (open ? close() : setOpen(true))}>+</button>
    </div>
  );
}

// Quick Capture: Note, Task, Reminder, Link, File, Idea. Notes/links/ideas/files land in Personal Space › Inbox first
// (private until filed) — or straight into one of your courses/topics when picked under “Into”. Tasks and reminders
// go to their own modules.
import { useEffect, useState, type DragEvent } from 'react';
import { api } from '../App.tsx';
import { errText, useLoad } from './useLoad.ts';
import { fromLocal } from './study/common.tsx';
import { useRecorder } from './tape/recorder.tsx';

export function QuickCapture({ onDone }: { onDone(msg: string, go?: 'notes' | 'saved'): void }) {
  const [open, setOpen] = useState(false);
  const rec = useRecorder();
  const [tapeNote, setTapeNote] = useState<string | null>(null);
  const [mode, setMode] = useState<'link' | 'text' | 'task' | 'reminder' | null>(null);
  const [into, setInto] = useState('');
  const [due, setDue] = useState('');
  const [courses, reloadCourses] = useLoad(api.study.courses);
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [col, setCol] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [cols] = useLoad(api.clan.collections);
  useEffect(() => { const f = () => { reloadCourses(); setOpen(true); }; addEventListener('clan:quick-capture', f); return () => removeEventListener('clan:quick-capture', f); }, []); // eslint-disable-line react-hooks/exhaustive-deps — from the presentation + menu
  const close = () => { setOpen(false); setMode(null); setUrl(''); setNote(''); setTags(''); setCol(''); setText(''); setDue(''); setErr(''); };
  const [cId, tId] = into.split(':');
  const target = cId ? { courseId: cId, topicId: tId || null } : undefined;
  const where = target ? courses?.find((c) => c.id === cId)?.name ?? 'course' : 'Inbox';
  const run = async (f: () => Promise<unknown>, msg: string, go?: 'notes' | 'saved') => { try { await f(); close(); onDone(msg, go); } catch (x) { setErr(errText(x)); } };
  const drop = (e: DragEvent) => { e.preventDefault(); const files = [...e.dataTransfer.files]; if (files.length) void run(() => api.capture.dropped(files), `${files.length} file${files.length === 1 ? '' : 's'} added to your Inbox`, 'saved'); };
  const intoPicker = !!courses?.length && (
    <select value={into} onChange={(e) => setInto(e.target.value)} aria-label="Capture into" className="qc-into">
      <option value="">Into: Inbox</option>
      {courses.map((c) => <optgroup key={c.id} label={c.name}><option value={`${c.id}:`}>{c.name}</option>{c.topics.map((t) => <option key={t.id} value={`${c.id}:${t.id}`}>{c.name} › {t.title}</option>)}</optgroup>)}
    </select>
  );
  return (
    <div className={`qc ${open ? 'open' : ''}`} onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} onDrop={drop}>
      {open && !mode && (
        <div className="qc-menu" role="menu" aria-label="Quick Capture">
          {rec.active && <div className="qc-rec" role="group" aria-label="Study Tape">
            <span className="eyebrow">Recording · {rec.active.tape.title}</span>
            <button role="menuitem" className="qc-item" onClick={() => void run(() => rec.mark('bookmark', 'Bookmark'), 'Bookmark added to the tape')}><span className="qc-icon">🔖</span>Bookmark</button>
            <button role="menuitem" className="qc-item" onClick={() => setTapeNote('')}><span className="qc-icon">📝</span>Tape note</button>
            <button role="menuitem" className="qc-item" onClick={() => void run(() => rec.screenshot(), 'Screenshot added to the tape')}><span className="qc-icon">📸</span>Screenshot</button>
            {tapeNote !== null && <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => rec.mark('note', tapeNote), 'Note added to the tape'); setTapeNote(null); }}>
              <input autoFocus value={tapeNote} onChange={(e) => setTapeNote(e.target.value)} aria-label="Tape note" maxLength={4000} /><button className="small primary">Add</button></form>}
          </div>}
          {intoPicker}
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 0 }} onClick={() => run(() => api.capture.add({ kind: 'note', title: 'Untitled' }, target), `New note in ${where}`, 'notes')}><span className="qc-icon">✎</span>Note</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 1 }} onClick={() => setMode('task')}><span className="qc-icon">☐</span>Task</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 2 }} onClick={() => setMode('reminder')}><span className="qc-icon">⏰</span>Reminder</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 3 }} onClick={() => setMode('link')}><span className="qc-icon">↗</span>Link</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 4 }} onClick={() => run(async () => { if (!(await api.capture.pick(target))) throw new Error('No file chosen.'); }, `Added to ${where}`, 'saved')}><span className="qc-icon">▤</span>File</button>
          <button role="menuitem" className="qc-item" style={{ ['--i' as string]: 5 }} onClick={() => setMode('text')}><span className="qc-icon">❝</span>Idea</button>
        </div>
      )}
      {mode === 'link' && (
        <form className="qc-sheet card" onSubmit={(e) => { e.preventDefault(); void run(() => api.capture.add({ kind: 'link', url, note: note || undefined, tags: tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean), collectionId: col || undefined }, target), target ? `Saved into ${where}` : col ? 'Saved' : 'Saved to your Inbox — the title fills in when online', 'saved'); }}>
          <span className="eyebrow">Link → {target ? where : col ? 'Saved' : 'Inbox'}</span>
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
        <form className="qc-sheet card" onSubmit={(e) => { e.preventDefault(); void run(() => api.capture.add({ kind: 'text', text }, target), `Idea saved to ${where}`, 'saved'); }}>
          <span className="eyebrow">Idea → {where}</span>
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={20000} aria-label="Text or idea" />
          {err && <span className="error small-text">{err}</span>}
          <div className="row"><button type="button" onClick={() => setMode(null)}>Back</button><button className="primary" disabled={!text.trim()}>Save</button></div>
        </form>
      )}
      {(mode === 'task' || mode === 'reminder') && (
        <form className="qc-sheet card" onSubmit={(e) => { e.preventDefault(); const at = fromLocal(due);
          void run(() => (mode === 'task' ? api.study.createTask({ title: text, dueAt: at, courseId: target?.courseId ?? null, topicId: target?.topicId ?? null })
            : (at ? api.study.remind({ text, dueAt: at, ...(target ? { target: { module: 'courses', id: target.courseId } } : {}) }) : Promise.reject(new Error('Pick a time.')))), mode === 'task' ? 'Task added' : 'Reminder set'); }}>
          <span className="eyebrow">{mode === 'task' ? 'Task' : 'Reminder'}{target ? ` → ${where}` : ''}</span>
          <input autoFocus required value={text} onChange={(e) => setText(e.target.value)} placeholder={mode === 'task' ? 'Finish lab 4' : 'Return library book'} aria-label={mode === 'task' ? 'Task title' : 'Reminder text'} maxLength={200} />
          <input type="datetime-local" required={mode === 'reminder'} value={due} onChange={(e) => setDue(e.target.value)} aria-label={mode === 'task' ? 'Due (optional)' : 'When'} />
          {err && <span className="error small-text">{err}</span>}
          <div className="row"><button type="button" onClick={() => setMode(null)}>Back</button><button className="primary" disabled={!text.trim()}>Save</button></div>
        </form>
      )}
      {err && !mode && <span className="error small-text qc-err">{err}</span>}
      <button className="qc-fab" aria-expanded={open} aria-label="Quick Capture" title="Quick Capture (drop files here too)" onClick={() => { if (open) close(); else { reloadCourses(); setOpen(true); } }}>+</button>
    </div>
  );
}

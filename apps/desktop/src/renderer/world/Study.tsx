// Study: Knowledge Campus (your Courses), course spaces, Semester Board, tasks, the Exam Command Center, flashcards,
// notes and personal history. Everything here is real Study Engine data; nothing is estimated.
import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { loadCampus, type CourseBuildingViewModel } from '@clan/world';
import type { CourseView, Note, SearchHit } from '../../shared.ts';
import { api } from '../App.tsx';
import { errText, useLoad } from './useLoad.ts';
import type { Experience } from './experience.ts';
import { useStudy, type StudyTab } from './study/common.tsx';
import { useAI } from './ai/ctx.tsx';
import { CourseSpace } from './study/Course.tsx';
import { Board } from './study/Board.tsx';
import { Tasks } from './study/Tasks.tsx';
import { Exams } from './study/Exams.tsx';
import { Cards } from './study/Cards.tsx';
import { History } from './study/History.tsx';

declare global { interface Window { __clanPerf?: { sceneMs?: number } } }
const sceneStart = { t: 0 };
const CampusScene = lazy(() => { sceneStart.t = performance.now(); return loadCampus(); });
const COLORS = ['var(--burgundy)', 'var(--study)', 'var(--campus)', 'var(--brick)', 'var(--notebook)', 'var(--transfer)'];
/** Resolve a token to a concrete colour for three.js. */
const tokenColor = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim() || '#888';

/** If WebGL fails, the 2D campus takes over; 3D never owns state. */
class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const TABS: [StudyTab, string][] = [['campus', 'Campus'], ['board', 'Semester Board'], ['tasks', 'Tasks'], ['exams', 'Exams'], ['cards', 'Flashcards'], ['notes', 'Notes'], ['history', 'History']];

export function Study({ experience }: { experience: Experience }) {
  const { target, go } = useStudy();
  const tab = target.tab;
  return (
    <div className="stack">
      <header className="page-head">
        <div><span className="eyebrow">Study</span><h1 className="title world">{tab === 'campus' ? 'Knowledge Campus' : TABS.find((t) => t[0] === tab)![1]}</h1></div>
        <div className="seg study-tabs" role="tablist" aria-label="Study area">
          {TABS.map(([t, l]) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => go({ tab: t })}>{l}</button>)}
        </div>
      </header>
      {tab === 'campus' && (target.courseId ? <CourseSpace id={target.courseId} onBack={() => go({ tab: 'campus' })} /> : <Campus experience={experience} />)}
      {tab === 'board' && <Board />}
      {tab === 'tasks' && <Tasks courseId={target.courseId} />}
      {tab === 'exams' && <Exams examId={target.examId} />}
      {tab === 'cards' && <Cards courseId={target.courseId} deckId={target.deckId} />}
      {tab === 'notes' && <Notes />}
      {tab === 'history' && <History />}
    </div>
  );
}

function NewCourse({ onDone }: { onDone(): void }) {
  const [o, setO] = useState({ name: '', code: '', instructor: '', term: '', schedule: '' });
  const [err, setErr] = useState('');
  return (
    <form className="card new-course" aria-label="New course" onSubmit={async (e) => { e.preventDefault(); try { await api.study.createCourse(o); onDone(); } catch (x) { setErr(errText(x)); } }}>
      <span className="eyebrow">New course</span>
      <div className="form-grid">
        <input required value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} placeholder="Operating Systems" aria-label="Course name" maxLength={120} />
        <input value={o.code} onChange={(e) => setO({ ...o, code: e.target.value })} placeholder="Code (CS-330)" aria-label="Course code" maxLength={30} />
        <input value={o.instructor} onChange={(e) => setO({ ...o, instructor: e.target.value })} placeholder="Instructor (optional)" aria-label="Instructor" maxLength={120} />
        <input value={o.term} onChange={(e) => setO({ ...o, term: e.target.value })} placeholder="Term (Fall 2026)" aria-label="Term" maxLength={60} />
        <input value={o.schedule} onChange={(e) => setO({ ...o, schedule: e.target.value })} placeholder="Schedule (Mon/Wed 10:00)" aria-label="Schedule" maxLength={500} />
      </div>
      {err && <span className="error small-text">{err}</span>}
      <div className="row"><button className="primary">Add course</button></div>
    </form>
  );
}

function Campus({ experience }: { experience: Experience }) {
  const { go } = useStudy();
  const [courses, reload] = useLoad<CourseView[]>(api.study.courses);
  const [view, setView] = useState<'campus' | 'list'>(experience === 'minimal' ? 'list' : 'campus');
  const [adding, setAdding] = useState(false);
  const open = (id: string) => go({ tab: 'campus', courseId: id });
  if (!courses) return null;
  const add = adding ? <NewCourse onDone={() => { setAdding(false); reload(); }} /> : <button className="primary" onClick={() => setAdding(true)}>New course</button>;
  if (!courses.length) return (
    <div className="stack">
      <div className="empty-world"><svg viewBox="0 0 300 120" aria-hidden><rect x="20" y="96" width="260" height="10" rx="5" fill="var(--floor)" /><rect x="120" y="60" width="60" height="36" rx="4" fill="var(--paper-2)" stroke="var(--line)" strokeWidth="3" strokeDasharray="6 5" /></svg>
        <b>Your campus is an empty lot.</b><span className="muted">Each course you add becomes a building, with a floor for every topic. Classrooms you join get a course automatically.</span></div>
      {add}
    </div>
  );
  const vms: CourseBuildingViewModel[] = courses.map((c, i) => ({
    id: c.id, code: (c.code || c.name).slice(0, 14), name: c.name, color: tokenColor(COLORS[i % COLORS.length]!), term: (i % 3) + 1, // term = layout column only
    lectures: c.topics.map((t) => ({ id: t.id, title: t.title, done: t.state === 'confident' })), // floors = topics
    studyingNow: Math.min(c.recent, c.topics.length), resources: Math.min(c.files, 8), prerequisites: [], examSoon: !!c.nextExam?.soon,
  }));
  return (
    <div className="campus">
      <div className="row between">
        <p className="muted small-text legend-line"><b>Floors</b> = your topics (solid = marked Confident) · <b>lit windows</b> = course activity this week · <b>flag</b> = exam within 14 days · <b>kiosks</b> = linked files · position is layout only</p>
        <div className="seg small" role="tablist" aria-label="Campus view">
          <button role="tab" aria-selected={view === 'campus'} disabled={experience === 'minimal'} onClick={() => setView('campus')}>Campus View</button>
          <button role="tab" aria-selected={view === 'list'} onClick={() => setView('list')}>List View</button>
        </div>
      </div>
      {view === 'list' || experience === 'minimal' ? <CourseList courses={courses} onOpen={open} />
        : experience === 'full' ? (
          <div className="scene">
            <SceneBoundary fallback={<Towers courses={courses} onOpen={open} />}>
              <Suspense fallback={<Towers courses={courses} onOpen={open} />}>
                <CampusScene courses={vms} onSelect={(id) => id && open(id)} onReady={() => { window.__clanPerf = { sceneMs: Math.round(performance.now() - sceneStart.t) }; }} />
              </Suspense>
            </SceneBoundary>
            <div className="scene-keys" aria-label="Courses">{courses.map((c) => <button key={c.id} className="small" onClick={() => open(c.id)}>{c.name}</button>)}</div>
          </div>
        ) : <Towers courses={courses} onOpen={open} />}
      {add}
    </div>
  );
}

const confident = (c: CourseView) => c.topics.filter((t) => t.state === 'confident').length;

function Towers({ courses, onOpen }: { courses: CourseView[]; onOpen(id: string): void }) {
  return (
    <div className="towers" role="list">
      {courses.map((c, i) => (
        <button key={c.id} role="listitem" className="tower" onClick={() => onOpen(c.id)} style={{ ['--c' as string]: COLORS[i % COLORS.length] }}
          aria-label={`${c.name}: ${c.topics.length} topics, ${confident(c)} marked Confident, ${c.files} files${c.nextExam ? `, exam ${c.nextExam.name}` : ''}`}>
          {c.nextExam?.soon && <span className="exam-flag" aria-hidden>▲</span>}
          <span className="floors">{c.topics.length === 0 ? <span className="floor neutral" /> : c.topics.slice(0, 12).map((t, k) => <span key={t.id} className={`floor st-${t.state}`}>{k < c.recent && <i className="lit" />}</span>)}</span>
          <span className="kiosks">{Array.from({ length: Math.min(c.files, 6) }, (_, k) => <i key={k} />)}</span>
          <b>{c.code || c.name}</b>
        </button>
      ))}
    </div>
  );
}

function CourseList({ courses, onOpen }: { courses: CourseView[]; onOpen(id: string): void }) {
  return (
    <table className="course-table"><thead><tr><th>Course</th><th>Topics</th><th>Confident</th><th>Open tasks</th><th>Next exam</th><th>Cards due</th></tr></thead>
      <tbody>{courses.map((c) => <tr key={c.id}><td><button className="link" onClick={() => onOpen(c.id)}>{c.code ? `${c.code} · ` : ''}{c.name}</button>{c.clanName && <small className="muted"> · {c.clanName}</small>}</td>
        <td className="c-num">{c.topics.length}</td><td className="c-num">{confident(c)}</td><td className="c-num">{c.openTasks}</td><td>{c.nextExam ? `${c.nextExam.name} · ${new Date(c.nextExam.at).toLocaleDateString()}` : '—'}</td><td className="c-num">{c.dueCards}</td></tr>)}</tbody></table>
  );
}

function Notes() {
  const { target } = useStudy();
  const ai = useAI();
  const [notes, reload] = useLoad(api.clan.notes);
  const [clans] = useLoad(api.clan.list);
  const [courses] = useLoad(api.study.courses);
  const [msg, setMsg] = useState('');
  const [sel, setSel] = useState<Note | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [draft, setDraft] = useState({ title: '', body: '' });
  useEffect(() => { if (sel) setDraft({ title: sel.title, body: sel.body }); }, [sel]);
  useEffect(() => { if (target.noteId && notes) { const n = notes.find((x) => x.id === target.noteId); if (n) setSel(n); } }, [target.noteId, notes]);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  /** Note actions: the AI result is a preview; the student picks Insert / Append / New note (or closes = discard). Save stays explicit. */
  const noteAI = (action: 'explain' | 'simplify' | 'summarize' | 'questions' | 'flashcards', title: string) => {
    if (!sel) return;
    const ta = bodyRef.current, selection = ta && ta.selectionEnd > ta.selectionStart ? draft.body.slice(ta.selectionStart, ta.selectionEnd) : undefined;
    const at = ta?.selectionEnd ?? draft.body.length;
    ai.open({ mode: 'run', title, action, scope: { kind: 'note', noteId: sel.id }, selection: action === 'summarize' || action === 'flashcards' || action === 'questions' ? undefined : selection ?? draft.body.slice(0, 3000),
      onText: async (text, how) => {
        if (how === 'new') { await api.clan.createNote({ title: `${title}: ${sel.title}`, body: text }); reload(); return; }
        setDraft((d) => ({ ...d, body: how === 'append' ? `${d.body.replace(/\s+$/, '')}\n\n${text}` : `${d.body.slice(0, at)}${text}${d.body.slice(at)}` }));
      } });
  };
  const create = async () => { const n = await api.clan.createNote({ title: 'Untitled' }); reload(); setSel(n); };
  const save = async () => { if (sel) { setSel(await api.clan.updateNote(sel.id, draft)); reload(); } };
  return (
    <div className="study-grid">
      <aside className="stack">
        <form onSubmit={async (e) => { e.preventDefault(); setHits(q.trim() ? await api.clan.search(q) : null); }}><input type="search" placeholder="Search notes and saved" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></form>
        {hits && hits.length > 0 && <button className="small ai-link" onClick={() => ai.open({ mode: 'run', title: `About “${q}”`, action: 'ask', scope: { kind: 'search', hits: hits.map((h) => ({ module: h.module, entityId: h.entityId })) }, question: q, ask: true })}>Ask CLAN about these results</button>}
        {hits && <div className="card">{hits.length ? hits.map((h) => <div key={h.module + h.entityId} className="line"><span>{h.title}<br /><small className="muted">{h.snippet}</small></span><span className="muted">{h.module}</span></div>) : <p className="muted">No results.</p>}</div>}
        <button className="primary" onClick={create}>New note</button>
        {notes?.map((n) => <button key={n.id} className={`line link-row ${sel?.id === n.id ? 'on' : ''}`} onClick={() => setSel(n)}>{n.title}<span className="muted">{n.sharedWith.length ? 'shared' : 'private'}</span></button>)}
      </aside>
      {sel ? (
        <section className="card stack paper-sheet">
          <input className="note-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Title" />
          <div className="row tight note-ai" role="group" aria-label="CLAN note actions">
            <button className="small ai-link" onClick={() => noteAI('explain', 'Explain')}>Explain selection</button>
            <button className="small ai-link" onClick={() => noteAI('simplify', 'Simplify')}>Simplify</button>
            <button className="small ai-link" onClick={() => noteAI('summarize', 'Summarize')}>Summarize</button>
            <button className="small ai-link" onClick={() => noteAI('questions', 'Questions')}>Turn into questions</button>
            <button className="small ai-link" onClick={() => noteAI('flashcards', 'Flashcards')}>Generate flashcards</button>
            <select value="" aria-label="Compare with course material" onChange={(e) => { const [courseId, lectureId] = e.target.value.split(':'); if (courseId) ai.open({ mode: 'run', title: 'Compare My Notes', action: 'compare', scope: { kind: 'note', noteId: sel.id, courseId, lectureId: lectureId || null } }); }}>
              <option value="">Compare with course material…</option>{courses?.map((c) => <option key={c.id} value={`${c.id}:`}>{c.name}</option>)}
            </select>
          </div>
          <textarea ref={bodyRef} className="note-body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label="Note" />
          <div className="row">
            <button className="primary" onClick={save}>Save</button>
            <select value="" onChange={async (e) => { const clanId = e.target.value; await api.clan.shareNote(sel.id, clanId, true); reload(); setSel({ ...sel, sharedWith: [...sel.sharedWith, clanId] }); }} aria-label="Share to CLAN">
              <option value="">Share to CLAN…</option>{clans?.filter((c) => !sel.sharedWith.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select value="" onChange={async (e) => { const [courseId, topicId] = e.target.value.split(':'); await api.study.link(courseId!, { module: 'notes', entityId: sel.id, topicId: topicId || null }); setMsg('Added to the course — the note itself stays here and stays private.'); }} aria-label="Add to course">
              <option value="">Add to course…</option>{courses?.map((c) => <optgroup key={c.id} label={c.name}><option value={`${c.id}:`}>{c.name}</option>{c.topics.map((t) => <option key={t.id} value={`${c.id}:${t.id}`}>{c.name} › {t.title}</option>)}</optgroup>)}
            </select>
            <button onClick={() => api.clan.remind({ text: `Review “${sel.title}”`, dueAt: Date.now() + 86_400_000, target: { module: 'notes', id: sel.id } })}>Remind me tomorrow</button>
            <button className="danger" onClick={async () => { await api.clan.removeNote(sel.id); setSel(null); reload(); }}>Delete</button>
          </div>
          {msg && <p className="muted small-text" role="status">{msg}</p>}
          {sel.sharedWith.length > 0 && <p className="muted small-text">Shared with {sel.sharedWith.map((c) => clans?.find((x) => x.id === c)?.name ?? 'a CLAN').join(', ')}. Members see your latest version.</p>}
        </section>
      ) : <div className="empty-place"><b>Pick a note or start a new one.</b><span className="muted">Notes are private until you share them into a CLAN.</span></div>}
    </div>
  );
}

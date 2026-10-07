// Study: Knowledge Campus (real courses = CLASSROOM CLANs), course spaces, notes and the exam center.
import { Component, lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { loadCampus, type CourseBuildingViewModel } from '@clan/world';
import type { ClanDetail, CourseView, Note, SearchHit } from '../../shared.ts';
import { api } from '../App.tsx';
import { useLoad } from './useLoad.ts';
import type { Experience } from './experience.ts';

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

export type StudyTab = 'campus' | 'notes' | 'exams';

export function Study({ experience, tab, setTab }: { experience: Experience; tab: StudyTab; setTab(t: StudyTab): void }) {
  return (
    <div className="stack">
      <header className="page-head">
        <div><span className="eyebrow">Study</span><h1 className="title world">{tab === 'campus' ? 'Knowledge Campus' : tab === 'notes' ? 'Notes' : 'Exams'}</h1></div>
        <div className="seg" role="tablist" aria-label="Study area">
          {(['campus', 'notes', 'exams'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'campus' ? 'Campus' : t === 'notes' ? 'Notes' : 'Exams'}</button>)}
        </div>
      </header>
      {tab === 'campus' && <Campus experience={experience} />}
      {tab === 'notes' && <Notes />}
      {tab === 'exams' && <ExamCenter />}
    </div>
  );
}

function Campus({ experience }: { experience: Experience }) {
  const [courses] = useLoad<CourseView[]>(api.clan.courses);
  const [view, setView] = useState<'campus' | 'list'>(experience === 'minimal' ? 'list' : 'campus');
  const [open, setOpen] = useState<string | null>(null);
  if (!courses) return null;
  if (open) return <CourseSpace id={open} course={courses.find((c) => c.id === open)!} onBack={() => setOpen(null)} />;
  if (!courses.length) return (
    <div className="empty-world"><svg viewBox="0 0 300 120" aria-hidden><rect x="20" y="96" width="260" height="10" rx="5" fill="var(--floor)" /><rect x="120" y="60" width="60" height="36" rx="4" fill="var(--paper-2)" stroke="var(--line)" strokeWidth="3" strokeDasharray="6 5" /></svg>
      <b>Your campus is an empty lot.</b><span className="muted">Each classroom you teach or join becomes a building here, growing a floor for every class session.</span></div>
  );
  const vms: CourseBuildingViewModel[] = courses.map((c, i) => ({
    id: c.id, code: c.name.slice(0, 14), name: c.name, color: tokenColor(COLORS[i % COLORS.length]!), term: (i % 3) + 1, // term = layout column only
    lectures: Array.from({ length: c.sessions }, (_, k) => ({ id: `${c.id}-${k}`, title: `Session ${k + 1}`, done: true })),
    studyingNow: c.recentNotes, resources: Math.min(c.files, 8), prerequisites: [],
  }));
  return (
    <div className="campus">
      <div className="row between">
        <p className="muted small-text legend-line"><b>Floors</b> = class sessions held · <b>lit windows</b> = notes updated this week · <b>kiosks</b> = shared files · position is layout only</p>
        <div className="seg small" role="tablist" aria-label="Campus view">
          <button role="tab" aria-selected={view === 'campus'} disabled={experience === 'minimal'} onClick={() => setView('campus')}>Campus View</button>
          <button role="tab" aria-selected={view === 'list'} onClick={() => setView('list')}>List View</button>
        </div>
      </div>
      {view === 'list' || experience === 'minimal' ? <CourseList courses={courses} onOpen={setOpen} />
        : experience === 'full' ? (
          <div className="scene">
            <SceneBoundary fallback={<Towers courses={courses} onOpen={setOpen} />}>
              <Suspense fallback={<Towers courses={courses} onOpen={setOpen} />}>
                <CampusScene courses={vms} onSelect={(id) => id && setOpen(id)} onReady={() => { window.__clanPerf = { sceneMs: Math.round(performance.now() - sceneStart.t) }; }} />
              </Suspense>
            </SceneBoundary>
            <div className="scene-keys" aria-label="Courses">{courses.map((c) => <button key={c.id} className="small" onClick={() => setOpen(c.id)}>{c.name}</button>)}</div>
          </div>
        ) : <Towers courses={courses} onOpen={setOpen} />}
    </div>
  );
}

function Towers({ courses, onOpen }: { courses: CourseView[]; onOpen(id: string): void }) {
  return (
    <div className="towers" role="list">
      {courses.map((c, i) => (
        <button key={c.id} role="listitem" className="tower" onClick={() => onOpen(c.id)} style={{ ['--c' as string]: COLORS[i % COLORS.length] }}
          aria-label={`${c.name}: ${c.sessions} sessions, ${c.notes} notes, ${c.files} files`}>
          <span className="floors">{c.sessions === 0 ? <span className="floor neutral" /> : Array.from({ length: Math.min(c.sessions, 12) }, (_, k) => <span key={k} className="floor">{k < c.recentNotes && <i className="lit" />}</span>)}</span>
          <span className="kiosks">{Array.from({ length: Math.min(c.files, 6) }, (_, k) => <i key={k} />)}</span>
          <b>{c.name}</b>
        </button>
      ))}
    </div>
  );
}

function CourseList({ courses, onOpen }: { courses: CourseView[]; onOpen(id: string): void }) {
  return (
    <table className="course-table"><thead><tr><th>Course</th><th>Sessions</th><th>Files</th><th>Notes</th><th>This week</th></tr></thead>
      <tbody>{courses.map((c) => <tr key={c.id}><td><button className="link" onClick={() => onOpen(c.id)}>{c.name}</button></td><td className="c-num">{c.sessions}</td><td className="c-num">{c.files}</td><td className="c-num">{c.notes}</td><td className="c-num">{c.recentNotes}</td></tr>)}</tbody></table>
  );
}

const SECTIONS = ['Resources', 'Notes', 'Exams', 'Saved', 'Recordings', 'Flashcards'] as const;
function CourseSpace({ id, course, onBack }: { id: string; course: CourseView; onBack(): void }) {
  const [d] = useLoad<ClanDetail>(useCallback(() => api.clan.detail(id), [id]));
  const [sec, setSec] = useState<(typeof SECTIONS)[number]>('Resources');
  return (
    <div className="stack course-space">
      <button className="link back" onClick={onBack}>← Campus</button>
      <div className="course-hero">
        <svg viewBox="0 0 120 120" aria-hidden><rect x="30" y="20" width="60" height="90" rx="4" fill="var(--burgundy)" />{Array.from({ length: Math.min(course.sessions, 6) }, (_, k) => <rect key={k} x="38" y={96 - k * 13} width="44" height="8" rx="2" fill={k < course.recentNotes ? 'var(--notebook)' : 'rgba(255,255,255,.25)'} />)}<rect x="10" y="108" width="100" height="6" rx="3" fill="var(--floor)" /></svg>
        <div><span className="eyebrow">Course</span><h2 className="title world">{course.name}</h2><span className="muted">{course.sessions} sessions · {course.files} files · {course.notes} notes</span></div>
      </div>
      <div className="room-tabs" role="tablist">{SECTIONS.map((s) => { const soon = s === 'Recordings' || s === 'Flashcards'; return <button key={s} role="tab" aria-selected={sec === s} disabled={soon} onClick={() => setSec(s)}>{s}{soon && <small> · soon</small>}</button>; })}</div>
      <section className="card panel-body">
        {!d ? null : sec === 'Resources' ? (d.files.length ? d.files.map((f) => <div key={f.refId} className="line">{f.name}<span className="muted c-num">{(f.size / 1e6).toFixed(1)} MB</span></div>) : <p className="muted">No files shared in this course yet.</p>)
          : sec === 'Notes' ? (d.notes.length ? d.notes.map((n) => <div key={n.id} className="line">{n.title}<span className="muted">{n.mine ? 'yours' : ''}</span></div>) : <p className="muted">Share a note into this course from Notes.</p>)
          : sec === 'Saved' ? (d.saved.length ? d.saved.map((s) => <a key={s.id} className="line" href={s.url} target="_blank" rel="noreferrer noopener">{s.title}<span className="muted">{s.source}</span></a>) : <p className="muted">No links shared here yet.</p>)
          : <p className="muted">No exams for this course yet. Exam planning arrives with the Exams module.</p>}
      </section>
    </div>
  );
}

function ExamCenter() {
  return (
    <div className="exam-empty">
      <div className="countdown-ghost" aria-hidden><span>—</span><small>days</small></div>
      <div><b>No exams yet.</b><p className="muted">When the Exams module arrives, this becomes your command center: a countdown, topics with your own confidence marks, a study plan and the materials for each exam. CLAN will never guess your readiness.</p></div>
    </div>
  );
}

function Notes() {
  const [notes, reload] = useLoad(api.clan.notes);
  const [clans] = useLoad(api.clan.list);
  const [sel, setSel] = useState<Note | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [draft, setDraft] = useState({ title: '', body: '' });
  useEffect(() => { if (sel) setDraft({ title: sel.title, body: sel.body }); }, [sel]);
  const create = async () => { const n = await api.clan.createNote({ title: 'Untitled' }); reload(); setSel(n); };
  const save = async () => { if (sel) { setSel(await api.clan.updateNote(sel.id, draft)); reload(); } };
  return (
    <div className="study-grid">
      <aside className="stack">
        <form onSubmit={async (e) => { e.preventDefault(); setHits(q.trim() ? await api.clan.search(q) : null); }}><input type="search" placeholder="Search notes and saved" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></form>
        {hits && <div className="card">{hits.length ? hits.map((h) => <div key={h.module + h.entityId} className="line"><span>{h.title}<br /><small className="muted">{h.snippet}</small></span><span className="muted">{h.module}</span></div>) : <p className="muted">No results.</p>}</div>}
        <button className="primary" onClick={create}>New note</button>
        {notes?.map((n) => <button key={n.id} className={`line link-row ${sel?.id === n.id ? 'on' : ''}`} onClick={() => setSel(n)}>{n.title}<span className="muted">{n.sharedWith.length ? 'shared' : 'private'}</span></button>)}
      </aside>
      {sel ? (
        <section className="card stack paper-sheet">
          <input className="note-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Title" />
          <textarea className="note-body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label="Note" />
          <div className="row">
            <button className="primary" onClick={save}>Save</button>
            <select value="" onChange={async (e) => { const clanId = e.target.value; await api.clan.shareNote(sel.id, clanId, true); reload(); setSel({ ...sel, sharedWith: [...sel.sharedWith, clanId] }); }} aria-label="Share to CLAN">
              <option value="">Share to CLAN…</option>{clans?.filter((c) => !sel.sharedWith.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button onClick={() => api.clan.remind({ text: `Review “${sel.title}”`, dueAt: Date.now() + 86_400_000, target: { module: 'notes', id: sel.id } })}>Remind me tomorrow</button>
            <button className="danger" onClick={async () => { await api.clan.removeNote(sel.id); setSel(null); reload(); }}>Delete</button>
          </div>
          {sel.sharedWith.length > 0 && <p className="muted small-text">Shared with {sel.sharedWith.map((c) => clans?.find((x) => x.id === c)?.name ?? 'a CLAN').join(', ')}. Members see your latest version.</p>}
        </section>
      ) : <div className="empty-place"><b>Pick a note or start a new one.</b><span className="muted">Notes are private until you share them into a CLAN.</span></div>}
    </div>
  );
}

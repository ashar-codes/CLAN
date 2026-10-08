// Course interior: Overview · Topics · Lectures · Notes · Resources · Tasks · Exams · Flashcards · Saved.
// Every list is references resolved through the owning module; removing one removes only the reference.
import { useCallback, useState } from 'react';
import { RESOURCE_KIND_LABEL, RESOURCE_KINDS } from '@classroom/protocol';
import type { CourseDetail, CourseLink, ResourceKind } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText, useLoad } from '../useLoad.ts';
import { Confidence, day, fromLocal, useStudy, when } from './common.tsx';
import { TaskList } from './Tasks.tsx';
import { NewExam } from './Exams.tsx';

const SECTIONS = ['Overview', 'Topics', 'Lectures', 'Notes', 'Resources', 'Tasks', 'Exams', 'Flashcards', 'Saved'] as const;
type Section = (typeof SECTIONS)[number];

export function CourseSpace({ id, onBack }: { id: string; onBack(): void }) {
  const [d, reload, loadErr] = useLoad<CourseDetail>(useCallback(() => api.study.course(id), [id]));
  const [sec, setSec] = useState<Section>('Overview');
  const [err, setErr] = useState('');
  const { start, go } = useStudy();
  const run = async (f: () => Promise<unknown>) => { setErr(''); try { await f(); reload(); } catch (x) { setErr(errText(x)); } };
  if (loadErr) return <div className="stack"><button className="link back" onClick={onBack}>← Campus</button><p className="error">{loadErr}</p></div>;
  if (!d) return null;
  const { course } = d;
  const count: Partial<Record<Section, number>> = { Topics: d.topics.length, Lectures: d.lectures.length, Notes: d.links.filter((l) => l.module === 'notes').length, Resources: d.links.filter((l) => l.module === 'files').length,
    Tasks: d.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length, Exams: d.exams.length, Flashcards: d.decks.length, Saved: d.links.filter((l) => l.module === 'saved').length };
  return (
    <div className="stack course-space" data-testid="course-space">
      <button className="link back" onClick={onBack}>← Campus</button>
      <div className="course-hero">
        <svg viewBox="0 0 120 120" aria-hidden><rect x="30" y="20" width="60" height="90" rx="4" fill="var(--burgundy)" />{d.topics.slice(0, 6).map((t, k) => <rect key={t.id} x="38" y={96 - k * 13} width="44" height="8" rx="2" fill={t.state === 'confident' ? 'var(--notebook)' : 'rgba(255,255,255,.25)'} />)}<rect x="10" y="108" width="100" height="6" rx="3" fill="var(--floor)" /></svg>
        <div className="grow"><span className="eyebrow">Course{course.code ? ` · ${course.code}` : ''}{course.term ? ` · ${course.term}` : ''}</span><h2 className="title world">{course.name}</h2>
          <span className="muted">{[course.instructor, course.schedule, d.clanName && `Classroom: ${d.clanName}`].filter(Boolean).join(' · ') || 'Personal course'}</span></div>
        <button className="primary" onClick={() => start({ courseId: course.id, goal: `Study ${course.name}`, focus: true })}>Start study session</button>
      </div>
      <div className="room-tabs" role="tablist" aria-label="Course sections">{SECTIONS.map((s) => <button key={s} role="tab" aria-selected={sec === s} onClick={() => setSec(s)}>{s}{count[s] ? <small> · {count[s]}</small> : null}</button>)}</div>
      {err && <p className="error small-text" role="alert">{err}</p>}
      <section className="card panel-body">
        {sec === 'Overview' && <Overview d={d} />}
        {sec === 'Topics' && <Topics d={d} run={run} />}
        {sec === 'Lectures' && <Lectures d={d} run={run} />}
        {(sec === 'Notes' || sec === 'Resources' || sec === 'Saved') && <Links d={d} module={sec === 'Notes' ? 'notes' : sec === 'Resources' ? 'files' : 'saved'} run={run} />}
        {sec === 'Tasks' && <TaskList courseId={course.id} topics={d.topics} />}
        {sec === 'Exams' && <>
          {d.exams.map((e) => <button key={e.id} className="line link-row" onClick={() => go({ tab: 'exams', examId: e.id })}><span><b>{e.name}</b> · {when(e.at)}</span><span className="muted">{e.status}</span></button>)}
          {!d.exams.length && <p className="muted">No exams for this course yet.</p>}
          <NewExam courseId={course.id} topics={d.topics} onDone={reload} />
        </>}
        {sec === 'Flashcards' && <>
          {d.decks.map((k) => <button key={k.id} className="line link-row" onClick={() => go({ tab: 'cards', deckId: k.id })}><span><b>{k.name}</b></span><span className="muted c-num">{k.cards} cards · {k.due} due</span></button>)}
          {!d.decks.length && <p className="muted">No decks yet.</p>}
          <form className="row" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const topicId = String(f.get('topic') || '') || null; void run(() => api.study.createDeck({ name: String(f.get('name')), courseId: course.id, topicId })); e.currentTarget.reset(); }}>
            <input name="name" required placeholder="Deck name" aria-label="Deck name" maxLength={120} />
            <select name="topic" aria-label="Deck topic"><option value="">Whole course</option>{d.topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
            <button className="primary">Add deck</button>
          </form>
        </>}
      </section>
    </div>
  );
}

function Overview({ d }: { d: CourseDetail }) {
  const { go } = useStudy();
  const next = d.exams.find((e) => e.status === 'upcoming' && e.at > Date.now());
  const marked = d.topics.filter((t) => t.state === 'confident').length;
  return (
    <div className="overview">
      <div className="line"><span>Topics marked Confident</span><b className="c-num">{marked} of {d.topics.length}</b></div>
      <div className="line"><span>Next exam</span>{next ? <button className="link" onClick={() => go({ tab: 'exams', examId: next.id })}>{next.name} · {day(next.at)}</button> : <span className="muted">none</span>}</div>
      <div className="line"><span>Open tasks</span><b className="c-num">{d.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length}</b></div>
      {d.assignments.length > 0 && <>
        <span className="eyebrow">Classroom assignments · from {d.clanName ?? 'the Classroom'}</span>
        {d.assignments.map((a) => <div key={a.id} className="line" data-testid="course-assignment"><span><span className="chip">Classroom Assignment</span> {a.title}</span><span className="muted">{a.dueAt ? day(a.dueAt) : 'no due date'} · {a.role === 'host' ? `${a.submitted ?? 0} submitted` : a.status}</span></div>)}
      </>}
      {d.sessions.length > 0 && <>
        <span className="eyebrow">Recent study</span>
        {d.sessions.slice(0, 5).map((s) => <div key={s.id} className="line"><span>{s.goal || 'Study session'}{s.reflection ? <small className="muted"> — {s.reflection}</small> : null}</span><span className="muted c-num">{day(s.startedAt!)} · {Math.round((s.endedAt! - s.startedAt!) / 60_000)} min</span></div>)}
      </>}
      {d.reminders.map((r) => <div key={r.id} className="line"><span>⏰ {r.text}</span><span className="muted">{when(r.at)}</span></div>)}
    </div>
  );
}

function Topics({ d, run }: { d: CourseDetail; run(f: () => Promise<unknown>): Promise<void> }) {
  const [title, setTitle] = useState('');
  const n = (topicId: string) => d.links.filter((l) => l.topicId === topicId).length;
  return (
    <>
      <p className="muted small-text">Your own order and your own marks. CLAN never changes a mark for you.</p>
      <ol className="topic-list">
        {d.topics.map((t, i) => (
          <li key={t.id} className="line" data-testid="topic">
            <span className="grow row"><input className="inline-edit" defaultValue={t.title} aria-label={`Topic ${i + 1} name`} maxLength={160}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.title) void run(() => api.study.renameTopic(t.id, v)); }} />{n(t.id) ? <small className="muted">{n(t.id)} linked</small> : null}</span>
            <Confidence state={t.state} label={t.title} onChange={(s) => void run(() => api.study.setConfidence(t.id, s))} />
            <button className="small" aria-label={`Move ${t.title} up`} disabled={i === 0} onClick={() => void run(() => api.study.moveTopic(t.id, i - 1))}>↑</button>
            <button className="small" aria-label={`Move ${t.title} down`} disabled={i === d.topics.length - 1} onClick={() => void run(() => api.study.moveTopic(t.id, i + 1))}>↓</button>
            <button className="small danger" aria-label={`Remove ${t.title}`} onClick={() => void run(() => api.study.removeTopic(t.id))}>✕</button>
          </li>
        ))}
      </ol>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void run(() => api.study.addTopic(d.course.id, title)).then(() => setTitle('')); }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a topic (e.g. CPU Scheduling)" aria-label="New topic" maxLength={160} />
        <button className="primary">Add topic</button>
      </form>
    </>
  );
}

function Lectures({ d, run }: { d: CourseDetail; run(f: () => Promise<unknown>): Promise<void> }) {
  const [o, setO] = useState({ title: '', at: '', topicIds: [] as string[] });
  return (
    <>
      {d.lectures.map((l) => (
        <div key={l.id} className="line" data-testid="lecture">
          <span className="grow"><b>{l.title}</b> <small className="muted">{l.at ? when(l.at) : 'no date'}{l.topicIds.length ? ` · ${l.topicIds.map((t) => d.topics.find((x) => x.id === t)?.title).filter(Boolean).join(', ')}` : ''}{l.sessionId ? ' · linked to a class session' : ''}</small></span>
          <select value={l.status} aria-label={`Status of ${l.title}`} onChange={(e) => void run(() => api.study.setLecture(l.id, { status: e.target.value as 'planned' }))}><option value="planned">Planned</option><option value="held">Held</option><option value="cancelled">Cancelled</option></select>
        </div>
      ))}
      {!d.lectures.length && <p className="muted">No lectures yet.</p>}
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void run(() => api.study.addLecture(d.course.id, { title: o.title, at: fromLocal(o.at), topicIds: o.topicIds })).then(() => setO({ title: '', at: '', topicIds: [] })); }}>
        <input required value={o.title} onChange={(e) => setO({ ...o, title: e.target.value })} placeholder="Lecture title" aria-label="Lecture title" maxLength={160} />
        <input type="datetime-local" value={o.at} onChange={(e) => setO({ ...o, at: e.target.value })} aria-label="Lecture date" />
        <select multiple value={o.topicIds} onChange={(e) => setO({ ...o, topicIds: [...e.target.selectedOptions].map((x) => x.value) })} aria-label="Lecture topics">{d.topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
        <button className="primary">Add lecture</button>
      </form>
    </>
  );
}

const MOD_LABEL = { notes: 'note', files: 'file', saved: 'saved link' } as const;
function Links({ d, module, run }: { d: CourseDetail; module: CourseLink['module']; run(f: () => Promise<unknown>): Promise<void> }) {
  const [linkable] = useLoad(api.study.linkable);
  const [topicId, setTopicId] = useState('');
  const [kind, setKind] = useState<ResourceKind>('lecture_material');
  const list = d.links.filter((l) => l.module === module);
  const linked = new Set(list.map((l) => l.entityId));
  const topic = (id: string | null) => (id ? d.topics.find((t) => t.id === id) : null);
  return (
    <>
      {list.map((l) => (
        <div key={l.id} className={`line ${l.missing ? 'missing' : ''}`} data-testid={`link-${module}`}>
          <span className="grow"><b>{l.title}</b>
            {topic(l.topicId) && <small className="muted"> · {topic(l.topicId)!.title}</small>}
            {l.provenance && <small className="muted"> · Shared by {l.provenance.sharedBy ?? 'a member'} in {l.provenance.clan}</small>}
            {l.missing && <small className="muted"> · deleted or no longer shared with you</small>}</span>
          {module === 'files' && !l.missing && <select value={l.kind ?? 'other'} aria-label={`Kind of ${l.title}`} onChange={(e) => void run(() => api.study.classify(l.id, e.target.value as ResourceKind))}>{RESOURCE_KINDS.map((k) => <option key={k} value={k}>{RESOURCE_KIND_LABEL[k]}</option>)}</select>}
          {module === 'files' && l.kind === 'past_paper' && <span className="chip">Past paper</span>}
          <button className="small" aria-label={`Remove ${l.title} from course`} onClick={() => void run(() => api.study.unlink(l.id))}>Remove from course</button>
        </div>
      ))}
      {!list.length && <p className="muted">No {MOD_LABEL[module]}s in this course yet.</p>}
      <div className="row wrap">
        <select value={topicId} onChange={(e) => setTopicId(e.target.value)} aria-label="Topic for new link"><option value="">Whole course</option>{d.topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
        {module === 'files' && <select value={kind} onChange={(e) => setKind(e.target.value as ResourceKind)} aria-label="Kind for new file">{RESOURCE_KINDS.map((k) => <option key={k} value={k}>{RESOURCE_KIND_LABEL[k]}</option>)}</select>}
        <select value="" aria-label={`Link an existing ${MOD_LABEL[module]}`} onChange={(e) => { const v = e.target.value; if (v) void run(() => api.study.link(d.course.id, { module, entityId: v, topicId: topicId || null, kind: module === 'files' ? kind : null })); }}>
          <option value="">Link an existing {MOD_LABEL[module]}…</option>
          {linkable?.[module].filter((x) => !linked.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
        </select>
        {module === 'files' && <button onClick={() => void run(() => api.study.importFiles(d.course.id, { topicId: topicId || null, kind }))}>Import files…</button>}
      </div>
      <p className="muted small-text">{module === 'files' ? 'Files stay one canonical copy (same bytes are stored once); the course keeps a reference.' : `The ${MOD_LABEL[module]} stays where it is; the course keeps a reference.`}</p>
    </>
  );
}


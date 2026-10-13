// Exams and the Exam Command Center. Everything shown is the student's own data; the only readiness figure is
// "N of M topics in scope marked Confident", with its basis spelled out. Results exist only when the student enters them.
import { useCallback, useState } from 'react';
import type { ExamCenter as Center, Topic } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText, useLoad } from '../useLoad.ts';
import { Confidence, day, fromLocal, useStudy, when } from './common.tsx';
import { useAI } from '../ai/ctx.tsx';

export function Exams({ examId }: { examId?: string }) {
  const { go } = useStudy();
  const [exams, reload] = useLoad(api.study.exams);
  if (examId) return <CommandCenter id={examId} onBack={() => go({ tab: 'exams' })} />;
  const upcoming = exams?.filter((e) => e.status === 'upcoming') ?? [];
  const past = exams?.filter((e) => e.status !== 'upcoming') ?? [];
  return (
    <div className="stack">
      {exams && !exams.length && (
        <div className="exam-empty"><div className="countdown-ghost" aria-hidden><span>—</span><small>days</small></div>
          <div><b>No exams yet.</b><p className="muted">Add one below: you get a countdown, the topics in scope with your own marks, its materials, cards and tasks. CLAN never guesses your readiness.</p></div></div>
      )}
      <div className="exam-grid">
        {upcoming.map((e) => (
          <button key={e.id} className="card exam-card" onClick={() => go({ tab: 'exams', examId: e.id })} aria-label={`${e.name}, ${e.countdown.label}`}>
            <span className={`countdown ${e.countdown.days < 3 ? 'near' : ''}`}><b className="c-num">{e.countdown.past ? '—' : e.countdown.days >= 1 ? e.countdown.days : e.countdown.label}</b><small>{e.countdown.past ? 'started' : e.countdown.days >= 1 ? (e.countdown.days === 1 ? 'day' : 'days') : 'left'}</small></span>
            <span><b>{e.name}</b><br /><small className="muted">{when(e.at)}{e.location ? ` · ${e.location}` : ''}</small></span>
          </button>
        ))}
      </div>
      <NewExam onDone={reload} />
      {past.length > 0 && <section className="card panel-body"><span className="eyebrow">Past and cancelled</span>{past.map((e) => <button key={e.id} className="line link-row" onClick={() => go({ tab: 'exams', examId: e.id })}><span>{e.name} · {day(e.at)}</span><span className="muted">{e.status}{e.grade ? ` · ${e.grade}${e.total ? ` / ${e.total}` : ''}` : ''}</span></button>)}</section>}
    </div>
  );
}

export function NewExam({ courseId, topics, onDone }: { courseId?: string; topics?: Topic[]; onDone(): void }) {
  const [courses] = useLoad(api.study.courses);
  const [o, setO] = useState({ courseId: courseId ?? '', name: '', at: '', location: '', topicIds: [] as string[], week: false, dayBefore: false });
  const [err, setErr] = useState('');
  const scope = topics ?? courses?.find((c) => c.id === o.courseId)?.topics ?? [];
  const submit = async () => {
    setErr('');
    try {
      const at = fromLocal(o.at); if (!at) throw new Error('Pick a date and time.');
      await api.study.createExam({ courseId: o.courseId, name: o.name, at, location: o.location, topicIds: o.topicIds }, [...(o.week ? [7 as const] : []), ...(o.dayBefore ? [1 as const] : [])]);
      setO({ courseId: courseId ?? '', name: '', at: '', location: '', topicIds: [], week: false, dayBefore: false }); onDone();
    } catch (x) { setErr(errText(x)); }
  };
  return (
    <form className="card stack" aria-label="New exam" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <span className="eyebrow">New exam</span>
      <div className="form-grid">
        {!courseId && <select required value={o.courseId} onChange={(e) => setO({ ...o, courseId: e.target.value, topicIds: [] })} aria-label="Exam course"><option value="">Course…</option>{courses?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        <input required value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} placeholder="Midterm" aria-label="Exam name" maxLength={160} />
        <input required type="datetime-local" value={o.at} onChange={(e) => setO({ ...o, at: e.target.value })} aria-label="Exam date" />
        <input value={o.location} onChange={(e) => setO({ ...o, location: e.target.value })} placeholder="Location (optional)" aria-label="Exam location" maxLength={160} />
      </div>
      {scope.length > 0 && <fieldset className="scope"><legend className="small-text">Topics in scope</legend>{scope.map((t) => <label key={t.id} className="chip-check"><input type="checkbox" checked={o.topicIds.includes(t.id)} onChange={(e) => setO({ ...o, topicIds: e.target.checked ? [...o.topicIds, t.id] : o.topicIds.filter((x) => x !== t.id) })} />{t.title}</label>)}</fieldset>}
      <fieldset className="scope"><legend className="small-text">Suggested reminders (off until you tick them)</legend>
        <label className="chip-check"><input type="checkbox" checked={o.week} onChange={(e) => setO({ ...o, week: e.target.checked })} />1 week before</label>
        <label className="chip-check"><input type="checkbox" checked={o.dayBefore} onChange={(e) => setO({ ...o, dayBefore: e.target.checked })} />1 day before</label>
      </fieldset>
      {err && <span className="error small-text">{err}</span>}
      <div className="row"><button className="primary">Add exam</button></div>
    </form>
  );
}

function CommandCenter({ id, onBack }: { id: string; onBack(): void }) {
  const { start, go } = useStudy();
  const ai = useAI();
  const [c, reload, loadErr] = useLoad<Center>(useCallback(() => api.study.examCenter(id), [id]));
  const [result, setResult] = useState({ grade: '', total: '', reflection: '' });
  const [completing, setCompleting] = useState(false);
  const [err, setErr] = useState('');
  const run = async (f: () => Promise<unknown>) => { setErr(''); try { await f(); reload(); } catch (x) { setErr(errText(x)); } };
  if (loadErr) return <div className="stack"><button className="link back" onClick={onBack}>← Exams</button><p className="error">{loadErr}</p></div>;
  if (!c) return null;
  const { exam } = c;
  if(!c.course)return <section className="card stack"><button onClick={onBack}>← Exams</button><h2>{exam.name}</h2><p>{when(exam.at)} · {exam.location}</p><p>{exam.notes}</p><p className="muted">The linked course is no longer available. Manage this retained exam from the Exams management menu.</p></section>;
  const course=c.course;
  const ref = (l: Center['notes'][number]) => <div key={l.id} className="line"><span>{l.title}{l.provenance ? <small className="muted"> · shared by {l.provenance.sharedBy ?? 'a member'} in {l.provenance.clan}</small> : null}</span><span className="muted small-text">{l.missing ? 'no longer available' : ''}</span></div>;
  const topicRow = (t: Topic) => <div key={t.id} className="line"><span>{t.title}</span><Confidence state={t.state} label={t.title} onChange={(s) => void run(() => api.study.setConfidence(t.id, s))} /></div>;
  return (
    <div className="stack command-center" data-testid="exam-center">
      <button className="link back" onClick={onBack}>← Exams</button>
      <div className="cc-hero card">
        <span className={`countdown big ${c.countdown.days < 3 && !c.countdown.past ? 'near' : ''}`} role="timer" aria-label={`Countdown: ${c.countdown.label}`}>
          <b className="c-num">{exam.status !== 'upcoming' ? '—' : c.countdown.past ? '0' : c.countdown.days >= 1 ? c.countdown.days : c.countdown.label}</b>
          <small>{exam.status !== 'upcoming' ? exam.status : c.countdown.past ? 'started' : c.countdown.days >= 1 ? (c.countdown.days === 1 ? `day ${c.countdown.hours} h` : 'days') : 'left'}</small>
        </span>
        <div className="grow"><span className="eyebrow">Exam Command Center · {course.name}</span><h2 className="title world">{exam.name}</h2><span className="muted">{when(exam.at)}{exam.location ? ` · ${exam.location}` : ''}</span></div>
        {exam.status === 'upcoming' && <button className="ai-link" onClick={() => ai.open({ mode: 'coach', title: `Exam Coach · ${exam.name}`, examId: exam.id })}>Exam Coach</button>}
        {!!course.archivedAt&&<p className="muted">Course archived or removed; this independent exam remains available.</p>}
        {exam.status === 'upcoming' && <button disabled={!!course.archivedAt} className="primary" onClick={() => start({ courseId: course.id, goal: `Prepare ${exam.name}`, focus: true })}>Start study session</button>}
      </div>
      {err && <p className="error small-text" role="alert">{err}</p>}

      <section className="card stack" aria-label="Topics in scope">
        <div className="row between"><span className="eyebrow">Topics in scope</span>
          <b data-testid="readiness">{c.readiness ? c.readiness.label : 'No topics in scope yet'}</b></div>
        <p className="muted small-text">{c.readiness ? `Counted from your own marks only: ${c.readiness.byState.confident} Confident, ${c.readiness.byState.review} Needs review, ${c.readiness.byState.learning} Learning, ${c.readiness.byState.not_started} Not started. Nothing is estimated.` : 'Pick the topics this exam covers (edit the exam) to see them here.'}</p>
        <div className="cc-cols">
          <div><span className="eyebrow">Remaining · {c.remaining.length}</span>{c.remaining.map(topicRow)}{!c.remaining.length && c.topics.length > 0 && <p className="muted">Every topic is marked Confident.</p>}</div>
          <div><span className="eyebrow">Covered (Confident) · {c.covered.length}</span>{c.covered.map(topicRow)}</div>
        </div>
        <ScopeEditor c={c} run={run} />
      </section>

      <div className="cc-grid">
        <section className="card panel-body"><span className="eyebrow">Past papers</span>{c.pastPapers.map((l) => <div key={l.id} className="row between">{ref(l)}{!l.missing && <button className="small ai-link" onClick={() => ai.open({ mode: 'paper', title: `Analyze ${l.title}`, refId: l.entityId, examId: exam.id })}>Analyze</button>}</div>)}{!c.pastPapers.length && <p className="muted small-text">Mark a course file as “Past paper” to see it here.</p>}</section>
        <section className="card panel-body"><span className="eyebrow">Resources</span>{c.resources.map(ref)}{!c.resources.length && <p className="muted small-text">No files linked to these topics.</p>}</section>
        <section className="card panel-body"><span className="eyebrow">Notes</span>{c.notes.map(ref)}{c.saved.map(ref)}{!c.notes.length && !c.saved.length && <p className="muted small-text">No notes linked to these topics.</p>}</section>
        <section className="card panel-body"><span className="eyebrow">Flashcards</span>
          <b data-testid="cards-due">{c.dueCards} card{c.dueCards === 1 ? '' : 's'} due</b>
          {c.decks.map((d) => <button key={d.id} className="line link-row" onClick={() => go({ tab: 'cards', deckId: d.id })}><span>{d.name}</span><span className="muted c-num">{d.due} due</span></button>)}
          <button className="small" disabled={!!course.archivedAt} onClick={() => void run(() => api.study.createDeck({ name: `${exam.name} cards`, courseId: course.id, examId: exam.id }))}>New deck for this exam</button>
        </section>
        <section className="card panel-body"><span className="eyebrow">Open tasks</span>{c.tasks.map((t) => <div key={t.id} className="line"><span>{t.title}</span><span className="muted small-text">{t.dueAt ? day(t.dueAt) : ''}</span></div>)}{!c.tasks.length && <p className="muted small-text">None.</p>}</section>
        <section className="card panel-body"><span className="eyebrow">Study sessions</span>{c.sessions.map((s) => <div key={s.id} className="line"><span>{s.goal || 'Study session'}</span><span className="muted c-num">{day(s.startedAt!)} · {Math.round((s.endedAt! - s.startedAt!) / 60_000)} min</span></div>)}{!c.sessions.length && <p className="muted small-text">None yet.</p>}
          {c.reminders.map((r) => <div key={r.id} className="line"><span>⏰ {r.text}</span><span className="muted small-text">{when(r.at)}</span></div>)}</section>
      </div>

      <section className="card stack">
        <span className="eyebrow">Status</span>
        {exam.status === 'completed' ? <p>Completed{exam.grade ? ` · your grade: ${exam.grade}${exam.total ? ` / ${exam.total}` : ''}` : ''}{exam.reflection ? ` — ${exam.reflection}` : ''}</p>
          : exam.status === 'cancelled' ? <p>Cancelled</p> : null}
        {exam.status === 'upcoming' && !completing && <div className="row"><button onClick={() => { setResult({ grade: exam.grade ?? '', total: exam.total ?? '', reflection: exam.reflection ?? '' }); setCompleting(true); }}>Mark completed</button><button className="danger" onClick={() => void run(() => api.study.examStatus(exam.id, 'cancelled'))}>Cancel exam</button></div>}
        {completing && (
          <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void run(() => api.study.examStatus(exam.id, 'completed', result)).then(() => setCompleting(false)); }}>
            <input value={result.grade} onChange={(e) => setResult({ ...result, grade: e.target.value })} placeholder="Your grade (optional)" aria-label="Grade" maxLength={40} />
            <input value={result.total} onChange={(e) => setResult({ ...result, total: e.target.value })} placeholder="Out of / % (optional)" aria-label="Total" maxLength={40} />
            <input value={result.reflection} onChange={(e) => setResult({ ...result, reflection: e.target.value })} placeholder="Reflection (optional, only for you)" aria-label="Reflection" maxLength={5000} />
            <button className="primary">Save</button>
          </form>
        )}
        {exam.status !== 'upcoming' && <button className="small" onClick={() => void run(() => api.study.examStatus(exam.id, 'upcoming'))}>Reopen</button>}
      </section>
    </div>
  );
}

function ScopeEditor({ c, run }: { c: Center; run(f: () => Promise<unknown>): Promise<void> }) {
  const [course] = useLoad(useCallback(() => c.course&&!c.course.archivedAt?api.study.course(c.course.id):Promise.resolve(null), [c.course?.id,c.course?.archivedAt]));
  const [open, setOpen] = useState(false);
  if (!course?.topics.length) return null;
  const scope = new Set(c.exam.topicIds);
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="small-text">Edit topics in scope</summary>
      <fieldset className="scope">{course.topics.map((t) => <label key={t.id} className="chip-check"><input type="checkbox" checked={scope.has(t.id)}
        onChange={(e) => void run(() => api.study.updateExam(c.exam.id, { topicIds: e.target.checked ? [...scope, t.id] : [...scope].filter((x) => x !== t.id) }))} />{t.title}</label>)}</fieldset>
    </details>
  );
}

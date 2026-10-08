// Semester Board: exams, tasks, Classroom assignments, reminders and planned study on one board — Agenda, Week or Month.
// A read projection (Agenda module); every item opens its source. Reminders can be done/snoozed in place.
import { useCallback, useState } from 'react';
import { RECURRENCES } from '@classroom/protocol';
import type { AgendaItem, Recurrence } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText, useLoad } from '../useLoad.ts';
import { day, fromLocal, openItem, useStudy, when } from './common.tsx';

type Mode = 'agenda' | 'week' | 'month';
const DAY = 86_400_000;
const sod = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t: number, n: number) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const KIND: Record<AgendaItem['kind'], string> = { exam: 'Exam', task: 'Task', assignment: 'Classroom Assignment', reminder: 'Reminder', session: 'Planned study' };

function windowFor(mode: Mode, anchor: number): [number, number] {
  if (mode === 'agenda') return [sod(anchor), addDays(sod(anchor), 14) - 1];
  if (mode === 'week') { const s = addDays(sod(anchor), -((new Date(anchor).getDay() + 6) % 7)); return [s, addDays(s, 7) - 1]; }
  const d = new Date(anchor); const s = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); return [s, new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1];
}

export function Board() {
  const { go, start } = useStudy();
  const [mode, setMode] = useState<Mode>('agenda');
  const [anchor, setAnchor] = useState(Date.now());
  const [from, to] = windowFor(mode, anchor);
  const [items, reload] = useLoad<AgendaItem[]>(useCallback(() => api.study.range(from, to), [from, to]));
  const step = (k: number) => setAnchor(mode === 'month' ? new Date(new Date(anchor).getFullYear(), new Date(anchor).getMonth() + k, 1).getTime() : addDays(anchor, k * (mode === 'week' ? 7 : 14)));
  const byDay = (t: number) => (items ?? []).filter((i) => i.at !== null && sod(i.at) === sod(t));
  const Item = ({ i }: { i: AgendaItem }) => (
    <div className={`ag-item k-${i.kind} ${i.overdue ? 'overdue' : ''}`} data-testid="board-item">
      <button className="link left grow" onClick={() => openItem(i, go)} aria-label={`${KIND[i.kind]}: ${i.title}, ${when(i.at)}`}>
        <span className="chip">{KIND[i.kind]}</span> <b>{i.title}</b> <small className="muted">{i.at ? new Date(i.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}{i.status && i.kind !== 'reminder' ? ` · ${i.status}` : ''}</small>
      </button>
      {i.kind === 'reminder' && mode === 'agenda' && <>
        <button className="small" onClick={() => void api.study.reminderDone(i.id).then(reload)}>Done</button>
        <button className="small" onClick={() => void api.study.snooze(i.id, Date.now() + 3_600_000).then(reload)}>Snooze 1 h</button>
      </>}
      {i.kind === 'session' && <button className="small" onClick={() => void start({ sessionId: i.id, focus: true })}>Start</button>}
    </div>
  );
  return (
    <div className="stack board">
      <div className="row between wrap">
        <div className="row"><button className="small" aria-label="Previous" onClick={() => step(-1)}>‹</button><b>{mode === 'month' ? new Date(anchor).toLocaleDateString([], { month: 'long', year: 'numeric' }) : `${day(from)} – ${day(to)}`}</b><button className="small" aria-label="Next" onClick={() => step(1)}>›</button><button className="small" onClick={() => setAnchor(Date.now())}>Today</button></div>
        <div className="seg small" role="tablist" aria-label="Board view">{(['agenda', 'week', 'month'] as const).map((m) => <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>{m[0]!.toUpperCase() + m.slice(1)}</button>)}</div>
      </div>
      {mode === 'agenda' && (
        <section className="card panel-body" aria-label="Agenda">
          {items?.length === 0 && <p className="muted">Nothing in these two weeks.</p>}
          {Array.from({ length: 14 }, (_, k) => addDays(from, k)).filter((t) => byDay(t).length).map((t) => (
            <div key={t} className="ag-day"><span className="eyebrow">{day(t)}</span>{byDay(t).map((i) => <Item key={i.kind + i.id + i.at} i={i} />)}</div>
          ))}
        </section>
      )}
      {mode !== 'agenda' && (
        <div className={`cal cal-${mode}`} role="grid" aria-label={mode === 'week' ? 'Week' : 'Month'}>
          {mode === 'month' && ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <span key={d} className="cal-head" role="columnheader">{d}</span>)}
          {mode === 'month' && Array.from({ length: (new Date(from).getDay() + 6) % 7 }, (_, k) => <span key={`pad${k}`} className="cal-cell pad" />)}
          {Array.from({ length: Math.round((to + 1 - from) / DAY) }, (_, k) => addDays(from, k)).map((t) => (
            <div key={t} role="gridcell" className={`cal-cell ${sod(t) === sod(Date.now()) ? 'today' : ''}`} aria-label={day(t)}>
              <span className="cal-date">{mode === 'week' ? day(t) : new Date(t).getDate()}</span>
              {byDay(t).slice(0, mode === 'month' ? 3 : 20).map((i) => <button key={i.kind + i.id + i.at} className={`cal-ev k-${i.kind}`} onClick={() => openItem(i, go)} title={`${KIND[i.kind]}: ${i.title}`}>{i.title}</button>)}
              {mode === 'month' && byDay(t).length > 3 && <small className="muted">+{byDay(t).length - 3} more</small>}
            </div>
          ))}
        </div>
      )}
      <div className="board-forms">
        <NewReminder onDone={reload} />
        <PlanSession onDone={reload} />
      </div>
    </div>
  );
}

function NewReminder({ onDone }: { onDone(): void }) {
  const [o, setO] = useState({ text: '', at: '', recurrence: 'none' as Recurrence });
  const [err, setErr] = useState('');
  return (
    <form className="card stack" aria-label="New reminder" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { const at = fromLocal(o.at); if (!at) throw new Error('Pick a time.'); await api.study.remind({ text: o.text, dueAt: at, recurrence: o.recurrence }); setO({ text: '', at: '', recurrence: 'none' }); onDone(); } catch (x) { setErr(errText(x)); } }}>
      <span className="eyebrow">Reminder</span>
      <input required value={o.text} onChange={(e) => setO({ ...o, text: e.target.value })} placeholder="Return library book" aria-label="Reminder text" maxLength={300} />
      <div className="row"><input required type="datetime-local" value={o.at} onChange={(e) => setO({ ...o, at: e.target.value })} aria-label="Reminder time" />
        <select value={o.recurrence} onChange={(e) => setO({ ...o, recurrence: e.target.value as Recurrence })} aria-label="Repeat">{RECURRENCES.map((r) => <option key={r} value={r}>{r === 'none' ? 'Once' : r[0]!.toUpperCase() + r.slice(1)}</option>)}</select></div>
      {err && <span className="error small-text">{err}</span>}
      <button className="primary">Add reminder</button>
    </form>
  );
}

function PlanSession({ onDone }: { onDone(): void }) {
  const [courses] = useLoad(api.study.courses);
  const [o, setO] = useState({ courseId: '', goal: '', at: '', minutes: '50' });
  const [err, setErr] = useState('');
  return (
    <form className="card stack" aria-label="Plan study" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { const at = fromLocal(o.at); if (!at) throw new Error('Pick a time.'); await api.study.planSession({ courseId: o.courseId || null, goal: o.goal, at, minutes: Number(o.minutes) || null }); setO({ courseId: '', goal: '', at: '', minutes: '50' }); onDone(); } catch (x) { setErr(errText(x)); } }}>
      <span className="eyebrow">Plan study</span>
      <input value={o.goal} onChange={(e) => setO({ ...o, goal: e.target.value })} placeholder="Goal (Deadlocks practice)" aria-label="Study goal" maxLength={300} />
      <div className="row"><select value={o.courseId} onChange={(e) => setO({ ...o, courseId: e.target.value })} aria-label="Study course"><option value="">General</option>{courses?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input required type="datetime-local" value={o.at} onChange={(e) => setO({ ...o, at: e.target.value })} aria-label="Study time" />
        <input type="number" min={5} max={600} value={o.minutes} onChange={(e) => setO({ ...o, minutes: e.target.value })} aria-label="Minutes" className="num-input" /></div>
      {err && <span className="error small-text">{err}</span>}
      <button className="primary">Plan</button>
    </form>
  );
}

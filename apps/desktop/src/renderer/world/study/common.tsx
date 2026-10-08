// Shared bits of the Study area: navigation + the running study session (one context), date formatting, topic marks.
import { createContext, useContext, useEffect, useState } from 'react';
import { TOPIC_STATE_LABEL, TOPIC_STATES } from '@classroom/protocol';
import type { AgendaItem, StudySession, TopicState } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { useRecorder } from '../tape/recorder.tsx';

export type StudyTab = 'campus' | 'board' | 'tasks' | 'exams' | 'cards' | 'notes' | 'tapes' | 'boards' | 'history';
export type StudyTarget = { tab: StudyTab; courseId?: string; examId?: string; deckId?: string; noteId?: string; tapeId?: string; tapeAt?: number; boardId?: string };
export type StudyCtx = {
  target: StudyTarget; go(t: StudyTarget): void;
  session: StudySession | null;
  start(o: { sessionId?: string; courseId?: string | null; topicId?: string | null; goal?: string; minutes?: number | null; focus?: boolean }): Promise<void>;
  end(reflection?: string): Promise<void>;
};
export const Ctx = createContext<StudyCtx>(null as never);
export const useStudy = () => useContext(Ctx);

export const when = (ts: number | null) => (ts === null ? 'no date' : new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
export const day = (ts: number) => new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
/** <input type="datetime-local"> ↔ epoch ms, in local time. */
export const toLocal = (ts: number) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
export const fromLocal = (v: string) => (v ? new Date(v).getTime() : null);

export function Confidence({ state, onChange, label }: { state: TopicState; onChange(s: TopicState): void; label: string }) {
  return (
    <select className={`conf conf-${state}`} value={state} onChange={(e) => onChange(e.target.value as TopicState)} aria-label={`Your mark for ${label}`}>
      {TOPIC_STATES.map((s) => <option key={s} value={s}>{TOPIC_STATE_LABEL[s]}</option>)}
    </select>
  );
}
export const ConfChip = ({ state }: { state: TopicState }) => <span className={`chip conf-${state}`}>{TOPIC_STATE_LABEL[state]}</span>;

/** Where an agenda item lives; clicking it opens the source module. */
export function openItem(i: AgendaItem, go: StudyCtx['go']) {
  if (i.open.module === 'exams') return go({ tab: 'exams', examId: i.open.id });
  if (i.open.module === 'tasks') return go({ tab: 'tasks', courseId: i.courseId ?? undefined });
  if (i.courseId && i.open.module === 'assignments') return go({ tab: 'campus', courseId: i.courseId });
  go({ tab: 'board' });
}

/** The running session: timer, goal, shortcuts, end with an optional reflection. Nothing else is recorded. */
export function SessionBar({ onNote }: { onNote(): void }) {
  const { session, end, go } = useStudy();
  const rec = useRecorder();
  const [stopTape, setStopTape] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [ending, setEnding] = useState(false);
  const [reflection, setReflection] = useState('');
  useEffect(() => { if (!session) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [session]);
  if (!session) return null;
  const s = Math.max(0, Math.floor((now - session.startedAt!) / 1000));
  const clock = `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const over = session.plannedMinutes && s >= session.plannedMinutes * 60;
  return (
    <div className="session-bar card" role="region" aria-label="Study session" data-testid="session-bar">
      <span className="eyebrow">{session.focus ? 'Focus · ' : ''}Studying</span>
      <b>{session.goal || 'Study session'}</b>
      <span className="session-clock c-num" role="timer" aria-label="Elapsed">{clock}{session.plannedMinutes ? <small className="muted"> / {session.plannedMinutes} min{over ? ' · planned time reached' : ''}</small> : null}</span>
      <div className="row">
        <button className="small" onClick={onNote}>Notes</button>
        {session.courseId && <button className="small" onClick={() => go({ tab: 'campus', courseId: session.courseId! })}>Course</button>}
        <button className="small" onClick={() => go({ tab: 'cards', ...(session.courseId ? { courseId: session.courseId } : {}) })}>Flashcards</button>
        <button className="small" onClick={() => go({ tab: 'tasks', ...(session.courseId ? { courseId: session.courseId } : {}) })}>Tasks</button>
        {!rec.active && <button className="small" onClick={() => rec.open({ title: session.goal || 'Study session', courseId: session.courseId, topicId: session.topicId, studySessionId: session.id })}>Record</button>}
        {!ending ? <button className="small primary" onClick={() => setEnding(true)}>End session</button> : null}
      </div>
      {ending && (
        <form className="row wrap" onSubmit={async (e) => { e.preventDefault(); if (rec.active && stopTape) await rec.stop(); await end(reflection); setEnding(false); setReflection(''); }}>
          {rec.active && <label className="check small-text"><input type="checkbox" checked={stopTape} onChange={(e) => setStopTape(e.target.checked)} /> End recording and save the Study Tape</label>}
          <input value={reflection} onChange={(e) => setReflection(e.target.value)} placeholder="How did it go? (optional, only for you)" aria-label="Reflection" maxLength={5000} />
          <button className="primary small">Save and end</button>
        </form>
      )}
    </div>
  );
}

export function useActiveSession() {
  const [session, setSession] = useState<StudySession | null>(null);
  useEffect(() => { void api.study.activeSession().then(setSession); }, []);
  return [session, setSession] as const;
}

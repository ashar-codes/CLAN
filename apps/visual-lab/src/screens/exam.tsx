// Exam Command Center. Explicit demo mode: every number here is fixture data.
import { useState } from 'react';
import { ExamIndicator, ResourceCard } from '@clan/design';
import { EXAMS, FILES, TOPICS } from '../demo/fixtures.ts';
import type { Lab } from '../main.tsx';

const DAYS = ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'];
const PLAN: Record<string, string[]> = { Wed: ['Shortest paths 25m', 'AVL 25m'], Thu: ['Amortised 25m', 'Past paper Q1–3'], Fri: ['Study group 16:00'], Sat: ['Past paper 2025'], Sun: ['Flashcards · rest'], Mon: ['EXAM 09:00'] };

export function Exam({ lab }: { lab: Lab }) {
  const [topics, setTopics] = useState(TOPICS);
  const e = EXAMS[0]!;
  return (
    <div className="exam">
      <div className="demo-banner" role="note">Demo mode — fixture data, not your real exams.</div>
      <header className="exam-head">
        <div><span className="c-eyebrow">Exam mode · next up</span><h1 className="c-title">{e.course}</h1><p className="muted">{e.when}</p></div>
        <div className="countdown"><b>{e.daysLeft}</b><span>days</span></div>
      </header>
      <div className="exam-grid">
        <section className="c-card"><span className="c-eyebrow">All exams</span>{EXAMS.map((x) => <ExamIndicator key={x.id} course={x.course} daysLeft={x.daysLeft} readiness={x.readiness} />)}</section>
        <section className="c-card"><span className="c-eyebrow">Topics · tap to mark confidence</span>
          {topics.map((t, i) => (
            <button key={t.t} className="topic" onClick={() => setTopics(topics.map((x, j) => (j === i ? { ...x, conf: x.conf >= 1 ? 0.2 : Math.min(1, x.conf + 0.2) } : x)))}>
              <span>{t.t}</span><span className="bar"><i style={{ width: `${t.conf * 100}%`, background: t.conf < 0.4 ? 'var(--clay)' : t.conf < 0.7 ? 'var(--mustard)' : 'var(--sage)' }} /></span>
            </button>
          ))}</section>
        <section className="c-card week"><span className="c-eyebrow">This week</span>
          <div className="days">{DAYS.map((d) => <div key={d} className={d === 'Mon' ? 'exam-day' : ''}><b>{d}</b>{PLAN[d]!.map((p) => <span key={p}>{p}</span>)}</div>)}</div></section>
        <section className="c-card"><span className="c-eyebrow">Review material</span>{FILES.slice(0, 3).map((f) => <ResourceCard key={f.id} title={f.title} kind={f.kind} bytes={f.bytes} from="CS-201" />)}
          <button className="c-btn primary" onClick={() => lab.go('study')}>Start a 25-min block</button></section>
      </div>
    </div>
  );
}

// Private Diary: calm, on-device, no Guide, no sharing, no AI.
import { useState } from 'react';

const MOODS = [['calm', '#4f8a63'], ['tired', '#9a9488'], ['proud', '#e3a92f'], ['anxious', '#3f83cf'], ['low', '#7b827d']] as const;
const PAST = [
  { d: 'Mon 5 Oct', mood: 'anxious', t: 'Exams feel close. Made a plan with Hana — it helped to say it out loud.' },
  { d: 'Sat 3 Oct', mood: 'calm', t: 'Long walk, no laptop. Should do that more.' },
];

export function Diary() {
  const [mood, setMood] = useState<string>('calm');
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div className="diary">
      <div className="diary-page">
        <p className="lock">🔒 Private · stays on this device · never shared, never read by AI</p>
        <h1 className="diary-date">{today}</h1>
        <div className="moods" role="radiogroup" aria-label="Mood">
          {MOODS.map(([m, c]) => <button key={m} role="radio" aria-checked={mood === m} onClick={() => setMood(m)} style={{ ['--m' as string]: c }}><i />{m}</button>)}
        </div>
        <textarea className="diary-text" placeholder="How was today?" aria-label="Diary entry" />
        <div className="past">{PAST.map((p) => <article key={p.d}><span className="c-eyebrow">{p.d} · {p.mood}</span><p>{p.t}</p></article>)}</div>
      </div>
    </div>
  );
}

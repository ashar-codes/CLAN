// Flashcards: manual decks and an SM-2 review. Review loads only the cards due now. Keyboard: Space/Enter flips,
// 1–4 grade (Again / Hard / Good / Easy). Each grade button shows the interval SM-2 will give, so nothing is opaque.
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { GRADES, sm2 } from '@classroom/protocol';
import type { Card, Deck, Grade } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText, useLoad } from '../useLoad.ts';
import { day, useStudy } from './common.tsx';

const LABEL: Record<Grade, string> = { again: 'Again', hard: 'Hard', good: 'Good', easy: 'Easy' };
const ival = (d: number, g: Grade) => (g === 'again' ? '10 min' : d === 1 ? '1 day' : `${d} days`);

export function Cards({ courseId, deckId }: { courseId?: string; deckId?: string }) {
  const { go } = useStudy();
  const [decks, reload] = useLoad<Deck[]>(useCallback(() => api.study.decks(courseId ? { courseId } : {}), [courseId]));
  const [courses] = useLoad(api.study.courses);
  const [name, setName] = useState('');
  const [cid, setCid] = useState(courseId ?? '');
  const [err, setErr] = useState('');
  if (deckId) return <DeckView id={deckId} onBack={() => go({ tab: 'cards' })} />;
  return (
    <div className="stack">
      <div className="deck-grid">
        {decks?.map((d) => (
          <button key={d.id} className="card deck" onClick={() => go({ tab: 'cards', deckId: d.id })} aria-label={`${d.name}: ${d.cards} cards, ${d.due} due`}>
            <span className="deck-stack" aria-hidden><i /><i /><i /></span>
            <b>{d.name}</b><small className="muted">{courses?.find((c) => c.id === d.courseId)?.name ?? 'General'}</small>
            <span className="c-num">{d.cards} cards · <b>{d.due} due</b></span>
          </button>
        ))}
        {decks?.length === 0 && <p className="muted">No decks yet. Make one for a course, a topic, an exam — or just for you.</p>}
      </div>
      <form className="row card" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await api.study.createDeck({ name, courseId: cid || null }); setName(''); reload(); } catch (x) { setErr(errText(x)); } }}>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="New deck" aria-label="Deck name" maxLength={120} />
        <select value={cid} onChange={(e) => setCid(e.target.value)} aria-label="Deck course"><option value="">General study</option>{courses?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="primary">Add deck</button>
        {err && <span className="error small-text">{err}</span>}
      </form>
    </div>
  );
}

function DeckView({ id, onBack }: { id: string; onBack(): void }) {
  const [decks, reloadDecks] = useLoad(api.study.decks);
  const [cards, reload] = useLoad<Card[]>(useCallback(() => api.study.cards(id), [id]));
  const [reviewing, setReviewing] = useState(false);
  const [o, setO] = useState({ front: '', back: '', note: '' });
  const [err, setErr] = useState('');
  const deck = decks?.find((d) => d.id === id);
  const refresh = () => { reload(); reloadDecks(); };
  if (reviewing) return <Review deckId={id} name={deck?.name ?? 'Deck'} onDone={() => { setReviewing(false); refresh(); }} />;
  return (
    <div className="stack">
      <button className="link back" onClick={onBack}>← Decks</button>
      <div className="row between"><h2 className="title world">{deck?.name}</h2>
        <button className="primary" disabled={!deck?.due} onClick={() => setReviewing(true)}>Review {deck?.due ?? 0} due</button></div>
      <form className="card stack" aria-label="New card" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await api.study.addCard(id, { front: o.front, back: o.back, note: o.note || undefined }); setO({ front: '', back: '', note: '' }); refresh(); } catch (x) { setErr(errText(x)); } }}>
        <div className="form-grid">
          <textarea required value={o.front} onChange={(e) => setO({ ...o, front: e.target.value })} placeholder="Front (question)" aria-label="Card front" rows={2} maxLength={2000} />
          <textarea required value={o.back} onChange={(e) => setO({ ...o, back: e.target.value })} placeholder="Back (answer)" aria-label="Card back" rows={2} maxLength={4000} />
        </div>
        <input value={o.note} onChange={(e) => setO({ ...o, note: e.target.value })} placeholder="Note (optional)" aria-label="Card note" maxLength={2000} />
        {err && <span className="error small-text">{err}</span>}
        <div className="row"><button className="primary">Add card</button></div>
      </form>
      <section className="card panel-body">
        {cards?.map((c) => <div key={c.id} className="line"><span className="grow"><b>{c.front}</b><br /><small className="muted">{c.back}</small></span>
          <span className="muted small-text c-num">{c.reps ? `every ${c.interval} d · next ${day(c.dueAt)}` : 'new'}</span>
          <button className="small danger" aria-label={`Delete card ${c.front}`} onClick={() => void api.study.removeCard(c.id).then(refresh)}>✕</button></div>)}
        {cards?.length === 0 && <p className="muted">No cards yet.</p>}
      </section>
    </div>
  );
}

function Review({ deckId, name, onDone }: { deckId: string; name: string; onDone(): void }) {
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(0);
  useEffect(() => { void api.study.queue(deckId).then(setQueue); }, [deckId]);
  const card = queue?.[i];
  const grade = async (g: Grade) => {
    if (!card || !shown) return;
    const next = await api.study.review(card.id, g);
    setDone(done + 1); setShown(false);
    // "Again" comes back in 10 minutes: keep it at the end of this sitting.
    if (g === 'again') setQueue([...queue!, next]);
    setI(i + 1);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setShown(true); }
    const n = Number(e.key); if (shown && n >= 1 && n <= 4) { e.preventDefault(); void grade(GRADES[n - 1]!); }
  };
  if (!queue) return null;
  return (
    <div className="stack review" onKeyDown={key} data-testid="review">
      <div className="row between"><span className="eyebrow">Reviewing {name}</span><button className="small" onClick={onDone}>Done</button></div>
      <p className="sr-only" aria-live="polite">{card ? (shown ? `Answer: ${card.back}` : `Question: ${card.front}`) : `Finished. ${done} reviewed.`}</p>
      {card ? (
        <>
          <button autoFocus className={`flashcard ${shown ? 'flipped' : ''}`} onClick={() => setShown(true)} aria-label={shown ? `Answer: ${card.back}` : `Question: ${card.front}. Press Space to show the answer.`}>
            <span className="fc-face">{shown ? card.back : card.front}</span>
            {shown && card.note && <small className="muted">{card.note}</small>}
            {!shown && <small className="muted">Space or tap to show the answer</small>}
          </button>
          <div className="grades" role="group" aria-label="How well did you know it?">
            {GRADES.map((g, k) => { const n = sm2(card, g, Date.now()); return (
              <button key={g} className={`grade g-${g}`} disabled={!shown} onClick={() => void grade(g)} aria-keyshortcuts={String(k + 1)}>
                <b>{LABEL[g]}</b><small className="c-num">{ival(n.interval, g)}</small>
              </button>); })}
          </div>
          <small className="muted c-num">{queue.length - i} left · {done} reviewed · keys: Space flips, 1–4 grade</small>
        </>
      ) : <div className="empty-place"><b>All caught up.</b><span className="muted">{done} card{done === 1 ? '' : 's'} reviewed. Next ones come back when SM-2 schedules them.</span><button className="primary" onClick={onDone}>Back to deck</button></div>}
    </div>
  );
}

// CLAN Intelligence UI (lazy chunk): context preview, streamed source-grounded answers with citations, and review of
// every suggestion (drafts, quizzes, comparisons, lecture packages, past papers, Exam Coach plans). Nothing changes until
// the student presses Accept; the owning module then applies it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Citation, ExamGap, Include, PaperResult, Preview, ProposalView, QuizResult, RunResult, SourceKind } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText } from '../useLoad.ts';
import type { AIOpen } from './ctx.ts';

export type OpenSource = (open: Record<string, unknown> | null) => void;
const KIND_LABEL: Record<string, string> = { CREATE_FLASHCARDS: 'Add flashcards', CREATE_TASKS: 'Create tasks', CREATE_REMINDERS: 'Create reminders', CREATE_STUDY_PLAN: 'Suggested study plan', APPEND_NOTE: 'Note change', UPDATE_TOPIC_CONFIDENCE: 'Change your topic mark', ADD_EXAM_SCOPE: 'Add topics to the exam scope' };
const STATE: Record<string, string> = { not_started: 'Not started', learning: 'Learning', review: 'Needs review', confident: 'Confident' };

export default function Sheet({ o, onClose, openSource }: { o: AIOpen; onClose(): void; openSource: OpenSource }) {
  return (
    <div className="ai-sheet card" role="dialog" aria-label={o.title} data-testid="ai-sheet">
      <div className="row between"><span className="eyebrow ai">CLAN · {o.title}</span><button className="small" onClick={onClose}>Close</button></div>
      {o.mode === 'run' && <RunView key={JSON.stringify([o.action, o.scope, o.question])} o={o} openSource={openSource} onClose={onClose} />}
      {o.mode === 'paper' && <PaperView refId={o.refId} examId={o.examId ?? null} openSource={openSource} />}
      {o.mode === 'coach' && <CoachView examId={o.examId} openSource={openSource} />}
    </div>
  );
}

function RunView({ o, openSource, onClose }: { o: Extract<AIOpen, { mode: 'run' }>; openSource: OpenSource; onClose(): void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [include, setInclude] = useState<Partial<Include> | undefined>(o.include);
  const [question, setQuestion] = useState(o.question ?? '');
  const [stream, setStream] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const started = useRef(false);
  const runRef = useRef<string | null>(null);
  useEffect(() => { void api.ai.preview({ action: o.action, scope: o.scope, include }).then(setPreview, (e) => setErr(errText(e))); }, [o.action, o.scope, include]);
  useEffect(() => api.ai.onDelta((d) => { if (d.runId === runRef.current) setStream((s) => s + d.text); }), []);
  const go = async () => {
    const id = crypto.randomUUID(); runRef.current = id; setRunning(id); setStream(''); setResult(null); setErr('');
    try { setResult(await api.ai.run(id, { action: o.action, scope: o.scope, include, question: question || undefined, selection: o.selection, deckId: o.deckId })); }
    catch (e) { setErr(errText(e)); } finally { setRunning(null); runRef.current = null; }
  };
  useEffect(() => { if (!o.ask && !started.current && preview) { started.current = true; void go(); } }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps
  const broad = ['global', 'course', 'search', 'clan', 'exam'].includes(o.scope.kind);
  return (
    <div className="stack">
      {preview && <Sources preview={preview} open={broad || !!o.ask} onChange={(k, v) => setInclude({ ...(include ?? {}), [k]: v })} />}
      {o.ask && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (question.trim()) void go(); }}>
          <input autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about your material…" aria-label="Ask CLAN" maxLength={4000} className="grow" />
          <button className="primary" disabled={!question.trim() || !!running}>Ask</button>
        </form>
      )}
      {running && <div className="row"><span className="muted small-text" role="status">CLAN is reading your sources…</span><button className="small" onClick={() => void api.ai.cancel(running)}>Cancel</button></div>}
      {running && stream && <pre className="ai-stream" aria-live="polite">{stream}</pre>}
      {err && <p className="error small-text" role="alert">{err}</p>}
      {result && <ResultView r={result} o={o} openSource={openSource} onClose={onClose} />}
    </div>
  );
}

function Sources({ preview, open, onChange }: { preview: Preview; open: boolean; onChange(k: SourceKind, v: boolean): void }) {
  return (
    <details className="ai-sources" open={open}>
      <summary className="small-text">Sources CLAN will use · {preview.agent.name} · {preview.sources} item{preview.sources === 1 ? '' : 's'}{preview.diaryIncluded ? ' · Diary included' : ''}</summary>
      <div className="ai-groups" role="group" aria-label="Sources">
        {preview.groups.map((g) => (
          <label key={g.kind} className={`chip-check ${g.available ? '' : 'off'}`} title={g.examples.join(', ')}>
            <input type="checkbox" checked={g.included} disabled={!g.available} onChange={(e) => onChange(g.kind, e.target.checked)} />
            {g.label}{g.count ? ` · ${g.count}` : ''}{!g.available ? ' (not allowed — Me › AI)' : ''}
          </label>
        ))}
      </div>
      {preview.notes.map((n) => <p key={n} className="muted small-text">{n}</p>)}
      <p className="muted small-text">Cannot: {preview.agent.cannot.join(' · ')}.</p>
    </details>
  );
}

function Cite({ c, openSource }: { c: Citation; openSource: OpenSource }) {
  return <button className="cite" onClick={() => openSource(c.open)} title={c.excerpt} data-testid="citation">[{c.n}] {c.label}</button>;
}
function CiteList({ cites, ns, openSource }: { cites: Citation[]; ns?: number[]; openSource: OpenSource }) {
  const list = ns ? cites.filter((c) => ns.includes(c.n)) : cites;
  return list.length ? <span className="cites">{list.map((c) => <Cite key={c.n} c={c} openSource={openSource} />)}</span> : null;
}

function ResultView({ r, o, openSource, onClose }: { r: RunResult; o: Extract<AIOpen, { mode: 'run' }>; openSource: OpenSource; onClose(): void }) {
  const foot = (
    <p className="muted small-text ai-foot" data-testid="ai-diagnostics">{r.provider ? `${r.provider.label} · ${r.provider.model}${r.provider.local ? ' · on this device' : ''}` : 'No AI model'} · {r.used.length} source{r.used.length === 1 ? '' : 's'} considered{r.citations.length ? ` · ${new Set(r.citations.map((c) => c.label)).size} cited` : ''}{r.diaryIncluded ? ' · Diary included' : ''}{r.usage?.inputTokens ? ` · ~${r.usage.inputTokens + (r.usage.outputTokens ?? 0)} tokens` : ''}</p>
  );
  if (r.status !== 'ok') return (
    <div className="stack">
      <p className={r.status === 'error' ? 'error' : 'muted'} role="status" data-testid="ai-status">{r.status === 'unavailable' ? r.message : r.message}</p>
      {r.passages.length > 0 && <section className="ai-local"><span className="eyebrow">From your material (local search, no AI)</span>{r.passages.slice(0, 6).map((c) => <div key={c.n} className="line"><span className="small-text">{c.excerpt}</span><Cite c={c} openSource={openSource} /></div>)}</section>}
      {foot}
    </div>
  );
  return (
    <div className="stack" data-testid="ai-result">
      {r.answer && <Answer r={r} openSource={openSource} onText={o.onText ? (t, how) => { o.onText!(t, how); onClose(); } : undefined} />}
      {r.action === 'flashcards' && <Drafts r={r} />}
      {(r.action === 'quiz' || r.action === 'questions') && <Quiz r={r} openSource={openSource} />}
      {r.action === 'compare' && <Compare r={r} openSource={openSource} />}
      {r.action === 'prepareLecture' && <Lecture r={r} openSource={openSource} />}
      {r.action === 'examPlan' && <Plan r={r} />}
      {foot}
    </div>
  );
}

function Answer({ r, openSource, onText }: { r: RunResult; openSource: OpenSource; onText?(t: string, how: 'insert' | 'append' | 'new'): void }) {
  const a = r.answer!;
  const text = a.material.map((m) => m.text.replace(/\s*\[S\d+\]/g, '')).join('\n\n');
  return (
    <div className="stack ai-answer" data-testid="ai-answer">
      {a.notFound || !a.material.length ? <p data-testid="ai-notfound"><b>Not found in your selected CLAN material.</b> <span className="muted">Try including more sources.</span></p> : (
        <section><span className="eyebrow">From your CLAN material</span>
          {a.material.map((m, i) => <p key={i}>{m.text.replace(/\s*\[S\d+\]/g, '')} <CiteList cites={r.citations} ns={m.cites} openSource={openSource} /></p>)}</section>
      )}
      {a.general && <section className="ai-general"><span className="eyebrow">General explanation · not from your material</span><p>{a.general}</p></section>}
      {a.unsupported.length > 0 && <p className="muted small-text">{a.unsupported.length} statement{a.unsupported.length === 1 ? '' : 's'} left out: not supported by your sources.</p>}
      {onText && text && <div className="row" role="group" aria-label="Use this text">
        <button className="small" onClick={() => onText(text, 'insert')}>Insert</button><button className="small" onClick={() => onText(text, 'append')}>Append</button>
        <button className="small" onClick={() => onText(text, 'new')}>Create new Note</button></div>}
    </div>
  );
}

/** Accept / Dismiss for one proposal; nothing happens before Accept. */
function ProposalCard({ p, edited, children, onDone }: { p: ProposalView; edited?: () => unknown; children?: React.ReactNode; onDone?(v: ProposalView | null): void }) {
  const [state, setState] = useState(p.status);
  const [err, setErr] = useState('');
  const act = async (accept: boolean) => {
    setErr('');
    try { if (accept) { const v = await api.ai.accept(p.id, edited?.()); setState('accepted'); onDone?.(v); } else { await api.ai.dismiss(p.id); setState('dismissed'); onDone?.(null); } } catch (e) { setErr(errText(e)); }
  };
  return (
    <section className={`card proposal st-${state}`} data-testid={`proposal-${p.kind}`}>
      <div className="row between"><span className="eyebrow">Suggestion · {KIND_LABEL[p.kind] ?? p.kind}</span><span className="muted small-text">{state === 'pending' ? 'not applied' : state}</span></div>
      <p className="small-text">{p.explanation}</p>
      {children}
      {state === 'pending' && <div className="row"><button className="primary small" onClick={() => void act(true)}>Accept</button><button className="small" onClick={() => void act(false)}>Dismiss</button></div>}
      {err && <p className="error small-text">{err}</p>}
    </section>
  );
}

type DraftCard = { front: string; back: string; source: unknown; from: string; keep: boolean };
function Drafts({ r }: { r: RunResult }) {
  const p = r.proposals[0];
  const [cards, setCards] = useState<DraftCard[]>(() => ((p?.payload as { cards?: Omit<DraftCard, 'keep'>[] })?.cards ?? []).map((c) => ({ ...c, keep: true })));
  if (!p) return null;
  const set = (i: number, patch: Partial<DraftCard>) => setCards(cards.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const kept = cards.filter((c) => c.keep);
  return (
    <ProposalCard p={p} edited={() => ({ ...(p.payload as object), cards: kept.map(({ keep: _k, ...c }) => c) })}>
      <p className="muted small-text">Drafts — not in any deck yet. Edit, untick to reject, then Accept {kept.length}.</p>
      {cards.map((c, i) => (
        <div key={i} className={`draft-card ${c.keep ? '' : 'rejected'}`} data-testid="draft-card">
          <label className="row small-text"><input type="checkbox" checked={c.keep} onChange={(e) => set(i, { keep: e.target.checked })} aria-label={`Keep card ${i + 1}`} /> Keep</label>
          <input value={c.front} onChange={(e) => set(i, { front: e.target.value })} aria-label={`Front of card ${i + 1}`} maxLength={2000} />
          <textarea value={c.back} onChange={(e) => set(i, { back: e.target.value })} aria-label={`Back of card ${i + 1}`} rows={2} maxLength={4000} />
          <small className="muted">from {c.from}</small>
        </div>
      ))}
    </ProposalCard>
  );
}

type QItem = { i: number; type: 'mcq' | 'short' | 'tf'; question: string; options: string[]; topic: string; cites: number[] };
function Quiz({ r, openSource }: { r: RunResult; openSource: OpenSource }) {
  const d = r.data as { quizId: string; questions: QItem[] };
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [self, setSelf] = useState<Record<number, boolean>>({});
  const [res, setRes] = useState<QuizResult | null>(null);
  const [err, setErr] = useState('');
  return (
    <div className="stack quiz" data-testid="quiz">
      {d.questions.map((q) => {
        const out = res?.results.find((x) => x.i === q.i);
        return (
          <fieldset key={q.i} className={`quiz-q ${out ? (out.correct ? 'ok' : 'wrong') : ''}`}>
            <legend><b>{q.i + 1}.</b> {q.question}</legend>
            {q.type === 'short' ? <input value={answers[q.i] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.i]: e.target.value })} aria-label={`Answer ${q.i + 1}`} disabled={!!res} />
              : q.options.map((op) => <label key={op} className="radio"><input type="radio" name={`q${q.i}`} checked={answers[q.i] === op} disabled={!!res} onChange={() => setAnswers({ ...answers, [q.i]: op })} />{op}</label>)}
            {q.type === 'short' && !res && answers[q.i] && <label className="row small-text"><input type="checkbox" checked={!!self[q.i]} onChange={(e) => setSelf({ ...self, [q.i]: e.target.checked })} /> I’m sure it’s right (otherwise CLAN compares words)</label>}
            {out && <p className="small-text">{out.correct ? '✓ Correct.' : `✗ Expected: ${out.expected}.`} {out.explanation} <CiteList cites={out.citations} openSource={openSource} /></p>}
          </fieldset>
        );
      })}
      {!res && <button className="primary" onClick={async () => { try { setRes(await api.ai.answerQuiz(d.quizId, d.questions.map((q) => ({ i: q.i, answer: answers[q.i] ?? '', ...(q.type === 'short' && self[q.i] !== undefined ? { selfCorrect: self[q.i] } : {}) })))); } catch (e) { setErr(errText(e)); } }}>Check answers</button>}
      {err && <p className="error small-text">{err}</p>}
      {res && <p data-testid="quiz-score"><b>{res.score} of {res.total}</b> correct. Saved on this device.</p>}
      {res?.suggestions.map((s) => s.proposal ? <ProposalCard key={s.topicId} p={s.proposal}><p className="small-text"><b>{s.message}</b> — your mark is “{STATE[s.current]}”. Change it to “Needs review”?</p></ProposalCard> : <p key={s.topicId} className="muted small-text">{s.message} (already marked Needs review).</p>)}
    </div>
  );
}

function Compare({ r, openSource }: { r: RunResult; openSource: OpenSource }) {
  const d = r.data as { note: { title: string }; covered: { topic: string; cites: number[] }[]; missing: { concept: string; detail: string; cites: number[] }[]; conflicts: { noteSays: string; sourceSays: string; cites: number[] }[]; review: { section: string; reason: string }[]; unsupported: number };
  return (
    <div className="stack compare" data-testid="compare">
      <section><span className="eyebrow">In the material, missing from “{d.note.title}” · {d.missing.length}</span>{d.missing.map((m, i) => <p key={i}><b>{m.concept}</b>{m.detail ? ` — ${m.detail}` : ''} <CiteList cites={r.citations} ns={m.cites} openSource={openSource} /></p>)}{!d.missing.length && <p className="muted">Nothing missing that the sources support.</p>}</section>
      {d.conflicts.length > 0 && <section><span className="eyebrow">Possible conflicts · check these</span>{d.conflicts.map((c, i) => <p key={i}>Your note: “{c.noteSays}” · Source: “{c.sourceSays}” <CiteList cites={r.citations} ns={c.cites} openSource={openSource} /></p>)}</section>}
      {d.covered.length > 0 && <details><summary className="small-text">Covered by your note · {d.covered.length}</summary>{d.covered.map((c, i) => <p key={i} className="small-text">{c.topic} <CiteList cites={r.citations} ns={c.cites} openSource={openSource} /></p>)}</details>}
      {d.review.length > 0 && <section><span className="eyebrow">May need review</span>{d.review.map((x, i) => <p key={i} className="small-text">{x.section}: {x.reason}</p>)}</section>}
      {d.unsupported > 0 && <p className="muted small-text">{d.unsupported} claim{d.unsupported === 1 ? '' : 's'} left out: no source supported {d.unsupported === 1 ? 'it' : 'them'}.</p>}
      {r.proposals.map((p) => <ProposalCard key={p.id} p={p}>{p.kind === 'APPEND_NOTE' && <pre className="ai-preview">{(p.payload as { text: string }).text}</pre>}</ProposalCard>)}
      {r.proposals.length > 0 && <button className="small" onClick={() => void Promise.all(r.proposals.map((p) => api.ai.dismiss(p.id)))}>Ignore all</button>}
    </div>
  );
}

function Lecture({ r, openSource }: { r: RunResult; openSource: OpenSource }) {
  const d = r.data as { summary: { text: string; cites: number[] }[]; concepts: { term: string; explanation: string; cites: number[] }[]; definitions: { term: string; definition: string; cites: number[] }[]; questions: { question: string }[]; checklist: string[] };
  return (
    <div className="stack" data-testid="lecture-prep">
      <p className="muted small-text">Draft generated by CLAN from linked material. No recording or transcript exists for this lecture.</p>
      {d.summary.length > 0 && <section><span className="eyebrow">Summary</span>{d.summary.map((x, i) => <p key={i}>{x.text} <CiteList cites={r.citations} ns={x.cites} openSource={openSource} /></p>)}</section>}
      {d.concepts.length > 0 && <section><span className="eyebrow">Key concepts</span>{d.concepts.map((x, i) => <p key={i}><b>{x.term}</b>: {x.explanation} <CiteList cites={r.citations} ns={x.cites} openSource={openSource} /></p>)}</section>}
      {d.questions.length > 0 && <section><span className="eyebrow">Possible questions</span><ul>{d.questions.map((x, i) => <li key={i}>{x.question}</li>)}</ul></section>}
      {r.proposals.map((p) => p.kind === 'CREATE_FLASHCARDS' ? <Drafts key={p.id} r={{ ...r, proposals: [p] }} /> : <ProposalCard key={p.id} p={p}>{p.kind === 'CREATE_TASKS' && <ul className="small-text">{(p.payload as { tasks: { checklist: string[] }[] }).tasks[0]!.checklist.map((c) => <li key={c}>{c}</li>)}</ul>}</ProposalCard>)}
    </div>
  );
}

type PlanSession = { at: number; minutes: number; topicId: string | null; goal: string };
function Plan({ r }: { r: RunResult }) {
  const p = r.proposals[0];
  const [items, setItems] = useState<(PlanSession & { keep: boolean })[]>(() => ((p?.payload as { sessions?: PlanSession[] })?.sessions ?? []).map((s) => ({ ...s, keep: true })));
  const d = r.data as { rationale: string } | undefined;
  const byDay = useMemo(() => [...new Set(items.map((s) => new Date(s.at).toDateString()))], [items]);
  if (!p) return null;
  return (
    <ProposalCard p={p} edited={() => ({ ...(p.payload as object), sessions: items.filter((s) => s.keep).map(({ keep: _k, ...s }) => s) })}>
      {d?.rationale && <p className="muted small-text">{d.rationale}</p>}
      <p className="muted small-text">Nothing is planned until you accept. Untick or change minutes to edit.</p>
      {byDay.map((day) => (
        <div key={day} className="plan-day" data-testid="plan-day"><b>{new Date(day).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</b>
          {items.map((s, i) => new Date(s.at).toDateString() !== day ? null : (
            <label key={i} className="row small-text"><input type="checkbox" checked={s.keep} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, keep: e.target.checked } : x)))} />
              {s.goal.split(' · ')[0]} · <input type="number" className="num-input" min={5} max={240} value={s.minutes} aria-label={`Minutes for ${s.goal}`} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, minutes: Number(e.target.value) || 5, goal: x.goal.replace(/\d+ min/, `${Number(e.target.value) || 5} min`) } : x)))} /> min</label>
          ))}
        </div>
      ))}
    </ProposalCard>
  );
}

function PaperView({ refId, examId, openSource }: { refId: string; examId: string | null; openSource: OpenSource }) {
  const [r, setR] = useState<PaperResult | null>(null);
  const [scope, setScope] = useState<ProposalView | null | undefined>(undefined);
  const [err, setErr] = useState('');
  const load = () => api.ai.analyzePaper(refId, examId).then(setR, (e) => setErr(errText(e)));
  useEffect(() => { void load(); }, [refId, examId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <p className="error">{err}</p>;
  if (!r) return <p className="muted" role="status">Reading the paper…</p>;
  if (r.status !== 'ok') return <p className="muted" data-testid="paper-unsupported">{r.reason}</p>;
  const title = (id: string | null) => r.topics?.find((t) => t.id === id)?.title ?? '—';
  return (
    <div className="stack" data-testid="paper">
      <p className="muted small-text">{r.questions.length} question{r.questions.length === 1 ? '' : 's'} found in the text of {r.label}. Topic suggestions are only suggestions — confirm each one.</p>
      {r.questions.map((q) => (
        <div key={q.id} className="paper-q line" data-testid="paper-question">
          <span className="grow"><button className="cite" onClick={() => openSource({ module: 'files', refId: q.refId, page: q.page })}>{q.cite}</button><br />{q.text}
            {q.suggestedTopicId && !q.topicId && <small className="muted"><br />Suggested: {title(q.suggestedTopicId)} ({q.method}, {q.confidence} confidence)</small>}</span>
          <select value={q.topicId ?? ''} aria-label={`Topic for Q${q.n}`} onChange={async (e) => { await api.ai.confirmPaperTopic(q.id, e.target.value || null); void load(); }}>
            <option value="">{q.topicId ? 'No topic' : 'Choose topic…'}</option>{r.topics?.map((t) => <option key={t.id} value={t.id}>{t.title}{t.id === q.suggestedTopicId && !q.topicId ? ' (suggested)' : ''}</option>)}
          </select>
          {q.suggestedTopicId && !q.topicId && <button className="small" onClick={async () => { await api.ai.confirmPaperTopic(q.id, q.suggestedTopicId); void load(); }}>Confirm</button>}
        </div>
      ))}
      {examId && scope === undefined && <button onClick={async () => setScope(await api.ai.proposeScope(refId, examId))}>Add confirmed topics to the exam scope…</button>}
      {scope === null && <p className="muted small-text">All confirmed topics are already in the exam scope.</p>}
      {scope && <ProposalCard p={scope} />}
    </div>
  );
}

function CoachView({ examId, openSource }: { examId: string; openSource: OpenSource }) {
  const [gaps, setGaps] = useState<ExamGap[] | null>(null);
  const [sub, setSub] = useState<Extract<AIOpen, { mode: 'run' }> | null>(null);
  useEffect(() => { void api.ai.examGaps(examId).then(setGaps); }, [examId]);
  const scope = { kind: 'exam' as const, examId };
  return (
    <div className="stack" data-testid="exam-coach">
      <section><span className="eyebrow">Gaps from your own data</span>
        {gaps?.filter((g) => g.gap || g.reasons.length).map((g) => <p key={g.topicId} className="small-text"><b>{g.title}</b> — {g.reasons.join(' ')}</p>)}
        {gaps && !gaps.some((g) => g.gap) && <p className="muted small-text">Every topic in scope is marked Confident.</p>}</section>
      <div className="row wrap">
        <button className="primary" onClick={() => setSub({ mode: 'run', title: 'Study plan', action: 'examPlan', scope })}>Suggest a study plan</button>
        <button onClick={() => setSub({ mode: 'run', title: 'Quiz', action: 'quiz', scope })}>Quiz me</button>
        <button onClick={() => setSub({ mode: 'run', title: 'Flashcards', action: 'flashcards', scope })}>Draft flashcards</button>
        <select value="" aria-label="Explain a topic" onChange={(e) => e.target.value && setSub({ mode: 'run', title: 'Explain', action: 'explain', scope, question: `Explain ${e.target.value}` })}>
          <option value="">Explain a topic…</option>{gaps?.map((g) => <option key={g.topicId} value={g.title}>{g.title}</option>)}</select>
      </div>
      <p className="muted small-text">Exam Coach suggests; it never changes your marks, tasks, reminders or the exam date by itself, and never reads your Diary or chats.</p>
      {sub && <RunView key={JSON.stringify(sub)} o={sub} openSource={openSource} onClose={() => setSub(null)} />}
    </div>
  );
}

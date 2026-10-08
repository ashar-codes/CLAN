// Study Tape player: the recording with its timeline (markers on the seek bar, jump to any event, notes and screenshots
// in place). Not an editor. Future AI actions are shown unavailable until a transcript exists — nothing pretends.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Tape, TapeEvent } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText } from '../useLoad.ts';
import { useAI } from '../ai/ctx.tsx';
import { tc } from './recorder.tsx';

const ICON: Record<TapeEvent['kind'], string> = { important: '⭐', note: '📝', screenshot: '📸', bookmark: '🔖', marker: '•' };
const LABEL: Record<TapeEvent['kind'], string> = { important: 'Important', note: 'Note', screenshot: 'Screenshot', bookmark: 'Bookmark', marker: 'Marker' };

export function TapePlayer({ id, at, onBack, onOpenNote }: { id: string; at?: number; onBack(): void; onOpenNote?(noteId: string): void }) {
  const [d, setD] = useState<{ tape: Tape; events: TapeEvent[] } | null>(null);
  const [err, setErr] = useState('');
  const v = useRef<HTMLVideoElement>(null), box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0); const [playing, setPlaying] = useState(false); const [rate, setRate] = useState(1); const [vol, setVol] = useState(1);
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);
  const [lectures, setLectures] = useState<{ id: string; title: string }[]>([]);
  const ai = useAI();
  const [clans, setClans] = useState<{ id: string; name: string }[]>([]);
  const [shared, setShared] = useState('');
  const load = useCallback(() => api.rec.get(id).then(setD, (e) => setErr(errText(e))), [id]);
  useEffect(() => { void api.clan.list().then((x) => setClans(x.map((k) => ({ id: k.id, name: k.name })))); }, []);
  useEffect(() => { void load(); void api.study.courses().then((c) => setCourses(c.map((x) => ({ id: x.id, name: x.name })))); }, [load]);
  useEffect(() => { if (d?.tape.courseId) void api.study.course(d.tape.courseId).then((c) => setLectures(c.lectures.map((l) => ({ id: l.id, title: l.title })))); else setLectures([]); }, [d?.tape.courseId]);
  const dur = (d?.tape.durationMs ?? 0) / 1000;
  const seek = (s: number) => { const el = v.current; if (el) { el.currentTime = Math.max(0, Math.min(dur || el.duration || 0, s)); setT(el.currentTime); } };
  /** MediaRecorder WebM has no duration index: let Chromium scan once so seeking works, then jump to `at`. */
  const ready = () => { const el = v.current; if (!el) return; if (!Number.isFinite(el.duration)) { el.currentTime = 1e101; el.addEventListener('durationchange', () => { el.currentTime = (at ?? 0) / 1000; }, { once: true }); } else if (at) el.currentTime = at / 1000; };
  if (err) return <div className="stack"><button className="link back" onClick={onBack}>← Study Tapes</button><p className="error">{err}</p></div>;
  if (!d) return null;
  const { tape, events } = d;
  const add = async (kind: 'bookmark' | 'note' | 'important', text = '') => { await api.rec.mark(tape.id, { kind, atMs: Math.round(t * 1000), text: text || undefined }).catch((e) => setErr(errText(e))); void load(); };
  return (
    <div className="stack tape-player" data-testid="tape-player">
      <button className="link back" onClick={onBack}>← Study Tapes</button>
      <div className="row between wrap"><h2 className="title world">{tape.title}</h2><span className="muted small-text">{tape.status === 'recovered' ? 'Recovered after an interruption · ' : ''}{tc(tape.durationMs ?? 0)} · {(tape.bytes / 1e6).toFixed(0)} MB{tape.othersConsent ? ' · includes other people' : ''}</span></div>
      {tape.refId ? (
        <div className="tape-screen" ref={box}>
          <video ref={v} src={`clan-media://${tape.refId}`} preload="metadata" onLoadedMetadata={ready} onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} data-testid="tape-video" aria-label={`Study Tape ${tape.title}`} />
        </div>
      ) : <p className="muted">{tape.status === 'failed' ? `Nothing was recorded (${tape.endReason}).` : 'Still recording…'}</p>}
      {tape.refId && <div className="tape-controls" role="group" aria-label="Playback">
        <button className="small" onClick={() => (playing ? v.current?.pause() : void v.current?.play())} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
        <span className="c-num small-text" data-testid="tape-time">{tc(t * 1000)} / {tc(tape.durationMs ?? 0)}</span>
        <div className="tape-seek">
          <input type="range" min={0} max={Math.max(1, dur)} step={0.1} value={Math.min(t, dur)} onChange={(e) => seek(Number(e.target.value))} aria-label="Seek" />
          {events.map((e) => <button key={e.id} className={`tape-tick k-${e.kind}`} style={{ left: `${dur ? (e.atMs / 1000 / dur) * 100 : 0}%` }} title={`${tc(e.atMs)} ${LABEL[e.kind]}`} aria-label={`Jump to ${LABEL[e.kind]} at ${tc(e.atMs)}`} onClick={() => seek(e.atMs / 1000)} />)}
        </div>
        <select value={rate} onChange={(e) => { const r = Number(e.target.value); setRate(r); if (v.current) v.current.playbackRate = r; }} aria-label="Speed">{[0.75, 1, 1.25, 1.5, 2].map((r) => <option key={r} value={r}>{r}×</option>)}</select>
        <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => { const x = Number(e.target.value); setVol(x); if (v.current) v.current.volume = x; }} aria-label="Volume" className="tape-vol" />
        <button className="small" onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void box.current?.requestFullscreen())} aria-label="Fullscreen">⛶</button>
        <button className="small" onClick={() => void add('bookmark', 'Bookmark')}>🔖 Here</button>
      </div>}
      <section className="card panel-body" aria-label="Timeline" data-testid="tape-timeline">
        <span className="eyebrow">Timeline</span>
        {events.map((e) => (
          <div key={e.id} className="line tape-event" data-testid="tape-event">
            <button className="link c-num" onClick={() => seek(e.atMs / 1000)} aria-label={`Jump to ${tc(e.atMs)}`}>{tc(e.atMs)}</button>
            <span aria-hidden>{ICON[e.kind]}</span>
            <span className="grow">{e.kind === 'screenshot' && e.refId ? <img className="tape-shot" src={`clan-media://${e.refId}`} alt={`Screenshot at ${tc(e.atMs)}`} /> :
              <input className="inline-edit" defaultValue={e.text || LABEL[e.kind]} aria-label={`${LABEL[e.kind]} at ${tc(e.atMs)}`} onBlur={(x) => { if (x.target.value !== e.text) void api.rec.editEvent(e.id, x.target.value).then(load); }} />}</span>
            {e.kind === 'note' && (e.noteId ? <button className="small" onClick={() => onOpenNote?.(e.noteId!)}>Open note</button> : <button className="small" onClick={() => void api.rec.toNote(e.id).then(load)}>Create full Note</button>)}
            <button className="small" aria-label="Remove" onClick={() => void api.rec.removeEvent(e.id).then(load)}>✕</button>
          </div>
        ))}
        {!events.length && <p className="muted small-text">No markers yet. Add one at the current moment with 🔖.</p>}
        <form className="row" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget, x = String(new FormData(f).get('n') ?? '').trim(); if (x) void add('note', x).then(() => f.reset()); }}>
          <input name="n" placeholder={`Note at ${tc(t * 1000)}`} aria-label="Note at the current moment" maxLength={4000} /><button className="small">Add note</button>
        </form>
      </section>
      <section className="card stack">
        <span className="eyebrow">Linked to</span>
        <div className="row wrap">
          <select value={tape.courseId ?? ''} aria-label="Course" onChange={(e) => void api.rec.link(tape.id, { courseId: e.target.value || null }).then(load, (x) => setErr(errText(x)))}><option value="">No course</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          {lectures.length > 0 && <select value={tape.lectureId ?? ''} aria-label="Lecture" onChange={(e) => void api.rec.link(tape.id, { courseId: tape.courseId, lectureId: e.target.value || null }).then(load, (x) => setErr(errText(x)))}><option value="">No lecture</option>{lectures.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}</select>}
        </div>
      </section>
      {tape.refId && clans.length > 0 && <section className="card stack">
        <span className="eyebrow">Share</span>
        <select value="" aria-label="Share into a CLAN" onChange={async (e) => { const k = clans.find((x) => x.id === e.target.value); if (!k) return;
          if (!confirm(`Members of ${k.name} will be able to get this recording${tape.othersConsent ? ' (it includes other people)' : ''}. Share it?`)) return;
          try { await api.rec.share(tape.id, k.id); setShared(`Shared into ${k.name} (a reference — not a copy).`); } catch (x) { setErr(errText(x)); } }}>
          <option value="">Share into a CLAN…</option>{clans.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
        {shared ? <p className="muted small-text" role="status">{shared}</p> : <p className="muted small-text">Private to you until you share it here.</p>}
      </section>}
      <section className="card stack">
        <span className="eyebrow ai">CLAN</span>
        <div className="row wrap">
          <button className="small ai-link" disabled={!events.some((e) => e.text)} onClick={() => ai.open({ mode: 'run', title: `Ask about ${tape.title}`, action: 'ask', scope: tape.courseId ? { kind: 'course', courseId: tape.courseId } : { kind: 'global' }, include: { recordings: true }, ask: true })}>Ask about my timeline notes</button>
          {['Summarize Tape', 'Revision notes', 'Flashcards', 'Quiz', 'Key topics'].map((x) => <button key={x} className="small" disabled title="Needs a transcript of the recording — transcription isn’t available yet">{x}</button>)}
        </div>
        <p className="muted small-text">These need a transcript. CLAN has not transcribed or analysed this recording; only your own timeline notes can be used.</p>
      </section>
    </div>
  );
}


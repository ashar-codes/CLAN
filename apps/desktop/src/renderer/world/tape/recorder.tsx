// Study Tape recorder (App-level, so it keeps recording while you navigate). Recording starts only from an explicit
// action with a chosen source; the "Recording" indicator stays on screen everywhere until it stops. MediaRecorder
// streams 1-second chunks to the main process (written to disk at once — memory does not grow with length).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tape } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { testPatternStream } from '../media/testPattern.ts';
import { errText } from '../useLoad.ts';

export type RecStart = { title?: string; courseId?: string | null; lectureId?: string | null; topicId?: string | null; studySessionId?: string | null; others?: boolean };
type Live = { tape: Tape; t0: number; rec: MediaRecorder; stream: MediaStream; video: HTMLVideoElement; audio: AudioContext | null };
export type Recorder = { active: { tape: Tape; t0: number } | null; open(prefill?: RecStart): void; stop(reason?: string): Promise<Tape | null>; mark(kind: 'important' | 'note' | 'bookmark', text?: string): Promise<void>; screenshot(): Promise<void>; at(): number; last: Tape | null };
const Ctx = createContext<Recorder>({ active: null, open: () => {}, stop: async () => null, mark: async () => {}, screenshot: async () => {}, at: () => 0, last: null });
export const useRecorder = () => useContext(Ctx);
const MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const tc = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

export function RecorderHost({ children }: { children: ReactNode }) {
  const live = useRef<Live | null>(null);
  const [active, setActive] = useState<Recorder['active']>(null);
  const [asking, setAsking] = useState<RecStart | null>(null);
  const [toast, setToast] = useState('');
  const [last, setLast] = useState<Tape | null>(null);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 5000); return () => clearTimeout(t); }, [toast]);
  const at = () => (live.current ? performance.now() - live.current.t0 : 0);
  /** Chunks are written strictly in order; stop waits for the last one. */
  const flush = useRef<Promise<unknown>>(Promise.resolve());

  const stop = async (reason = 'stopped'): Promise<Tape | null> => {
    const l = live.current; if (!l) return null;
    live.current = null; setActive(null);
    const ms = performance.now() - l.t0;
    await new Promise<void>((res) => { l.rec.onstop = () => res(); try { l.rec.state !== 'inactive' ? l.rec.stop() : res(); } catch { res(); } });
    await flush.current; // the last chunk is written before finalizing
    l.stream.getTracks().forEach((t) => t.stop()); void l.audio?.close(); l.video.srcObject = null;
    try { const t = await api.rec.stop(l.tape.id, { durationMs: ms, reason }); setLast(t); setToast(t?.status === 'failed' ? `Nothing was recorded (${t.endReason}).` : `Study Tape saved · ${tc(ms)}`); return t; }
    catch (e) { setToast(errText(e)); return null; }
  };
  useEffect(() => api.rec.onProblem((p) => { setToast(p.message); if (p.kind !== 'disk_low' && live.current?.tape.id === p.tapeId) void stop(p.kind === 'write_failed' ? 'disk write failed' : 'disk almost full'); }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (o: RecStart & { title: string; source: string; mic: boolean; systemAudio: boolean; others: boolean }) => {
    const mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
    const test = o.source.startsWith('test');
    const tape = await api.rec.start({ title: o.title, source: test ? 'test' : o.source.startsWith('window:') ? 'window' : 'screen', mic: o.mic, systemAudio: o.systemAudio, othersConsent: o.others, mime,
      courseId: o.courseId ?? null, lectureId: o.lectureId ?? null, topicId: o.topicId ?? null, studySessionId: o.studySessionId ?? null });
    let stream: MediaStream;
    const ownedTracks: MediaStreamTrack[] = [];
    let ctx: AudioContext | null = null;
    try {
      const size = test && (window as unknown as { __clanRecSize?: { w: number; h: number } }).__clanRecSize;
      const display = test ? testPatternStream('screen', size || { w: 1280, h: 720 }, size ? 30 : 15)
        : (await api.mediaChoose(o.source, o.systemAudio), await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: o.systemAudio }));
      ownedTracks.push(...display.getTracks());
      const mic = o.mic ? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }) : null;
      ownedTracks.push(...(mic?.getTracks() ?? []));
      const audios = [...display.getAudioTracks(), ...(mic?.getAudioTracks() ?? [])];
      const tracks = [...display.getVideoTracks()];
      if (audios.length === 1) tracks.push(audios[0]!);
      else if (audios.length > 1) { ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination(); for (const a of audios) ctx.createMediaStreamSource(new MediaStream([a])).connect(dest); tracks.push(dest.stream.getAudioTracks()[0]!); }
      stream = new MediaStream(tracks);
      ownedTracks.push(...stream.getTracks());
      const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true }); video.srcObject = new MediaStream(display.getVideoTracks()); void video.play();
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: (display.getVideoTracks()[0]?.getSettings().height ?? 720) > 800 ? 4_000_000 : 2_500_000, audioBitsPerSecond: 96_000 });
      rec.ondataavailable = (e) => { if (!e.data.size) return; flush.current = flush.current.then(async () => { const err = await api.rec.chunk(tape.id, new Uint8Array(await e.data.arrayBuffer())); if (err && live.current) void stop(err); }); };
      rec.onerror = () => { setToast('The recording failed; what was captured is kept.'); void stop('capture error'); };
      display.getVideoTracks()[0]?.addEventListener('ended', () => { setToast('The recorded window or screen closed. The recording was saved.'); void stop('source closed'); });
      live.current = { tape, t0: performance.now(), rec, stream: new MediaStream(ownedTracks), video, audio: ctx };
      rec.start(1000);
      setActive({ tape, t0: live.current.t0 }); setAsking(null);
    } catch (e) {
      ownedTracks.forEach((t) => t.stop()); void ctx?.close();
      await api.rec.stop(tape.id, { durationMs: 0, reason: `capture failed: ${errText(e)}`.slice(0, 120) }).catch(() => {});
      throw e;
    }
  };
  const mark = async (kind: 'important' | 'note' | 'bookmark', text?: string) => { const l = live.current; if (!l) return; await api.rec.mark(l.tape.id, { kind, atMs: at(), text }); setToast(`${kind === 'important' ? '⭐ Important' : kind === 'note' ? '📝 Note' : '🔖 Bookmark'} at ${tc(at())}`); };
  const screenshot = async () => {
    const l = live.current; if (!l) return;
    const v = l.video, c = Object.assign(document.createElement('canvas'), { width: v.videoWidth || 1280, height: v.videoHeight || 720 });
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (!blob) return;
    await api.rec.screenshot(l.tape.id, at(), new Uint8Array(await blob.arrayBuffer()));
    setToast(`📸 Captured at ${tc(at())}`);
  };
  const value: Recorder = { active, open: (p) => setAsking(p ?? {}), stop, mark, screenshot, at, last };
  return (
    <Ctx.Provider value={value}>
      {children}
      {active && <RecIndicator />}
      {asking && <StartDialog prefill={asking} onClose={() => setAsking(null)} onStart={start} />}
      {toast && <div className="toast rec-toast" role="status">{toast}</div>}
    </Ctx.Provider>
  );
}

/** Always visible while recording, on every screen. */
function RecIndicator() {
  const r = useRecorder();
  const [note, setNote] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []); // only the indicator re-renders
  if (!r.active) return null;
  return (
    <div className="rec-indicator" role="status" aria-live="polite" data-testid="rec-indicator">
      <span className="rec-dot" aria-hidden /> <b>Recording</b> <span className="c-num" data-testid="rec-clock">{tc(r.at())}</span>
      <button className="small" onClick={() => void r.mark('important')} aria-label="Mark important">⭐</button>
      <button className="small" onClick={() => setNote('')} aria-label="Add note">📝</button>
      <button className="small" onClick={() => void r.screenshot()} aria-label="Capture screenshot">📸</button>
      <button className="small" onClick={() => void r.mark('bookmark', 'Bookmark')} aria-label="Bookmark">🔖</button>
      <button className="small danger" onClick={() => void r.stop()}>Stop</button>
      {note !== null && <form className="row" onSubmit={(e) => { e.preventDefault(); void r.mark('note', note); setNote(null); }}>
        <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Note at ${tc(r.at())}`} aria-label="Timeline note" maxLength={4000} />
        <button className="small primary">Add</button></form>}
    </div>
  );
}

function StartDialog({ prefill, onClose, onStart }: { prefill: RecStart; onClose(): void; onStart(o: RecStart & { title: string; source: string; mic: boolean; systemAudio: boolean; others: boolean }): Promise<void> }) {
  const [perm, setPerm] = useState<{ testCapture: boolean; platform: string; screen: string } | null>(null);
  const [sources, setSources] = useState<{ id: string; kind: 'screen' | 'window'; name: string; thumbnail: string }[] | null>(null);
  const [check, setCheck] = useState<Awaited<ReturnType<typeof api.rec.check>> | null>(null);
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);
  const [o, setO] = useState({ title: prefill.title ?? `Study Tape ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`, source: '', mic: false, systemAudio: false, others: !!prefill.others, policy: false, courseId: prefill.courseId ?? '', lectureId: prefill.lectureId ?? '' });
  const [lectures, setLectures] = useState<{ id: string; title: string }[]>([]);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void api.mediaPermission().then(async (p) => { setPerm(p); if (!p.testCapture && !(p.platform === 'darwin' && p.screen === 'denied')) setSources(await api.mediaSources().catch(() => [])); else setSources([]); }); void api.rec.check().then(setCheck); void api.study.courses().then((c) => setCourses(c.map((x) => ({ id: x.id, name: x.name })))); }, []);
  useEffect(() => { if (o.courseId) void api.study.course(o.courseId).then((d) => setLectures(d.lectures.map((l) => ({ id: l.id, title: l.title })))); else setLectures([]); }, [o.courseId]);
  const list = [...(perm?.testCapture ? [{ id: 'test-screen', kind: 'screen' as const, name: 'Test pattern', thumbnail: '' }] : []), ...(sources ?? [])];
  const low = check && check.freeBytes < check.low;
  const ok = o.source && o.title.trim() && (!o.others || o.policy) && !(check && check.freeBytes < check.critical);
  return (
    <div className="picker-backdrop" role="presentation" onClick={onClose}>
      <form className="picker card" role="dialog" aria-modal="true" aria-label="Record a Study Tape" onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => { e.preventDefault(); setErr(''); setBusy(true); try { await onStart({ ...prefill, ...o, courseId: o.courseId || null, lectureId: o.lectureId || null }); } catch (x) { setErr(errText(x)); } finally { setBusy(false); } }}>
        <div className="row between"><h3>Record a Study Tape</h3><button type="button" className="small" onClick={onClose}>Cancel</button></div>
        <input value={o.title} onChange={(e) => setO({ ...o, title: e.target.value })} aria-label="Tape title" maxLength={160} />
        {perm?.platform === 'darwin' && perm.screen === 'denied' && !perm.testCapture ? <p className="error">CLAN needs Screen Recording permission (System Settings › Privacy &amp; Security).</p> : (
          <div className="source-grid" role="listbox" aria-label="What to record">
            {list.map((s) => <button type="button" key={s.id} role="option" aria-selected={o.source === s.id} className={`source ${o.source === s.id ? 'on' : ''}`} onClick={() => setO({ ...o, source: s.id })}>
              {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="source-blank" aria-hidden>▭</span>}<span>{s.name}</span></button>)}
            {sources && !list.length && <p className="muted">No screens or windows available.</p>}
          </div>
        )}
        <label className="check"><input type="checkbox" checked={o.mic} onChange={(e) => setO({ ...o, mic: e.target.checked })} /> Microphone</label>
        {check?.systemAudio ? <label className="check"><input type="checkbox" checked={o.systemAudio} onChange={(e) => setO({ ...o, systemAudio: e.target.checked })} /> System sound</label> : <span className="muted small-text">System sound can’t be recorded on this system (picture and microphone can).</span>}
        <label className="check"><input type="checkbox" checked={o.others} onChange={(e) => setO({ ...o, others: e.target.checked, policy: false })} /> This captures other people (a lecture, a CLAN room, someone’s presentation or voice)</label>
        {o.others && <div className="consent card" role="alert">
          <b>Recording other people</b>
          <p className="small-text">CLAN can’t know your university’s or the law’s rules. Make sure the people you record agree, or that your institution’s recording policy allows it. The tape stays private to you unless you share it.</p>
          <label className="check"><input type="checkbox" checked={o.policy} onChange={(e) => setO({ ...o, policy: e.target.checked })} /> I have permission to record them</label>
        </div>}
        <div className="row wrap">
          <select value={o.courseId} onChange={(e) => setO({ ...o, courseId: e.target.value, lectureId: '' })} aria-label="Course"><option value="">No course</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          {lectures.length > 0 && <select value={o.lectureId} onChange={(e) => setO({ ...o, lectureId: e.target.value })} aria-label="Lecture"><option value="">No lecture</option>{lectures.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}</select>}
        </div>
        {low && <p className="error small-text">Disk space is low ({(check!.freeBytes / 1024 ** 3).toFixed(1)} GB). {check!.freeBytes < check!.critical ? 'Free some space to record.' : 'Long recordings may stop early.'}</p>}
        <p className="muted small-text">Recorded on this computer only. Nothing is uploaded; no transcript is made.</p>
        {err && <p className="error small-text" role="alert">{err}</p>}
        <button className="primary" disabled={!ok || busy}>Start recording</button>
      </form>
    </div>
  );
}

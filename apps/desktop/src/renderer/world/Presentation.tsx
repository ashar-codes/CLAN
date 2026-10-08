// Screen sharing in the CLAN room. The wall is the media surface (RoomSurface); presentation control state comes from
// the host; media goes through MediaTransport (lazy-loaded LiveKit implementation).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MediaDiagnostics, MediaQuality, MediaTransport, ScreenProfile, ScreenView } from '@classroom/client';
import type { ClientMessage, PresentationView, ServerMessage } from '@classroom/protocol';
import { api } from '../App.tsx';

export type PresentationMsg = Extract<ServerMessage, { t: 'presentation' }>;
type Perm = { platform: string; screen: string; audio: boolean; testCapture: boolean };
type Src = { id: string; kind: 'screen' | 'window'; name: string; thumbnail: string };

const loadTransport = () => import('./media/livekit.ts').then((m) => m.createTransport());

/** Presentation state machine for one CLAN connection. `me` = 'host' or the member id. */
export function usePresentation(o: { baseUrl: string; bearer: string; sessionId: string; msg: PresentationMsg | null; send(m: ClientMessage): void; me: string }) {
  const live = o.msg?.state ?? null;
  const [view, setView] = useState<ScreenView | null>(null);
  const [mediaState, setMediaState] = useState<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'>('idle');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const transport = useRef<MediaTransport | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const pending = useRef<{ profile: ScreenProfile } | null>(null);
  const presenting = !!live && live.presenter === o.me;

  const token = useCallback(() => api.mediaToken({ url: o.baseUrl, token: o.bearer, sessionId: o.sessionId }), [o.baseUrl, o.bearer, o.sessionId]);

  const ensureConnected = useCallback(async (fresh = false) => {
    if (transport.current && !fresh) return transport.current;
    await transport.current?.disconnect().catch(() => {});
    setMediaState('connecting');
    const t = await loadTransport();
    t.onScreen((v) => setView(v));
    t.onState((s) => setMediaState(s === 'connected' ? 'connected' : s === 'reconnecting' ? 'reconnecting' : 'idle'));
    await t.connect({ url: `${o.baseUrl.replace(/^https/, 'wss')}/media`, token: (await token()).token });
    transport.current = t;
    setMediaState('connected');
    return t;
  }, [o.baseUrl, token]);

  const stopLocal = useCallback(async () => {
    stream.current?.getTracks().forEach((t) => t.stop()); // no zombie capture indicator
    stream.current = null;
    await transport.current?.unpublishScreen().catch(() => {});
  }, []);

  // Viewers join while something is live; leave when nothing is (no idle media connection).
  useEffect(() => {
    if (live && !transport.current) void ensureConnected().catch((e) => { setMediaState('failed'); setNotice((e as Error).message); });
    if (!live && transport.current && !stream.current) { void transport.current.disconnect(); transport.current = null; setView(null); setMediaState('idle'); }
  }, [live?.id, ensureConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server says I'm the presenter → publish what I captured (permission was granted on the SFU by the host).
  useEffect(() => {
    if (presenting && pending.current && stream.current) {
      const { profile } = pending.current; pending.current = null;
      void (async () => {
        try { const t = await ensureConnected(); await t.publishScreen(stream.current!, profile); }
        catch { try { const t = await ensureConnected(true); await t.publishScreen(stream.current!, profile); } catch (e) { setNotice(`Couldn’t start sharing: ${(e as Error).message}`); o.send({ t: 'present.stop' }); await stopLocal(); } }
      })();
    }
    if (!presenting && stream.current && !pending.current) { void stopLocal(); } // stopped by host, removed, or session ended
  }, [presenting]); // eslint-disable-line react-hooks/exhaustive-deps

  // A dropped media connection while something is live: try again with a fresh credential.
  useEffect(() => {
    if (mediaState !== 'idle' || !live || !transport.current) return;
    const t = setTimeout(() => { void ensureConnected(true).catch(() => setMediaState('failed')); }, 1500);
    return () => clearTimeout(t);
  }, [mediaState, live?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { stream.current?.getTracks().forEach((t) => t.stop()); void transport.current?.disconnect(); }, []);

  const capture = async (src: Src | 'test-screen' | 'test-window', audio: boolean): Promise<MediaStream> => {
    if (typeof src === 'string') return (await import('./media/testPattern.ts')).testPatternStream(src === 'test-screen' ? 'screen' : 'window');
    await api.mediaChoose(src.id, audio);
    return navigator.mediaDevices.getDisplayMedia({ video: true, audio });
  };
  const watchEnd = (s: MediaStream) => s.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (stream.current !== s) return;
    setNotice('The shared screen or window closed, so the presentation stopped.');
    o.send({ t: 'present.stop' }); void stopLocal();
  });

  return {
    live, presenting, view, mediaState, notice, setNotice, busy,
    /** Capture first (the user picked a source), then ask the host; publishing follows the server's decision. */
    async start(src: Src | 'test-screen' | 'test-window', audio: boolean, profile: ScreenProfile, takeover = false) {
      setNotice(''); setBusy(null);
      let s: MediaStream;
      try { s = await capture(src, audio); } catch { setNotice('Screen capture was not allowed.'); return; }
      stream.current = s; pending.current = { profile }; watchEnd(s);
      o.send({ t: 'present.start', source: typeof src === 'string' ? (src === 'test-screen' ? 'screen' : 'window') : src.kind, audio: s.getAudioTracks().length > 0, takeover });
    },
    async switchTo(src: Src | 'test-screen' | 'test-window', audio: boolean) {
      let s: MediaStream;
      try { s = await capture(src, audio); } catch { setNotice('Screen capture was not allowed.'); return; }
      const old = stream.current; stream.current = s; watchEnd(s);
      await transport.current?.replaceScreen(s);
      old?.getTracks().forEach((t) => t.stop());
      o.send({ t: 'present.source', source: typeof src === 'string' ? (src === 'test-screen' ? 'screen' : 'window') : src.kind, audio: s.getAudioTracks().length > 0 });
    },
    async stop() { o.send({ t: 'present.stop' }); await stopLocal(); },
    /** Server refused (busy/forbidden): drop the capture we made. */
    async refused(message: string) { if (pending.current) { pending.current = null; await stopLocal(); } if (/currently presenting/.test(message)) setBusy(message); else setNotice(message); },
    quality: (): MediaQuality => transport.current?.quality() ?? 'unknown',
    diagnostics: (): Promise<MediaDiagnostics | null> => transport.current?.diagnostics() ?? Promise.resolve(null),
  };
}
export type Presentation = ReturnType<typeof usePresentation>;

/** The room wall. Modes are modular so a whiteboard or a document can take the wall later. */
export type SurfaceMode = 'DEFAULT' | 'SCREEN_SHARE' | 'WHITEBOARD' | 'DOCUMENT_PRESENTATION';
export function RoomSurface({ mode, children, screen }: { mode: SurfaceMode; children: ReactNode; screen?: { pres: Presentation; live: PresentationView } }) {
  if (mode !== 'SCREEN_SHARE' || !screen) return <div className="surface">{children}</div>;
  return <ScreenWall pres={screen.pres} live={screen.live} />;
}

function ScreenWall({ pres, live }: { pres: Presentation; live: PresentationView }) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<'fit' | 'actual'>('fit');
  const [muted, setMuted] = useState(true);
  const [left, setLeft] = useState(false);
  const [q, setQ] = useState<MediaQuality>('unknown');
  const [diag, setDiag] = useState<MediaDiagnostics | null>(null);
  const v = pres.view;
  useEffect(() => { const el = video.current; if (!el || !v || left) return; v.attach(el); return () => v.detach(el); }, [v, left]);
  useEffect(() => { const t = setInterval(() => setQ(pres.quality()), 2000); return () => clearInterval(t); }, [pres]);
  const who = pres.presenting ? 'You are' : `${live.presenterName} is`;
  const label = `${who} presenting ${pres.presenting ? 'your' : 'their'} ${live.source === 'window' ? 'window' : 'screen'}`;
  const full = () => { const el = box.current; if (!el) return; if (document.fullscreenElement) void document.exitFullscreen(); else void el.requestFullscreen(); };
  return (
    <div className="screen-wall" ref={box} data-testid="screen-wall" onDoubleClick={full}>
      <p className="sr-live" aria-live="polite" data-testid="wall-state">{live.state === 'reconnecting' || pres.mediaState === 'reconnecting' ? 'Reconnecting presentation…' : label}</p>
      {left ? <div className="wall-msg"><b>{label}</b><button className="small" onClick={() => setLeft(false)}>Watch again</button></div>
        : pres.presenting ? <div className="wall-msg"><b>You are presenting</b><span>Everyone in the room sees your {live.source === 'window' ? 'window' : 'screen'} here.</span></div>
        : v ? <video ref={video} className={`screen-video ${fit}`} autoPlay playsInline muted={muted} data-testid="screen-video" aria-label={label} />
        : <div className="wall-msg"><b>{live.state === 'reconnecting' || pres.mediaState !== 'connected' ? 'Reconnecting presentation…' : `Waiting for ${live.presenterName}’s screen…`}</b></div>}
      {!pres.presenting && !left && v && (
        <div className="wall-controls" role="toolbar" aria-label="Presentation view">
          <span className={`q q-${q}`} title="Connection">{q === 'good' ? 'Good' : q === 'fair' ? 'Fair' : q === 'poor' ? 'Poor' : '…'}</span>
          <button className="small" onClick={() => setFit(fit === 'fit' ? 'actual' : 'fit')} aria-pressed={fit === 'actual'}>{fit === 'fit' ? 'Actual size' : 'Fit'}</button>
          {v.hasAudio && <button className="small" onClick={() => setMuted(!muted)} aria-pressed={!muted}>{muted ? 'Unmute' : 'Mute'}</button>}
          <button className="small" onClick={full}>Fullscreen</button>
          <button className="small" onClick={() => setLeft(true)}>Leave view</button>
        </div>
      )}
      <details className="wall-diag" onToggle={async (e) => { if ((e.target as HTMLDetailsElement).open) setDiag(await pres.diagnostics()); }}>
        <summary>Diagnostics</summary>
        {diag ? <dl className="kv"><dt>Transport</dt><dd>{diag.transport}</dd><dt>Codec</dt><dd>{diag.codec ?? '—'}</dd><dt>Resolution</dt><dd>{diag.width ? `${diag.width}×${diag.height}` : '—'}</dd><dt>FPS</dt><dd>{diag.fps ?? '—'}</dd>
          <dt>Bitrate</dt><dd>{diag.bitrateKbps != null ? `${diag.bitrateKbps} kb/s` : '—'}</dd><dt>Packets lost</dt><dd>{diag.packetsLost ?? '—'}</dd><dt>RTT</dt><dd>{diag.rttMs != null ? `${diag.rttMs} ms` : '—'}</dd><dt>Layer</dt><dd>{diag.layer ?? '—'}</dd><dt>Media</dt><dd>{pres.mediaState}</dd></dl> : <p className="muted small-text">No media connection.</p>}
      </details>
    </div>
  );
}

/** Source picker: explicit choice, previews, audio only where the OS supports it, quality profile. */
export function SourcePicker({ onPick, onClose, title = 'Present' }: { onPick(src: Src | 'test-screen' | 'test-window', audio: boolean, profile: ScreenProfile): void; onClose(): void; title?: string }) {
  const [perm, setPerm] = useState<Perm | null>(null);
  const [sources, setSources] = useState<Src[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [audio, setAudio] = useState(false);
  const [profile, setProfile] = useState<ScreenProfile>('auto');
  const [err, setErr] = useState('');
  useEffect(() => { void api.mediaPermission().then(async (p) => { setPerm(p); if (p.testCapture) return setSources([]); if (p.platform === 'darwin' && p.screen === 'denied') return; try { setSources(await api.mediaSources()); } catch (e) { setErr((e as Error).message); } }); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  const tests = perm?.testCapture ? [{ id: 'test-screen', kind: 'screen' as const, name: 'Test pattern (screen)', thumbnail: '' }, { id: 'test-window', kind: 'window' as const, name: 'Test pattern (window)', thumbnail: '' }] : [];
  const all = [...tests, ...(sources ?? [])];
  const chosen = all.find((s) => s.id === sel);
  return (
    <div className="picker-backdrop" role="presentation" onClick={onClose}>
      <div className="picker card" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h3>{title}</h3><button className="small" onClick={onClose}>Cancel</button></div>
        {perm?.platform === 'darwin' && perm.screen === 'denied' && !perm.testCapture ? (
          <div className="perm-help" role="alert"><b>CLAN needs permission to record your screen.</b>
            <ol><li>Open <b>System Settings › Privacy &amp; Security › Screen &amp; System Audio Recording</b>.</li><li>Turn on <b>CLAN</b>.</li><li>Quit and reopen CLAN, then press Present again.</li></ol></div>
        ) : !sources ? <p className="muted">Looking for screens and windows…</p> : (
          <>
            {(['screen', 'window'] as const).map((k) => {
              const list = all.filter((s) => s.kind === k);
              return list.length ? <section key={k}><span className="eyebrow">{k === 'screen' ? 'Entire screen' : 'Window'}</span>
                <div className="source-grid" role="listbox" aria-label={k === 'screen' ? 'Screens' : 'Windows'}>
                  {list.map((s) => <button key={s.id} role="option" aria-selected={sel === s.id} className={`source ${sel === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>
                    {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <span className="source-blank" aria-hidden>{k === 'screen' ? '▭' : '▢'}</span>}<span>{s.name}</span></button>)}
                </div></section> : null;
            })}
            {all.length === 0 && <p className="muted">No screens or windows are available to share.</p>}
          </>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row">
          {perm?.audio ? <label className="check"><input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /> Share audio</label> : <span className="muted small-text">Sharing sound isn’t available on this system — the picture is.</span>}
          <label className="inline">Quality <select value={profile} onChange={(e) => setProfile(e.target.value as ScreenProfile)}><option value="auto">Auto</option><option value="text">Text &amp; slides (sharpest)</option><option value="motion">Motion (smoother)</option></select></label>
        </div>
        {chosen && <p className="muted small-text">You’ll share: <b>{chosen.kind === 'screen' ? 'an entire screen' : 'one window'}</b> — {chosen.name}. Nothing else is shared, and nothing is recorded.</p>}
        <button className="primary" disabled={!chosen} onClick={() => chosen && onPick(chosen.id.startsWith('test-') ? (chosen.id as 'test-screen') : (chosen as Src), audio, profile)}>Share {chosen?.kind === 'window' ? 'this window' : 'this screen'}</button>
      </div>
    </div>
  );
}

/** Persistent presenter strip: never unsure whether you're transmitting. */
export function PresenterBar({ pres, onSwitch }: { pres: Presentation; onSwitch(): void }) {
  if (!pres.presenting || !pres.live) return null;
  return (
    <div className="presenter-bar" role="status" data-testid="presenter-bar">
      <span className="rec-dot" aria-hidden /> <b>You are presenting</b> <span className="muted">{pres.live.source === 'window' ? 'a window' : 'your screen'}{pres.live.audio ? ' · with sound' : ''}</span>
      <button className="small" onClick={onSwitch}>Switch source</button>
      <button className="small danger" onClick={() => void pres.stop()}>Stop</button>
    </div>
  );
}

// Screen sharing in the CLAN room. The wall is the media surface (RoomSurface); presentation control state comes from
// the host; media goes through MediaTransport (lazy-loaded LiveKit implementation).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MediaDiagnostics, MediaQuality, MediaTransport, ScreenProfile, ScreenView } from '@classroom/client';
import type { ClientMessage, PresentationView, ServerMessage } from '@classroom/protocol';
import { classifyCapture, type CaptureFailure } from './media/captureError.ts';
import { api } from '../App.tsx';
import { FloatPanel, NoteEditor, ToolsFab, type ToolItem } from './PresentationTools.tsx';

export type PresentationMsg = Extract<ServerMessage, { t: 'presentation' }>;
type Perm = { platform: string; screen: string; audio: boolean; testCapture: boolean };
type Src = { id: string; kind: 'screen' | 'window'; name: string; thumbnail: string };

const loadTransport = () => import('./media/livekit.ts').then((m) => m.createTransport());

export async function explainCapture(e: unknown, stage: 'capture' | 'publish' = 'capture'): Promise<CaptureFailure> {
  return classifyCapture(e, await api.mediaDiagnostics().catch(() => null), stage);
}
/** Plain-text report for support: error, platform and capture stages. No source names, thumbnails or frames. */
export type { CaptureFailure };
export const captureReport = (x: CaptureFailure) => ['CLAN screen-capture diagnostics', `result: ${x.kind}`, `error: ${x.detail}`,
  ...Object.entries(x.diag ?? {}).map(([k, v]) => `${k}: ${k === 'at' && typeof v === 'number' ? new Date(v).toISOString() : String(v)}`)].join('\n');

/** Presentation state machine for one CLAN connection. `me` = 'host' or the member id. */
export function usePresentation(o: { baseUrl: string; bearer: string; sessionId: string; msg: PresentationMsg | null; send(m: ClientMessage): void; me: string }) {
  const live = o.msg?.state ?? null;
  const [view, setView] = useState<ScreenView | null>(null);
  const [mediaState, setMediaState] = useState<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'>('idle');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState<CaptureFailure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const transport = useRef<MediaTransport | null>(null);
  const connecting = useRef<Promise<MediaTransport> | null>(null);
  const mounted = useRef(true);
  const stream = useRef<MediaStream | null>(null);
  const pending = useRef<{ profile: ScreenProfile } | null>(null);
  const presenting = !!live && live.presenter === o.me;

  const token = useCallback(() => api.mediaToken({ url: o.baseUrl, token: o.bearer, sessionId: o.sessionId }), [o.baseUrl, o.bearer, o.sessionId]);

  const ensureConnected = useCallback(function connect(fresh = false): Promise<MediaTransport> {
    // The viewer effect and presenter effect can run in the same render. Two SFU
    // connections with one participant identity evict each other and freeze the track.
    if (connecting.current) return fresh ? connecting.current.then(() => connect(true)) : connecting.current;
    if (transport.current && !fresh) return Promise.resolve(transport.current);
    const round = (async () => {
      await transport.current?.disconnect().catch(() => {});
      setMediaState('connecting');
      const t = await loadTransport();
      t.onScreen((v) => setView(v));
      t.onState((s) => setMediaState(s === 'connected' ? 'connected' : s === 'reconnecting' ? 'reconnecting' : 'idle'));
      try {
        await t.connect({ url: `${o.baseUrl.replace(/^https/, 'wss')}/media`, token: (await token()).token });
        if (!mounted.current) throw new Error('Presentation closed.');
        transport.current = t;
        setMediaState('connected');
        return t;
      } catch (e) { await t.disconnect().catch(() => {}); throw e; }
    })();
    const pending = round.finally(() => { if (connecting.current === pending) connecting.current = null; });
    connecting.current = pending;
    return pending;
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
        catch { try { const t = await ensureConnected(true); await t.publishScreen(stream.current!, profile); } catch (e) { setFailure(await explainCapture(e, 'publish')); o.send({ t: 'present.stop' }); await stopLocal(); } }
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

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stream.current?.getTracks().forEach((t) => t.stop()); void transport.current?.disconnect(); }; }, []);

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
    live, presenting, view, mediaState, notice, setNotice, busy, failure, clearFailure: () => setFailure(null),
    /** Capture first (the user picked a source), then ask the host; publishing follows the server's decision. */
    async start(src: Src | 'test-screen' | 'test-window', audio: boolean, profile: ScreenProfile, takeover = false) {
      setNotice(''); setBusy(null); setFailure(null);
      let s: MediaStream;
      try { s = await capture(src, audio); } catch (e) { setFailure(await explainCapture(e)); return; }
      stream.current = s; pending.current = { profile }; watchEnd(s);
      o.send({ t: 'present.start', source: typeof src === 'string' ? (src === 'test-screen' ? 'screen' : 'window') : src.kind, audio: s.getAudioTracks().length > 0, takeover });
    },
    async switchTo(src: Src | 'test-screen' | 'test-window', audio: boolean) {
      let s: MediaStream; setFailure(null);
      try { s = await capture(src, audio); } catch (e) { setFailure(await explainCapture(e)); return; } // the current share keeps running
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
type Person = { name: string; host?: boolean; connected?: boolean; you?: boolean };
/** One owner of the wall at a time: the default content, a presentation, or the whiteboard. */
export function RoomSurface({ mode, children, screen, board, people }: { mode: SurfaceMode; children: ReactNode; screen?: { pres: Presentation; live: PresentationView }; board?: ReactNode; people?: Person[] }) {
  if (mode === 'WHITEBOARD' && board) return <div className="surface board-surface" data-testid="wall-board">{board}</div>;
  if (mode !== 'SCREEN_SHARE' || !screen) return <div className="surface">{children}</div>;
  return <ScreenWall pres={screen.pres} live={screen.live} people={people} />;
}

type Zoom = 'fit' | 1 | 2;
/** Viewer of a shared screen. Immersive = the whole window (and display) shows the screen; the + menu opens CLAN tools
 *  over it while the stream keeps playing. */
function ScreenWall({ pres, live, people }: { pres: Presentation; live: PresentationView; people?: Person[] }) {
  const video = useRef<HTMLVideoElement>(null);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [muted, setMuted] = useState(true);
  const [left, setLeft] = useState(false);
  const [q, setQ] = useState<MediaQuality>('unknown');
  const [diag, setDiag] = useState<MediaDiagnostics | null>(null);
  const [immersive, setImmersive] = useState(false);
  const [panel, setPanel] = useState<null | 'notes' | 'people' | 'controls'>(null);
  const [notes, setNotes] = useState(false); // the editor survives switching panels so a draft is never dropped
  const [chat, setChat] = useState(false);
  const [idle, setIdle] = useState(false);
  const [toast, setToast] = useState('');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const v = pres.view;
  useEffect(() => { const el = video.current; if (!el || !v || left) return; v.attach(el); return () => v.detach(el); }, [v, left]);
  useEffect(() => { const t = setInterval(() => setQ(pres.quality()), 2000); return () => clearInterval(t); }, [pres]);
  const who = pres.presenting ? 'You are' : `${live.presenterName} is`;
  const label = `${who} presenting ${pres.presenting ? 'your' : 'their'} ${live.source === 'window' ? 'window' : 'screen'}`;
  const exit = useCallback(() => { setImmersive(false); setChat(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); }, []);
  const enter = () => { setImmersive(true); setLeft(false); void document.documentElement.requestFullscreen?.().catch(() => {}); }; // the window fills its current display
  const toggle = () => (immersive ? exit() : enter());
  // Esc (handled by the browser in fullscreen) or leaving fullscreen any other way ends immersive view.
  useEffect(() => { const f = () => { if (!document.fullscreenElement) { setImmersive(false); setChat(false); } }; document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);
  useEffect(() => { if (!immersive) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) exit(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [immersive, exit]);
  useEffect(() => { document.body.toggleAttribute('data-immersive', immersive); document.body.toggleAttribute('data-immersive-chat', immersive && chat); }, [immersive, chat]);
  useEffect(() => () => { document.body.removeAttribute('data-immersive'); document.body.removeAttribute('data-immersive-chat'); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); }, []); // presentation ended
  useEffect(() => { if (!immersive) return; let t = setTimeout(() => setIdle(true), 2500); const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2500); }; addEventListener('pointermove', wake); addEventListener('keydown', wake); return () => { clearTimeout(t); removeEventListener('pointermove', wake); removeEventListener('keydown', wake); }; }, [immersive]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [toast]);
  const hasChat = () => !!document.querySelector('[data-testid="chat"]');
  const items: ToolItem[] = [
    { id: 'notes', label: 'Take Notes', icon: '✎', run: () => { setNotes(true); setPanel('notes'); } },
    { id: 'capture', label: 'Quick Capture', icon: '+', run: () => dispatchEvent(new CustomEvent('clan:quick-capture')) },
    ...(hasChat() ? [{ id: 'chat', label: chat ? 'Hide Chat' : 'Chat', icon: '💬', run: () => setChat(!chat) }] : []),
    ...(people?.length ? [{ id: 'people', label: 'Participants', icon: '👥', run: () => setPanel('people') }] : []),
    { id: 'controls', label: 'Presentation Controls', icon: '⚙', run: () => setPanel('controls') },
  ];
  const zoomLabel = (z: Zoom) => (z === 'fit' ? 'Fit to screen' : z === 1 ? 'Actual size' : '200%');
  const dpr = devicePixelRatio || 1;
  const videoStyle = zoom === 'fit' || !size ? undefined : { width: (size.w / dpr) * zoom, height: (size.h / dpr) * zoom, maxWidth: 'none', maxHeight: 'none' };
  const controls = (
    <>
      <span className={`q q-${q}`} title="Connection">{q === 'good' ? 'Good' : q === 'fair' ? 'Fair' : q === 'poor' ? 'Poor' : '…'}</span>
      <button className="small" onClick={() => setZoom(zoom === 'fit' ? 1 : zoom === 1 ? 2 : 'fit')} aria-label={`Zoom: ${zoomLabel(zoom)}`}>{zoomLabel(zoom === 'fit' ? 1 : zoom === 1 ? 2 : 'fit')}</button>
      {v?.hasAudio && <button className="small" onClick={() => setMuted(!muted)} aria-pressed={!muted}>{muted ? 'Unmute' : 'Mute'}</button>}
      <button className="small" onClick={toggle}>{immersive ? 'Exit fullscreen' : 'Fullscreen'}</button>
      <button className="small" onClick={() => { exit(); setLeft(true); }}>Leave view</button>
    </>
  );
  return (
    <div className={`screen-wall ${immersive ? 'immersive' : ''}`} data-testid="screen-wall" onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('.pt-panel, .pt-fab-wrap, .wall-controls')) toggle(); }}>
      <p className="sr-live" aria-live="polite" data-testid="wall-state">{live.state === 'reconnecting' || pres.mediaState === 'reconnecting' ? 'Reconnecting presentation…' : label}</p>
      {left ? <div className="wall-msg"><b>{label}</b><button className="small" onClick={() => setLeft(false)}>Watch again</button></div>
        : pres.presenting ? <div className="wall-msg"><b>You are presenting</b><span>Everyone in the room sees your {live.source === 'window' ? 'window' : 'screen'} here.</span></div>
        : v ? <div className={`screen-scroll ${zoom === 'fit' ? '' : 'zoomed'}`}><video ref={video} className={`screen-video ${zoom === 'fit' ? 'fit' : 'actual'}`} style={videoStyle} autoPlay playsInline muted={muted} data-testid="screen-video" aria-label={label}
            onResize={(e) => setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })} onLoadedMetadata={(e) => setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })} /></div>
        : <div className="wall-msg"><b>{live.state === 'reconnecting' || pres.mediaState !== 'connected' ? 'Reconnecting presentation…' : `Waiting for ${live.presenterName}’s screen…`}</b></div>}
      {!pres.presenting && !left && v && !immersive && <div className="wall-controls" role="toolbar" aria-label="Presentation view">{controls}</div>}
      {immersive && <ToolsFab items={items} idle={idle} />}
      {notes && <div hidden={panel !== 'notes'}><NoteEditor context={`${live.presenterName}’s presentation`} onClose={() => { setNotes(false); setPanel(null); }} onSaved={setToast} /></div>}
      {immersive && panel === 'people' && people && <FloatPanel title="Participants" onClose={() => setPanel(null)} testid="presentation-people">
        <ul className="pt-people">{people.map((p, i) => <li key={i}><span className={`dot ${p.connected !== false ? 'on' : ''}`} aria-hidden />{p.name}{p.you && <small className="muted"> · you</small>}{p.host && <small className="muted"> · host</small>}{p.name === live.presenterName && <small className="muted"> · presenting</small>}</li>)}</ul></FloatPanel>}
      {immersive && panel === 'controls' && <FloatPanel title="Presentation" onClose={() => setPanel(null)} testid="presentation-controls">
        <p className="small-text">{label}{live.audio ? ' · with sound' : ''} · media {pres.mediaState}</p>
        {v && <div className="row wrap">{controls}</div>}
      </FloatPanel>}
      {immersive && toast && <div className="toast" role="status">{toast}</div>}
      {!immersive && <details className="wall-diag" onToggle={async (e) => { if ((e.target as HTMLDetailsElement).open) setDiag(await pres.diagnostics()); }}>
        <summary>Diagnostics</summary>
        {diag ? <dl className="kv"><dt>Transport</dt><dd>{diag.transport}</dd><dt>Codec</dt><dd>{diag.codec ?? '—'}</dd><dt>Resolution</dt><dd>{diag.width ? `${diag.width}×${diag.height}` : '—'}</dd><dt>FPS</dt><dd>{diag.fps ?? '—'}</dd>
          <dt>Bitrate</dt><dd>{diag.bitrateKbps != null ? `${diag.bitrateKbps} kb/s` : '—'}</dd><dt>Packets lost</dt><dd>{diag.packetsLost ?? '—'}</dd><dt>RTT</dt><dd>{diag.rttMs != null ? `${diag.rttMs} ms` : '—'}</dd><dt>Layer</dt><dd>{diag.layer ?? '—'}</dd><dt>Media</dt><dd>{pres.mediaState}</dd></dl> : <p className="muted small-text">No media connection.</p>}
      </details>}
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
  const load = useCallback(() => { setErr(''); setSources(null); void api.mediaPermission().then(async (p) => { setPerm(p); if (p.testCapture) return setSources([]); if (p.platform === 'darwin' && p.screen === 'denied') return; try { const l = await api.mediaSources(); setSources(l); setSel((x) => (l.some((s) => s.id === x) ? x : null)); } catch (e) { setErr((e as Error).message); } }); }, []);
  useEffect(load, [load]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  const tests = perm?.testCapture ? [{ id: 'test-screen', kind: 'screen' as const, name: 'Test pattern (screen)', thumbnail: '' }, { id: 'test-window', kind: 'window' as const, name: 'Test pattern (window)', thumbnail: '' }] : [];
  const all = [...tests, ...(sources ?? [])];
  const chosen = all.find((s) => s.id === sel);
  return (
    <div className="picker-backdrop" role="presentation" onClick={onClose}>
      <div className="picker card" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h3>{title}</h3><span className="row"><button className="small" onClick={load}>Refresh</button><button className="small" onClick={onClose}>Cancel</button></span></div>
        {perm?.platform === 'darwin' && perm.screen === 'denied' && !perm.testCapture ? (
          <div className="perm-help" role="alert"><b>CLAN needs permission to record your screen.</b>
            <ol><li>Open <b>System Settings › Privacy &amp; Security › Screen &amp; System Audio Recording</b>.</li><li>Turn on <b>CLAN</b> (after an update, turn it off and on again).</li><li>Quit and reopen CLAN, then press Present again.</li></ol>
            <button className="small" onClick={() => void api.mediaOpenSettings()}>Open Screen Recording settings</button></div>
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
        {chosen && <p className="muted small-text">You’ll share: <b>{chosen.kind === 'screen' ? 'an entire screen' : 'one window'}</b> — {chosen.name}. Nothing else is shared, and nothing is recorded.{chosen.kind === 'screen' && ' Everything on that screen is visible, including CLAN notes you open over it — share one window to keep notes private.'}</p>}
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

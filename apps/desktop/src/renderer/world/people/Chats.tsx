// Chats: one-to-one conversations outside CLAN rooms. A chat starts with an invitation the other person accepts, with
// its terms shown up front (saved, or temporary for 1 h / 24 h / 7 days on both devices). Text, files and voice notes
// travel only over the authenticated local connection; nothing goes through a server.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FilePreview } from '@classroom/client';
import type { PeopleConversation, PeopleMessage, PeopleTransfer } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { useCall } from './Call.tsx';
import { ago, clock, errText, Avatar, Initials, mb, ttlLabel, until, usePeople } from './common.tsx';

const PAGE = 50;
const TTLS: [number, string][] = [[3_600_000, '1 hour'], [86_400_000, '24 hours'], [7 * 86_400_000, '7 days']];
const STATE: Record<PeopleConversation['state'], string> = { invited_out: 'Invitation sent', invited_in: 'Invites you to chat', active: '', declined: 'Declined', ended: 'Ended' };

/** “Chat” for a person: opens the existing chat, or lets you choose saved or temporary and sends an invitation. */
export function ChatInvite({ peerKey, onChat, onError, label = 'Invite to chat', terms = false }: { peerKey: string; onChat(id: string): void; onError(e: string): void; label?: string; terms?: boolean }) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState<number | null>(null);
  const start = () => terms ? setOpen(true) : void api.people.conversations().then((cs) => {
    const c = cs.find((x) => x.peerKey === peerKey && x.state === 'active');
    if (c) onChat(c.id); else setOpen(true);
  }, (e) => onError(errText(e)));
  if (!open) return <button onClick={start}>{label}</button>;
  return (
    <div className="card inset stack" role="group" aria-label="Chat invitation">
      <b>How should this chat be kept?</b>
      <label className="row"><input type="radio" name={`m-${peerKey}`} checked={mode === null} onChange={() => setMode(null)} /> Saved on both devices</label>
      {TTLS.map(([ms, l]) => <label key={ms} className="row"><input type="radio" name={`m-${peerKey}`} checked={mode === ms} onChange={() => setMode(ms)} /> Temporary — messages and files disappear after {l}</label>)}
      <p className="muted small-text">{terms ? 'Messages pause until they accept the new terms. ' : ''}They see these terms and choose whether to accept. Either of you can still keep copies (for example a screenshot or a saved file).</p>
      <div className="row"><button className="primary" onClick={() => void api.people.invite(peerKey, mode ? 'temporary' : 'permanent', mode).then((id) => { setOpen(false); onChat(id); }, (e) => onError(errText(e)))}>Send invitation</button>
        <button onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}

export function Chats({ openId, setOpenId }: { openId: string | null; setOpenId(id: string | null): void }) {
  const [convs] = usePeople(() => api.people.conversations());
  const cur = convs?.find((c) => c.id === openId) ?? null;
  return (
    <div className="stack">
      <header className="page-head"><div><span className="eyebrow">Chats</span><h1 className="title world">Personal chats</h1>
        <p className="muted">Direct, end-to-end over this network — separate from your CLANs. Start one from Nearby or Friends.</p></div></header>
      <div className="chat-split">
        <nav className="card conv-list" aria-label="Conversations">
          {!convs?.length && <p className="muted">No chats yet.</p>}
          <ul className="people-list">{convs?.map((c) => (
            <li key={c.id}><button className={`conv ${c.id === openId ? 'on' : ''}`} aria-current={c.id === openId ? 'true' : undefined} onClick={() => setOpenId(c.id)}>
              <Avatar k={c.peerKey} name={c.peerName} /><span className="grow"><b>{c.peerName}</b>{c.mode === 'temporary' && <span className="chip" title={ttlLabel(c.ttlMs)}> ⏱</span>}
                <br /><small className="muted">{STATE[c.state] || (c.lastText ?? 'No messages yet')}</small></span>
              <span className="conv-meta">{c.lastAt ? <small className="muted">{ago(c.lastAt)}</small> : null}{c.unread > 0 && <span className="badge" aria-label={`${c.unread} unread`}>{c.unread}</span>}</span>
            </button></li>))}</ul>
        </nav>
        {cur ? <ChatView key={cur.id} c={cur} onRemoved={() => setOpenId(null)} /> : <div className="card muted chat-empty">Choose a conversation.</div>}
      </div>
    </div>
  );
}

function ChatView({ c, onRemoved }: { c: PeopleConversation; onRemoved(): void }) {
  const [older, setOlder] = useState<PeopleMessage[]>([]), [noMore, setNoMore] = useState(false);
  const [recent] = usePeople(() => api.people.page(c.id, null, PAGE), [c.id]);
  const [text, setText] = useState(''), [err, setErr] = useState(''), [confirm, setConfirm] = useState<'clear' | 'remove' | 'end' | null>(null);
  const [menu,setMenu]=useState(false),[search,setSearch]=useState<string|null>(null),[filesOnly,setFilesOnly]=useState(false),[details,setDetails]=useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const { call, active } = useCall();
  const msgs = [...older.filter((o) => !recent?.some((r) => r.id === o.id)), ...(recent ?? [])];
  const lastId = msgs.at(-1)?.id;
  const run = (f: () => Promise<unknown>) => { setErr(''); void f().catch((e) => setErr(errText(e))); };

  // auto-scroll only when already at the bottom; otherwise offer “Jump to latest”
  useLayoutEffect(() => { const b = box.current; if (b && atBottom) b.scrollTop = b.scrollHeight; }, [lastId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (c.unread > 0 && document.hasFocus()) void api.people.read(c.id).catch(() => {}); }, [c.unread, lastId, c.id]);
  useEffect(() => { const f = () => { if (c.unread > 0) void api.people.read(c.id).catch(() => {}); }; window.addEventListener('focus', f); return () => window.removeEventListener('focus', f); }, [c.unread, c.id]);
  const onScroll = () => { const b = box.current; if (b) setAtBottom(b.scrollHeight - b.scrollTop - b.clientHeight < 40); };
  const loadEarlier = () => {
    const first = msgs[0]; if (!first) return;
    const b = box.current, h = b?.scrollHeight ?? 0;
    void api.people.page(c.id, first.seq, PAGE).then((m) => { setOlder((o) => [...m, ...o]); if (m.length < PAGE) setNoMore(true); requestAnimationFrame(() => { if (b) b.scrollTop = b.scrollHeight - h; }); }, (e) => setErr(errText(e)));
  };
  const send = () => { const t = text.trim(); if (!t) return; setText(''); setAtBottom(true); run(() => api.people.send(c.id, t)); };
  const canSend = c.state === 'active';

  return (
    <section className="card chat-view stack" aria-label={`Chat with ${c.peerName}`}>
      <header className="row between chat-fixed-header">
        <div className="row"><button aria-label="Back to conversations" onClick={onRemoved}>←</button><Avatar k={c.peerKey} name={c.peerName} /><div><b>{c.peerName}</b><br /><small className="muted">{c.mode === 'temporary' ? ttlLabel(c.ttlMs) : 'Saved chat'}{STATE[c.state] ? ` · ${STATE[c.state]}` : ''}</small></div></div>
        <div className="row">
          {(c.friend || c.state === 'active') && <><button disabled={active} onClick={() => call(c.peerKey, c.peerName)}>Call</button><button disabled={active} onClick={() => call(c.peerKey,c.peerName,true)}>Video call</button></>}
          <button aria-label="Chat options" aria-expanded={menu} onClick={()=>setMenu(!menu)}>⋯</button>
        </div>
      </header>
      {menu && <div className="card inset row" aria-label="Chat options menu"><button onClick={()=>setDetails(!details)}>View contact details</button><button onClick={()=>setSearch(search===null?'':null)}>Search chat</button><button onClick={()=>setFilesOnly(!filesOnly)}>{filesOnly?'All messages':'Shared media/files'}</button><button onClick={()=>run(async()=>{const prefs=await api.notify.prefs();if(window.confirm('Toggle message and call notifications on this device?'))await api.notify.setPrefs({direct:!prefs.direct});})}>Notification settings</button>
          {(c.state === 'active' || c.state === 'ended' || c.state === 'declined') && <ChatInvite peerKey={c.peerKey} onChat={() => {}} onError={setErr} label={c.state === 'active' ? 'Change terms…' : 'Invite again…'} terms />}
          {c.state === 'active' && <button onClick={() => setConfirm('end')}>End chat</button>}
          <button onClick={() => setConfirm('clear')}>Clear history</button>
          <button className="danger" onClick={() => setConfirm('remove')}>Remove</button>
        </div>}
      {details && <p>Contact: {c.peerName} · {c.friend?'Verified friend':'Chat contact'} · {c.peerKey}</p>}
      {search!==null && <label>Search loaded messages<input value={search} onChange={e=>setSearch(e.target.value)} /></label>}
      {confirm && <div className="card inset" role="alertdialog" aria-label="Confirm">
        <p>{confirm === 'clear' ? 'Delete every message and received file in this chat from this device?' : confirm === 'remove' ? 'Remove this conversation and everything in it from this device?' : `End the chat with ${c.peerName}? Neither of you can send more messages until a new invitation is accepted.`}
          {confirm !== 'end' && <> {c.peerName} keeps their own copy — CLAN cannot delete what is already on their device.</>}</p>
        <div className="row"><button className="danger" onClick={() => { const a = confirm; setConfirm(null); setOlder([]); run(() => a === 'clear' ? api.people.clear(c.id) : a === 'remove' ? api.people.remove(c.id).then(onRemoved) : api.people.chat('end', c.id)); }}>
          {confirm === 'clear' ? 'Clear history' : confirm === 'remove' ? 'Remove' : 'End chat'}</button><button onClick={() => setConfirm(null)}>Cancel</button></div>
      </div>}
      {c.state === 'invited_in' && <div className="card inset" role="group" aria-label="Chat invitation">
        <p><b>{c.peerName}</b> invites you to {c.mode === 'temporary' ? <>a <b>temporary</b> chat: {ttlLabel(c.ttlMs).toLowerCase()} on both devices.</> : <>a saved chat.</>}</p>
        <div className="row"><button className="primary" onClick={() => run(() => api.people.chat('accept', c.id))}>Accept</button><button onClick={() => run(() => api.people.chat('decline', c.id))}>Decline</button></div>
      </div>}
      {c.state === 'invited_out' && <p className="muted" role="status">Waiting for {c.peerName} to accept. They will get the invitation as soon as their device is reachable.</p>}
      <div className="messages" ref={box} onScroll={onScroll} role="log" aria-label="Messages" aria-live="polite">
        {msgs.length >= PAGE && !noMore && <button className="link load-earlier" onClick={loadEarlier}>Load earlier messages</button>}
        {msgs.filter(m=>(!filesOnly || !!m.transfer) && (!search || m.text?.toLowerCase().includes(search.toLowerCase()) || m.transfer?.name.toLowerCase().includes(search.toLowerCase()))).map((m) => <Bubble key={m.id} m={m} onError={setErr} />)}
      </div>
      {!atBottom && <button className="small jump" onClick={() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight; setAtBottom(true); }}>Jump to latest</button>}
      {err && <p role="alert" className="error">{err}</p>}
      {canSend ? <div className="composer row">
        <button aria-label="Send a file" title="Send a file" onClick={() => run(() => api.people.sendFile(c.id))}>📎</button>
        <VoiceRecorder convId={c.id} onError={setErr} />
        <textarea className="grow" rows={1} aria-label="Message" placeholder="Message" value={text} maxLength={8000} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          onDrop={(e) => { const f = [...e.dataTransfer.files]; if (f.length) { e.preventDefault(); run(() => api.people.sendFile(c.id, f)); } }} />
        <button className="primary" disabled={!text.trim()} onClick={send}>Send</button>
      </div> : c.state === 'ended' || c.state === 'declined' ? <p className="muted">This chat is closed. Use “Invite again…” to talk.</p> : null}
    </section>
  );
}

function Bubble({ m, onError }: { m: PeopleMessage; onError(e: string): void }) {
  if (m.kind === 'event' || m.kind === 'call') return <p className="msg-event muted small-text" role="note">{m.text} · {clock(m.createdAt)}</p>;
  const st = m.mine ? ({ queued: 'Pending', sending: 'Sending…', delivered: 'Delivered', read: 'Read', failed: 'Failed', received: '' } as const)[m.state] : '';
  return (
    <div className={`msg ${m.mine ? 'mine' : 'theirs'}`} data-state={m.state}>
      {m.transfer ? (m.kind === 'voice' ? <VoiceNote t={m.transfer} mine={m.mine} onError={onError} /> : <FileCard t={m.transfer} mine={m.mine} onError={onError} />) : <p className="msg-text">{m.text}</p>}
      <small className="muted msg-meta">{clock(m.createdAt)}{st ? ` · ${st}` : ''}{m.expiresAt ? ` · disappears ${until(m.expiresAt)}` : ''}
        {m.mine && m.state === 'failed' && <> · <button className="link" onClick={() => void api.people.retry(m.id).catch((e) => onError(errText(e)))}>Retry</button></>}</small>
    </div>
  );
}

const XFER: Record<PeopleTransfer['state'], string> = { offered: 'Waiting for consent', accepted: 'Starting…', transferring: 'Transferring', complete: 'Verified', declined: 'Declined', cancelled: 'Cancelled', failed: 'Failed', expired: 'Expired' };

function FileCard({ t, mine, onError }: { t: PeopleTransfer; mine: boolean; onError(e: string): void }) {
  const [pv, setPv] = useState<FilePreview | null>(null);
  const run = (f: () => Promise<unknown>) => void f().catch((e) => onError(errText(e)));
  const pct = t.size ? Math.round((t.received / t.size) * 100) : 0;
  const live = t.state === 'accepted' || t.state === 'transferring';
  return (
    <div className="file-card stack" aria-label={`File ${t.name}`}>
      <div className="row between"><span><b>{t.name}</b><br /><small className="muted">{mb(t.size)} · {t.retention === 'temporary' ? 'temporary' : 'saved'} · {mine && t.state === 'offered' ? 'Waiting for them to accept' : XFER[t.state]}{t.error ? ` — ${t.error}` : ''}</small></span></div>
      {live && <progress max={100} value={pct} aria-label={`${pct}%`}>{pct}%</progress>}
      <div className="row">
        {!mine && t.state === 'offered' && <><button className="primary small" onClick={() => run(() => api.people.file('accept', t.id))}>Accept {mb(t.size)}</button><button className="small" onClick={() => run(() => api.people.file('decline', t.id))}>Decline</button></>}
        {(live || (mine && t.state === 'offered')) && <button className="small" onClick={() => run(() => api.people.file('cancel', t.id))}>Cancel</button>}
        {!mine && t.state === 'failed' && <button className="small" onClick={() => run(() => api.people.file('retry', t.id))}>Retry</button>}
        {(t.state === 'complete' || (mine && t.state !== 'cancelled' && t.state !== 'expired')) && <>
          <button className="small" onClick={() => run(() => api.people.preview(t.id).then(setPv))}>Preview</button>
          <button className="small" onClick={() => run(() => api.people.save(t.id))}>Save a copy</button>
          <button className="small" onClick={() => run(() => api.people.openWith(t.id))}>Open with…</button></>}
      </div>
      {!mine && t.state === 'offered' && <p className="muted small-text">Nothing is downloaded until you accept. The file is checked against its fingerprint when it arrives.</p>}
      {pv && <div className="preview">{pv.kind === 'image' ? <img src={pv.uri} alt={t.name} style={{ maxWidth: '100%' }} /> : pv.kind === 'text' ? <pre className="preview-text">{pv.text}</pre> : <p className="muted">{pv.reason}</p>}
        <button className="link" onClick={() => setPv(null)}>Close preview</button></div>}
    </div>
  );
}

function VoiceNote({ t, mine, onError }: { t: PeopleTransfer; mine: boolean; onError(e: string): void }) {
  const [url, setUrl] = useState<string | null>(null), [playing, setPlaying] = useState(false), [pos, setPos] = useState(0);
  const el = useRef<HTMLAudioElement | null>(null);
  const dur = (t.voiceMs ?? 0) / 1000;
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const ready = t.state === 'complete' || (mine && !['cancelled', 'expired'].includes(t.state));
  const load = async () => {
    if (url) return el.current!;
    const bytes = await api.people.voiceBytes(t.id);
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: t.mime })); setUrl(u);
    const a = new Audio(u); el.current = a;
    // recorder output has no duration in its header: probing the end once makes it seekable
    await new Promise<void>((res) => { a.onloadedmetadata = () => res(); setTimeout(res, 2000); });
    if (!Number.isFinite(a.duration)) {
      const seek = (at: number) => new Promise<void>((res) => {
        const timer = setTimeout(done, 2000);
        function done() { clearTimeout(timer); a.removeEventListener('seeked', done); res(); }
        a.addEventListener('seeked', done, { once: true }); a.currentTime = at;
      });
      await seek(1e101); await seek(0);
    }
    a.ontimeupdate = () => setPos(a.currentTime); a.onended = () => { setPlaying(false); setPos(0); }; a.onpause = () => setPlaying(false); a.onplay = () => setPlaying(true);
    return a;
  };
  const toggle = () => void load().then(async (a) => { if (a.paused) await a.play(); else a.pause(); }).catch((e) => onError(errText(e)));
  return (
    <div className="voice-note row" aria-label="Voice message">
      {ready ? <button className="small" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>{playing ? '❚❚' : '▶'}</button> : <span aria-hidden>🎙</span>}
      <input type="range" min={0} max={dur || 1} step={0.1} value={pos} disabled={!ready} aria-label="Position" onChange={(e) => { const v = Number(e.target.value); setPos(v); void load().then((a) => { a.currentTime = v; }); }} />
      <small className="muted">{fmt(pos)} / {fmt(dur)}{!ready && ` · ${mine && t.state === 'offered' ? 'Waiting for them to accept' : XFER[t.state]}`}</small>
      {!mine && t.state === 'offered' && <><button className="primary small" onClick={() => void api.people.file('accept', t.id).catch((e) => onError(errText(e)))}>Accept</button><button className="small" onClick={() => void api.people.file('decline', t.id).catch((e) => onError(errText(e)))}>Decline</button></>}
      {!mine && t.state === 'failed' && <button className="small" onClick={() => void api.people.file('retry', t.id).catch((e) => onError(errText(e)))}>Retry</button>}
    </div>
  );
}
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const VOICE_LIMIT_MS = 5 * 60_000;
/** Record → listen back → send or discard. Nothing leaves the device until you press Send. */
function VoiceRecorder({ convId, onError }: { convId: string; onError(e: string): void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'review'>('idle'), [ms, setMs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null), chunks = useRef<Blob[]>([]), started = useRef(0), blob = useRef<Blob | null>(null), container = useRef<'audio/mp4' | 'audio/webm'>('audio/webm');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (state !== 'recording') return; const t = setInterval(() => { const d = Date.now() - started.current; setMs(d); if (d >= VOICE_LIMIT_MS) rec.current?.stop(); }, 200); return () => clearInterval(t); }, [state]);
  useEffect(() => () => { rec.current?.stream.getTracks().forEach((t) => t.stop()); if (url) URL.revokeObjectURL(url); }, [url]);
  const start = async () => {
    try {
      await api.people.armMedia('microphone');
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // AAC in MP4 plays everywhere (iPhones included); WebM/Opus where the OS offers no AAC encoder
      const formats = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'].filter((m) => MediaRecorder.isTypeSupported(m));
      const record = (index: number) => {
        if (!s.getAudioTracks().some((t) => t.readyState === 'live')) return;
        const mime = formats[index];
        if (!mime) { s.getTracks().forEach((t) => t.stop()); setState('idle'); onError('Audio recording could not start. Please try again.'); return; }
        container.current = mime.startsWith('audio/mp4') ? 'audio/mp4' : 'audio/webm';
        const r = new MediaRecorder(s, { mimeType: mime, audioBitsPerSecond: 32_000 }); rec.current = r; chunks.current = [];
        let failed = false;
        r.onerror = () => { failed = true; };
        r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
        r.onstop = () => {
          // isTypeSupported can succeed while the OS encoder fails immediately (AAC on Electron/macOS).
          // Retry only when no audio was produced; keep a partial recording and warn if it failed later.
          if (failed && !chunks.current.length && index + 1 < formats.length) {
            onError('Recording restarted. Please start your message again.');
            try { record(index + 1); } catch { s.getTracks().forEach((t) => t.stop()); setState('idle'); onError('Audio recording could not start. Please try again.'); }
            return;
          }
          s.getTracks().forEach((t) => t.stop());
          if (!chunks.current.length) { setState('idle'); onError('No audio was recorded. Please try again.'); return; }
          if (failed) onError('Recording stopped early. Listen to what was captured before sending.');
          setMs(Date.now() - started.current); blob.current = new Blob(chunks.current, { type: container.current }); setUrl(URL.createObjectURL(blob.current)); setState('review');
        };
        started.current = Date.now(); setMs(0); r.start(500); setState('recording');
      };
      try { record(0); } catch (e) { s.getTracks().forEach((t) => t.stop()); throw e; }
    } catch (e) { const n = (e as DOMException).name; onError(n === 'NotAllowedError' ? 'Microphone access was denied. Allow CLAN to use the microphone in your system settings.' : n === 'NotFoundError' ? 'No microphone was found.' : errText(e)); }
  };
  const discard = () => { if (url) URL.revokeObjectURL(url); setUrl(null); blob.current = null; setState('idle'); };
  const send = () => { const b = blob.current; if (!b) return; const d = ms; discard(); void b.arrayBuffer().then((buf) => api.people.sendVoice(convId, new Uint8Array(buf), container.current, d)).catch((e) => onError(errText(e))); };
  if (state === 'recording') return <span className="row recording" role="status"><span className="rec-dot" aria-hidden /> {fmt(ms / 1000)} <button className="small" onClick={() => rec.current?.stop()}>Stop</button></span>;
  if (state === 'review') return <span className="row" aria-label="Voice message preview">{url && <audio src={url} controls aria-label="Listen before sending" />}<button className="primary small" onClick={send}>Send voice</button><button className="small" onClick={discard}>Discard</button></span>;
  return <button aria-label="Record a voice message" title="Record a voice message" onClick={() => void start()}>🎙</button>;
}

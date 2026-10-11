// One-to-one audio calls on the local network. WebRTC runs here; every signal (offer, answer, reject, end) travels as an
// envelope signed by this device's identity key and checked by the other side, so the SDP — and the DTLS fingerprint in
// it that keys the encrypted media — is bound to the person you called. No STUN/TURN: candidates are local addresses.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../../App.tsx';
import { errText, Initials } from './common.tsx';

type Phase = 'calling' | 'ringing' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
type Call = { id: string; peerKey: string; peerName: string; dir: 'in' | 'out'; phase: Phase; note: string; muted: boolean; connectedAt: number | null; rx: number };
type Ctx = { call(peerKey: string, peerName: string): void; active: boolean };
const CallCtx = createContext<Ctx>({ call: () => {}, active: false });
export const useCall = () => useContext(CallCtx);

const RING_MS = 45_000, GATHER_MS = 4000, RECOVER_MS = 10_000;

/** Waits until ICE gathering finishes (non-trickle: the full candidate list goes inside the one signed offer/answer). */
const gathered = (pc: RTCPeerConnection) => new Promise<void>((res) => {
  if (pc.iceGatheringState === 'complete') return res();
  const t = setTimeout(res, GATHER_MS);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
});

async function microphone(): Promise<MediaStream> {
  await api.people.armMedia('microphone');
  try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
  catch (e) {
    const n = (e as DOMException).name;
    throw new Error(n === 'NotAllowedError' ? 'Microphone access was denied. Allow CLAN to use the microphone in your system settings, then try again.'
      : n === 'NotFoundError' ? 'No microphone was found.' : `The microphone could not start (${n || 'unknown error'}).`);
  }
}

export function CallProvider({ children }: { children: ReactNode }) {
  const [call, setCall] = useState<Call | null>(null);
  const cur = useRef<Call | null>(null);
  const live = () => cur.current; // read through a function: TypeScript must not narrow across awaits
  const pc = useRef<RTCPeerConnection | null>(null), mic = useRef<MediaStream | null>(null), audio = useRef<HTMLAudioElement>(null);
  const timers = useRef<number[]>([]);
  const offer = useRef<string | null>(null);
  const set = (patch: Partial<Call> | null) => { cur.current = patch === null ? null : { ...cur.current!, ...patch }; setCall(cur.current); };
  const after = (ms: number, f: () => void) => { timers.current.push(window.setTimeout(f, ms)); };

  const cleanup = () => {
    timers.current.forEach(clearTimeout); timers.current = [];
    pc.current?.close(); pc.current = null;
    mic.current?.getTracks().forEach((t) => t.stop()); mic.current = null;
    offer.current = null;
  };
  /** Ends the call locally, tells the other side when asked to, and records it in the conversation. */
  const finish = (note: string, outcome: string, tell?: 'call.end' | 'call.reject', reason?: string) => {
    const c = cur.current; if (!c || c.phase === 'ended') return;
    if (tell) void api.people.signal(c.peerKey, tell === 'call.end' ? { kind: 'call.end', callId: c.id, reason: reason ?? 'hangup' } : { kind: 'call.reject', callId: c.id, reason: reason ?? 'declined' }).catch(() => {});
    void api.people.logCall({ id: c.id, peerKey: c.peerKey, direction: c.dir, connectedAt: c.connectedAt, endedAt: Date.now(), outcome }).catch(() => {});
    cleanup();
    set({ phase: 'ended', note });
    after(4000, () => { if (cur.current?.id === c.id) set(null); });
  };

  const wire = (conn: RTCPeerConnection) => {
    conn.ontrack = (e) => { if (audio.current) { audio.current.srcObject = e.streams[0] ?? new MediaStream([e.track]); void audio.current.play().catch(() => {}); } };
    conn.onconnectionstatechange = () => {
      const s = conn.connectionState, c = cur.current; if (!c || pc.current !== conn) return;
      if (s === 'connected') { set({ phase: 'connected', note: '', connectedAt: c.connectedAt ?? Date.now() }); void api.people.logCall({ id: c.id, peerKey: c.peerKey, direction: c.dir, connectedAt: cur.current!.connectedAt }).catch(() => {}); }
      else if (s === 'disconnected' && c.phase === 'connected') { set({ phase: 'reconnecting', note: 'Connection lost. Trying to reconnect…' }); after(RECOVER_MS, () => { if (pc.current === conn && conn.connectionState !== 'connected') finish('The connection was lost.', 'network lost', 'call.end', 'failed'); }); }
      else if (s === 'failed') finish(c.connectedAt ? 'The connection was lost.' : 'Could not connect the call on this network.', 'failed', 'call.end', 'failed');
    };
  };

  const start = async (peerKey: string, peerName: string) => {
    if (cur.current && cur.current.phase !== 'ended') return;
    const id = crypto.randomUUID();
    cur.current = null; set({ id, peerKey, peerName, dir: 'out', phase: 'calling', note: 'Starting the microphone…', muted: false, connectedAt: null, rx: 0 });
    try {
      mic.current = await microphone();
      const conn = new RTCPeerConnection({ iceServers: [] }); pc.current = conn; wire(conn);
      mic.current.getTracks().forEach((t) => conn.addTrack(t, mic.current!));
      await conn.setLocalDescription(await conn.createOffer());
      await gathered(conn);
      if (live()?.id !== id) return;
      void api.people.logCall({ id, peerKey, direction: 'out' }).catch(() => {});
      const reached = await api.people.signal(peerKey, { kind: 'call.invite', callId: id, sdp: conn.localDescription!.sdp });
      if (!reached) return finish(`${peerName} is not reachable right now.`, 'unreachable');
      set({ note: 'Ringing…' });
      after(RING_MS, () => { if (cur.current?.id === id && cur.current.phase === 'calling') finish('No answer.', 'no answer', 'call.end', 'timeout'); });
    } catch (e) { finish(errText(e), 'failed', live()?.note === 'Ringing…' ? 'call.end' : undefined, 'failed'); }
  };

  const accept = async () => {
    const c = cur.current; if (!c || c.phase !== 'ringing' || !offer.current) return;
    set({ phase: 'connecting', note: 'Starting the microphone…' });
    try {
      mic.current = await microphone();
      const conn = new RTCPeerConnection({ iceServers: [] }); pc.current = conn; wire(conn);
      mic.current.getTracks().forEach((t) => conn.addTrack(t, mic.current!));
      await conn.setRemoteDescription({ type: 'offer', sdp: offer.current });
      await conn.setLocalDescription(await conn.createAnswer());
      await gathered(conn);
      if (cur.current?.id !== c.id) return;
      if (!await api.people.signal(c.peerKey, { kind: 'call.answer', callId: c.id, sdp: conn.localDescription!.sdp })) return finish(`${c.peerName} is no longer reachable.`, 'unreachable');
      set({ note: 'Connecting…' });
      after(20_000, () => { if (cur.current?.id === c.id && cur.current.phase === 'connecting') finish('Could not connect the call on this network.', 'failed', 'call.end', 'failed'); });
    } catch (e) { finish(errText(e), 'microphone', 'call.reject', 'unavailable'); }
  };

  // incoming signals (already verified by the main process: signed by that person, fresh, allowed to call)
  useEffect(() => api.people.onLive(({ from, body }) => {
    const c = cur.current;
    if (body.kind === 'call.invite') {
      if (c && c.phase !== 'ended') { void api.people.signal(from, { kind: 'call.reject', callId: body.callId, reason: 'busy' }).catch(() => {}); void api.people.logCall({ id: body.callId, peerKey: from, direction: 'in', endedAt: Date.now(), outcome: 'missed (busy)' }).catch(() => {}); return; }
      offer.current = String(body.sdp);
      cur.current = null; set({ id: body.callId, peerKey: from, peerName: 'Someone', dir: 'in', phase: 'ringing', note: '', muted: false, connectedAt: null, rx: 0 });
      void api.people.contact(from).then((x) => { if (x && cur.current?.id === body.callId) set({ peerName: x.name }); });
      void api.people.logCall({ id: body.callId, peerKey: from, direction: 'in' }).catch(() => {});
      after(RING_MS, () => { if (cur.current?.id === body.callId && cur.current.phase === 'ringing') finish('Missed call.', 'missed'); });
      return;
    }
    if (!c || c.id !== body.callId || c.peerKey !== from) return; // a signal for another call, or from someone else
    if (body.kind === 'call.answer' && c.dir === 'out' && c.phase === 'calling' && pc.current) {
      set({ phase: 'connecting', note: 'Connecting…' });
      void pc.current.setRemoteDescription({ type: 'answer', sdp: String(body.sdp) }).catch((e) => finish(`The answer could not be used (${errText(e)}).`, 'failed', 'call.end', 'failed'));
      after(20_000, () => { if (cur.current?.id === c.id && cur.current.phase === 'connecting') finish('Could not connect the call on this network.', 'failed', 'call.end', 'failed'); });
    } else if (body.kind === 'call.ice' && pc.current) {
      void pc.current.addIceCandidate({ candidate: String(body.candidate), sdpMid: (body.mid as string | null) ?? null, sdpMLineIndex: (body.index as number | null) ?? null }).catch(() => {});
    } else if (body.kind === 'call.reject') {
      finish(body.reason === 'busy' ? `${c.peerName} is on another call.` : body.reason === 'unavailable' ? `${c.peerName} could not take the call (microphone unavailable).` : `${c.peerName} declined the call.`, String(body.reason));
    } else if (body.kind === 'call.end') {
      finish(c.phase === 'ringing' ? 'Missed call.' : body.reason === 'failed' ? 'The connection was lost.' : 'Call ended.', c.phase === 'ringing' ? 'missed' : String(body.reason));
    }
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // real media indicator: bytes of audio actually received over the encrypted connection
  useEffect(() => {
    if (call?.phase !== 'connected' && call?.phase !== 'reconnecting') return;
    const t = setInterval(() => void pc.current?.getStats().then((r) => { let rx = 0; r.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') rx += s.bytesReceived ?? 0; }); if (cur.current) set({ rx }); }), 1000);
    return () => clearInterval(t);
  }, [call?.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick] = useState(0);
  useEffect(() => { if (call?.phase !== 'connected') return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [call?.phase]);
  useEffect(() => () => cleanup(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const mute = () => { const m = !cur.current?.muted; mic.current?.getAudioTracks().forEach((t) => { t.enabled = !m; }); set({ muted: m }); };
  const hangup = () => { const c = cur.current; if (!c) return; if (c.phase === 'ringing') finish('Call declined.', 'declined', 'call.reject', 'declined'); else finish('Call ended.', c.connectedAt ? 'hangup' : 'cancelled', 'call.end', c.connectedAt ? 'hangup' : 'cancelled'); };
  const secs = call?.connectedAt ? Math.max(0, Math.round((Date.now() - call.connectedAt) / 1000)) : 0;
  const label: Record<Phase, string> = { calling: 'Calling', ringing: 'Incoming call', connecting: 'Connecting', connected: 'In call', reconnecting: 'Reconnecting', ended: 'Call ended' };

  return (
    <CallCtx.Provider value={{ call: (k, n) => void start(k, n), active: !!call && call.phase !== 'ended' }}>
      {children}
      <audio ref={audio} autoPlay aria-hidden />
      {call && (
        <div className="call-panel card" role={call.phase === 'ringing' ? 'alertdialog' : 'dialog'} aria-label={`${label[call.phase]}: ${call.peerName}`} data-phase={call.phase} data-rx={call.rx}>
          <div className="row"><Initials name={call.peerName} size={44} /><div><b>{call.peerName}</b><br />
            <span className="muted" role="status">{label[call.phase]}{call.phase === 'connected' ? ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}{call.note ? ` · ${call.note}` : ''}</span>
            {call.phase === 'connected' && <><br /><small className="muted">{call.rx > 0 ? 'Receiving audio · encrypted, on this network' : 'Waiting for audio…'}</small></>}</div></div>
          <div className="row">
            {call.phase === 'ringing' && <button className="primary" onClick={() => void accept()}>Answer</button>}
            {(call.phase === 'connected' || call.phase === 'reconnecting') && <button aria-pressed={call.muted} onClick={mute}>{call.muted ? 'Unmute' : 'Mute'}</button>}
            {call.phase !== 'ended' ? <button className="danger" onClick={hangup}>{call.phase === 'ringing' ? 'Decline' : 'Hang up'}</button> : <button onClick={() => set(null)}>Close</button>}
          </div>
        </div>
      )}
    </CallCtx.Provider>
  );
}

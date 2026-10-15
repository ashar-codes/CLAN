// One-to-one audio calls on the local network (desktop UI). The state machine lives in @classroom/client/call and is
// shared with the phone: WebRTC with no STUN/TURN, every signal a signed envelope checked by the other side, so the SDP
// — and the DTLS fingerprint in it that keys the encrypted media — is bound to the person you called.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CallEngine, type CallPhase, type CallView, type PeerLike } from '@classroom/client/call';
import { api } from '../../App.tsx';
import { errText, Avatar, Initials } from './common.tsx';

type Ctx = { call(peerKey: string, peerName: string, video?: boolean): void; active: boolean };
const CallCtx = createContext<Ctx>({ call: () => {}, active: false });
export const useCall = () => useContext(CallCtx);

async function microphone(): Promise<MediaStream> {
  await api.people.armMedia('microphone');
  try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
  catch (e) {
    const n = (e as DOMException).name;
    throw new Error(n === 'NotAllowedError' ? 'Microphone access was denied. Allow CLAN to use the microphone in your system settings, then try again.'
      : n === 'NotFoundError' ? 'No microphone was found.' : `The microphone could not start (${n || errText(e)}).`);
  }
}

export function CallProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const local = useRef<HTMLVideoElement>(null), remote = useRef<HTMLVideoElement>(null);
  const [cameraId, setCameraId] = useState(''), [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const cameraChoice = useRef(''); cameraChoice.current = cameraId;
  const engine = useRef<CallEngine | null>(null);
  engine.current ??= new CallEngine({
    createPeer: () => new RTCPeerConnection({ iceServers: [] }) as unknown as PeerLike,
    remoteStream: tracks => new MediaStream(tracks as MediaStreamTrack[]) as never,
    microphone: () => microphone() as never,
    camera: async () => { if(document.hidden)throw Error('Return to CLAN before enabling the camera.');await api.people.armMedia('camera');if(document.hidden)throw Error('Return to CLAN before enabling the camera.');return await navigator.mediaDevices.getUserMedia({audio:false,video:cameraChoice.current ? {deviceId:{exact:cameraChoice.current}} : true}) as never; },
    onLocal: s => { if (local.current) local.current.srcObject = s as MediaStream | null; },
    attempt: (key, id) => api.people.attempt(key, id),
    wake: (key, id, kind) => api.people.wakeCall(key, id, kind),
    signal: (k, b) => api.people.signal(k, b),
    log: (o) => void api.people.logCall(o).catch(() => {}),
    nameOf: (k) => api.people.contact(k).then((c) => c?.name ?? null, () => null),
    onRemote: (s) => { const a = audio.current; if (!a) return; a.srcObject = s as MediaStream | null; if (remote.current) remote.current.srcObject = s as MediaStream | null; if (s) void a.play().catch(() => {}); },
    uuid: () => crypto.randomUUID(),
  });
  const e = engine.current;
  const [call, setCall] = useState<CallView | null>(null);
  useEffect(() => e.subscribe(setCall), [e]);
  useEffect(() => api.people.onLive(({ from, body }) => e.onSignal(from, body)), [e]);
  useEffect(() => {
    if (call?.phase !== 'ringing') return;
    const ctx = new AudioContext(); void ctx.resume().catch(() => {});
    const ring = () => { const osc = ctx.createOscillator(), gain = ctx.createGain(); osc.frequency.value = 440; gain.gain.value = 0.07; osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.4); };
    ring(); const timer = setInterval(ring, 1800); return () => { clearInterval(timer); void ctx.close(); };
  }, [call?.phase]);
  const [, tick] = useState(0);
  useEffect(() => { if (call?.phase !== 'connected') return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [call?.phase]);
  useEffect(() => () => { if (e.active) e.hangup(); }, [e]);

  useEffect(() => { const f = () => { if (document.hidden) void e.setCamera(false).catch(() => {}); }; document.addEventListener('visibilitychange',f); return () => document.removeEventListener('visibilitychange',f); },[e]);
  useEffect(() => { if (call?.cameraOn) void navigator.mediaDevices.enumerateDevices().then(ds => setCameras(ds.filter(d => d.kind === 'videoinput'))); },[call?.cameraOn]);
  const secs = call?.connectedAt ? Math.max(0, Math.round((Date.now() - call.connectedAt) / 1000)) : 0;
  const label: Record<CallPhase, string> = { calling: 'Calling', ringing: 'Incoming call', connecting: 'Connecting', connected: 'In call', reconnecting: 'Reconnecting', ended: 'Call ended' };
  return (
    <CallCtx.Provider value={{ call: (k, n, video) => void e.start(k, n, video), active: !!call && call.phase !== 'ended' }}>
      {children}
      <audio ref={audio} autoPlay aria-hidden />
      {call && (
        <div className="call-panel card" role={call.phase === 'ringing' ? 'alertdialog' : 'dialog'} aria-label={`${label[call.phase]}: ${call.peerName}`} data-phase={call.phase} data-rx={call.rx} data-video-rx={call.videoRx}>
          <div className="row"><Avatar k={call.peerKey} name={call.peerName} size={44} /><div><b>{call.peerName}</b><br />
            <span className="muted" role="status">{call.video ? 'Video · ' : ''}{label[call.phase]}{call.phase === 'connected' ? ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}{call.note ? ` · ${call.note}` : ''}</span>
            {call.phase === 'connected' && <><br /><small className="muted">{call.rx > 0 ? 'Receiving audio · encrypted, on this network' : 'Waiting for audio…'}</small></>}</div></div>
          <div className="call-videos"><video ref={remote} autoPlay playsInline muted aria-label="Remote video" /><video ref={local} autoPlay playsInline muted aria-label="Local video" /></div>
          <div className="row">
            {call.phase === 'ringing' && <button className="primary" onClick={() => void e.accept()}>Answer</button>}
            {(call.phase === 'connected' || call.phase === 'reconnecting') && <button aria-pressed={call.muted} onClick={() => e.mute()}>{call.muted ? 'Unmute' : 'Mute'}</button>}
            {(call.phase === 'connected' || call.phase === 'reconnecting') && <button aria-pressed={call.cameraOn} onClick={() => void e.setCamera(!call.cameraOn).catch(err => alert(errText(err)))}>{call.cameraOn ? 'Camera off' : 'Camera on'}</button>}
            {call.cameraOn && cameras.length > 1 && <select aria-label="Camera" value={cameraId} onChange={ev => { setCameraId(ev.target.value); cameraChoice.current=ev.target.value; void e.setCamera(true).catch(err=>alert(errText(err))); }}>{cameras.map(d=><option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>)}</select>}
            {call.phase !== 'ended' ? <button className="danger" onClick={() => e.hangup()}>{call.phase === 'ringing' ? 'Decline' : 'Hang up'}</button> : <button onClick={() => e.dismiss()}>Close</button>}
          </div>
        </div>
      )}
    </CallCtx.Provider>
  );
}

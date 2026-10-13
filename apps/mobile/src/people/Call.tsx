// Calls on the phone: the shared call engine (@classroom/client/call) on react-native-webrtc. Signals travel as signed
// envelopes over whichever path reaches the person (direct link or their computer's socket); audio is WebRTC with no
// STUN/TURN. The microphone opens only when this person starts or answers a call. While CLAN is in the background an
// incoming call raises a local notification (only possible while the app is still running — see Nearby availability).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, PermissionsAndroid, Platform, Text, View } from 'react-native';
import { PeerLink } from '../../modules/peer-link';
import { mediaDevices, MediaStream, type MediaStreamTrack, RTCPeerConnection, RTCView } from '@livekit/react-native-webrtc';
import { AudioSession } from '@livekit/react-native';
import { CallEngine, type CallPhase, type CallView, type PeerLike } from '@classroom/client/call';
import { getRandomBytes } from 'expo-crypto';
import { phoneClan } from '../core/clan';
import { Btn, Mate, Muted, Row, useC } from '../ui/kit';
import { onPeopleLive, phonePeople } from './native';

type Ctx = { call(peerKey: string, peerName: string, video?: boolean): void; active: boolean };
const CallCtx = createContext<Ctx>({ call: () => {}, active: false });
export const usePhoneCall = () => useContext(CallCtx);
const uuid = () => { const b = getRandomBytes(16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80; const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

async function microphone() {
  if (Platform.OS === 'android') {
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (r !== 'granted') throw new Error('Microphone access was denied. Allow CLAN to use the microphone in Settings, then try again.');
  }
  try { return await mediaDevices.getUserMedia({ audio: true, video: false }); }
  catch { throw new Error('Microphone access was denied or the microphone is busy.'); }
}

export function PhoneCallProvider({ children }: { children: ReactNode }) {
  const c = useC();
  const [local, setLocal] = useState<string | null>(null), [remote, setRemote] = useState<string | null>(null);
  const cameraTrack = useRef<{_switchCamera?():void} | null>(null);
  const remoteMedia=useRef<MediaStream|null>(null);
  const engine = useRef<CallEngine | null>(null);
  engine.current ??= new CallEngine({
    remoteStream: tracks => {const stream=remoteMedia.current ??= new MediaStream();for(const track of tracks as MediaStreamTrack[])if(!stream.getTracks().includes(track))stream.addTrack(track);return stream as never;},
    createPeer: () => new RTCPeerConnection({ iceServers: [] }) as unknown as PeerLike,
    microphone: async () => { await AudioSession.startAudioSession().catch(() => {}); const mic = await microphone(); if (Platform.OS === 'android') PeerLink?.availabilityMicrophone?.(true); return mic as never; },
    camera: async () => { if(AppState.currentState!=='active')throw Error('Return to CLAN before enabling the camera.');if (Platform.OS === 'android' && await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA) !== 'granted') throw new Error('Camera permission denied.');if(AppState.currentState!=='active')throw Error('Return to CLAN before enabling the camera.');const stream = await mediaDevices.getUserMedia({audio:false,video:{facingMode:'user'}}); cameraTrack.current=stream.getVideoTracks()[0]; return stream as never; },
    onLocal: s => setLocal(s ? (s as unknown as {toURL():string}).toURL() : null),
    attempt: async (key, id) => { phoneClan().people.queueCallAttempt(key, id); void (await phonePeople()).tick(); },
    signal: async (key, body) => { const p = phoneClan().people; return (await phonePeople()).sendLive(p.callSignal(key, body as never)); },
    log: (o) => { try { phoneClan().people.logCall(o); } catch { /* not fatal */ } },
    nameOf: async (k) => phoneClan().people.contact(k)?.name ?? null,
    onRemote: (s) => { setRemote(s ? (s as unknown as {toURL():string}).toURL() : null); if (!s) { remoteMedia.current?.release(false);remoteMedia.current=null;if (Platform.OS === 'android') PeerLink?.availabilityMicrophone?.(false); void AudioSession.stopAudioSession().catch(() => {}); } }, // remote audio plays by itself
    uuid,
  });
  const e = engine.current;
  const [call, setCall] = useState<CallView | null>(null);
  useEffect(() => e.subscribe(setCall), [e]);
  useEffect(() => () => { if (e.active) e.hangup(); if (Platform.OS === 'android') PeerLink?.ring?.(false); }, [e]);
  useEffect(() => { if (Platform.OS !== 'android') return; PeerLink?.ring?.(call?.phase === 'ringing'); return () => PeerLink?.ring?.(false); }, [call?.phase]);
  useEffect(() => onPeopleLive((env) => {
    const b = env.body as unknown as Record<string, unknown> & { kind: string; callId: string };
    e.onSignal(env.from, b);

  }), [e]);
  const [, tick] = useState(0);
  useEffect(() => { if (call?.phase !== 'connected') return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [call?.phase]);
  useEffect(() => { const sub=AppState.addEventListener('change',st=>{ if(st!=='active') void e.setCamera(false).catch(()=>{}); }); return ()=>sub.remove(); },[e]);
  const secs = call?.connectedAt ? Math.max(0, Math.round((Date.now() - call.connectedAt) / 1000)) : 0;
  const label: Record<CallPhase, string> = { calling: 'Calling', ringing: 'Incoming call', connecting: 'Connecting', connected: 'In call', reconnecting: 'Reconnecting', ended: 'Call ended' };
  return (
    <CallCtx.Provider value={{ call: (k, n, video) => void e.start(k, n, video), active: !!call && call.phase !== 'ended' }}>
      {children}
      {call && (
        <View accessibilityViewIsModal={call.phase === 'ringing'} accessibilityLabel={`${label[call.phase]}: ${call.peerName}`} style={{ position: 'absolute', left: 12, right: 12, top: 48, padding: 14, gap: 10, borderRadius: 18, backgroundColor: c.surface, borderWidth: 2, borderColor: call.phase === 'ringing' ? c.ok : c.border, elevation: 8 }}>
          <Row><Mate name={call.peerName} /><View style={{ flex: 1 }}><Text style={{ color: c.text, fontWeight: '800', fontSize: 17 }}>{call.peerName}</Text>
            <Text accessibilityLiveRegion="polite" style={{ color: c.muted }}>{call.video?'Video · ':''}{label[call.phase]}{call.phase === 'connected' ? ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}{call.note ? ` · ${call.note}` : ''}</Text>
            {call.phase === 'connected' && <Muted small>{call.rx > 0 ? 'Receiving audio · encrypted, nearby only' : 'Waiting for audio…'}</Muted>}</View></Row>
          <Row>{remote && <RTCView streamURL={remote} style={{width:180,height:120}} objectFit="contain" />}{local && <RTCView streamURL={local} style={{width:100,height:100}} mirror objectFit="contain" />}</Row>
          <Row>
            {call.phase === 'ringing' && <Btn primary label="Answer" onPress={() => void e.accept()} />}
            {(call.phase === 'connected' || call.phase === 'reconnecting') && <Btn label={call.muted ? 'Unmute' : 'Mute'} on={call.muted} onPress={() => e.mute()} />}
            {call.phase === 'connected' && <Btn label={call.cameraOn ? 'Camera off' : 'Camera on'} onPress={() => void e.setCamera(!call.cameraOn).catch(err=>{ /* capture failure remains visible */ import('react-native').then(({Alert})=>Alert.alert('Camera',String(err.message))); })} />}
            {call.cameraOn && <Btn label="Switch camera" onPress={()=>cameraTrack.current?._switchCamera?.()} />}
            {call.phase !== 'ended' ? <Btn danger label={call.phase === 'ringing' ? 'Decline' : 'Hang up'} onPress={() => e.hangup()} /> : <Btn label="Close" onPress={() => e.dismiss()} />}
          </Row>
        </View>
      )}
    </CallCtx.Provider>
  );
}

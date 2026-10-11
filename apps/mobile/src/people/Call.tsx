// Calls on the phone: the shared call engine (@classroom/client/call) on react-native-webrtc. Signals travel as signed
// envelopes over whichever path reaches the person (direct link or their computer's socket); audio is WebRTC with no
// STUN/TURN. The microphone opens only when this person starts or answers a call. While CLAN is in the background an
// incoming call raises a local notification (only possible while the app is still running — see Nearby availability).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, PermissionsAndroid, Platform, Text, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { mediaDevices, RTCPeerConnection } from '@livekit/react-native-webrtc';
import { AudioSession } from '@livekit/react-native';
import { CallEngine, type CallPhase, type CallView, type PeerLike } from '@classroom/client/call';
import { getRandomBytes } from 'expo-crypto';
import { phoneClan } from '../core/clan';
import { Btn, Mate, Muted, Row, useC } from '../ui/kit';
import { onPeopleLive, phonePeople } from './native';

type Ctx = { call(peerKey: string, peerName: string): void; active: boolean };
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
  const engine = useRef<CallEngine | null>(null);
  engine.current ??= new CallEngine({
    createPeer: () => new RTCPeerConnection({ iceServers: [] }) as unknown as PeerLike,
    microphone: async () => { await AudioSession.startAudioSession().catch(() => {}); return (await microphone()) as never; },
    signal: async (key, body) => { const p = phoneClan().people; return (await phonePeople()).sendLive(p.callSignal(key, body as never)); },
    log: (o) => { try { phoneClan().people.logCall(o); } catch { /* not fatal */ } },
    nameOf: async (k) => phoneClan().people.contact(k)?.name ?? null,
    onRemote: (s) => { if (!s) void AudioSession.stopAudioSession().catch(() => {}); }, // remote audio plays by itself
    uuid,
  });
  const e = engine.current;
  const [call, setCall] = useState<CallView | null>(null);
  useEffect(() => e.subscribe(setCall), [e]);
  useEffect(() => onPeopleLive((env) => {
    const b = env.body as unknown as Record<string, unknown> & { kind: string; callId: string };
    e.onSignal(env.from, b);
    if (b.kind === 'call.invite' && AppState.currentState !== 'active') {
      void Notifications.scheduleNotificationAsync({ content: { title: 'Incoming CLAN call', body: `${phoneClan().people.contact(env.from)?.name ?? 'Someone'} is calling. Open CLAN to answer.` }, trigger: null }).catch(() => {});
    }
  }), [e]);
  const [, tick] = useState(0);
  useEffect(() => { if (call?.phase !== 'connected') return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [call?.phase]);
  const secs = call?.connectedAt ? Math.max(0, Math.round((Date.now() - call.connectedAt) / 1000)) : 0;
  const label: Record<CallPhase, string> = { calling: 'Calling', ringing: 'Incoming call', connecting: 'Connecting', connected: 'In call', reconnecting: 'Reconnecting', ended: 'Call ended' };
  return (
    <CallCtx.Provider value={{ call: (k, n) => void e.start(k, n), active: !!call && call.phase !== 'ended' }}>
      {children}
      {call && (
        <View accessibilityViewIsModal={call.phase === 'ringing'} accessibilityLabel={`${label[call.phase]}: ${call.peerName}`} style={{ position: 'absolute', left: 12, right: 12, top: 48, padding: 14, gap: 10, borderRadius: 18, backgroundColor: c.surface, borderWidth: 2, borderColor: call.phase === 'ringing' ? c.ok : c.border, elevation: 8 }}>
          <Row><Mate name={call.peerName} /><View style={{ flex: 1 }}><Text style={{ color: c.text, fontWeight: '800', fontSize: 17 }}>{call.peerName}</Text>
            <Text accessibilityLiveRegion="polite" style={{ color: c.muted }}>{label[call.phase]}{call.phase === 'connected' ? ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}{call.note ? ` · ${call.note}` : ''}</Text>
            {call.phase === 'connected' && <Muted small>{call.rx > 0 ? 'Receiving audio · encrypted, nearby only' : 'Waiting for audio…'}</Muted>}</View></Row>
          <Row>
            {call.phase === 'ringing' && <Btn primary label="Answer" onPress={() => void e.accept()} />}
            {(call.phase === 'connected' || call.phase === 'reconnecting') && <Btn label={call.muted ? 'Unmute' : 'Mute'} on={call.muted} onPress={() => e.mute()} />}
            {call.phase !== 'ended' ? <Btn danger label={call.phase === 'ringing' ? 'Decline' : 'Hang up'} onPress={() => e.hangup()} /> : <Btn label="Close" onPress={() => e.dismiss()} />}
          </Row>
        </View>
      )}
    </CallCtx.Provider>
  );
}

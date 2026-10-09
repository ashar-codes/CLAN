// The presentation on the phone's room wall: Watch → the presenter's screen (fit, never cropped), fullscreen with the
// sharp layer, quality dot, "reconnecting" while the network recovers, Leave view. Viewing only.
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StatusBar, Text, View } from 'react-native';
import { VideoView } from '@livekit/react-native';
import type { PresentationView } from '@classroom/protocol';
import type { PinnedNativeTransport } from '../native';
import { watch, type ScreenState } from './viewer';

type C = { text: string; muted: string; border: string; surface: string; accent: string; danger: string; ok: string; warn: string };
const DOT = { good: 'ok', fair: 'warn', poor: 'danger', unknown: 'muted' } as const;

export function PresentationCard({ c, presenting, conn }: { c: C; presenting: PresentationView; conn: { url: string; token: string; transport: PinnedNativeTransport } }) {
  const [s, setS] = useState<ScreenState | null>(null), [err, setErr] = useState(''), [full, setFull] = useState(false);
  const ctl = useRef<Awaited<ReturnType<typeof watch>> | null>(null);
  const start = () => { setErr(''); setS({ track: null, presenter: null, state: 'connecting', quality: 'unknown' }); watch(conn, setS).then((x) => { ctl.current = x; }, (e) => { setErr((e as Error).message); setS(null); }); };
  const stop = () => { setFull(false); void ctl.current?.stop(); ctl.current = null; setS(null); };
  useEffect(() => () => { void ctl.current?.stop(); }, []);
  useEffect(() => { ctl.current?.setFullscreen(full); }, [full, s?.track]);
  const label = `${presenting.presenterName} is presenting their ${presenting.source}${presenting.state === 'reconnecting' ? ' (reconnecting…)' : ''}`;
  const video = s?.track ? <VideoView videoTrack={s.track} objectFit="contain" style={{ flex: 1 }} /> : null;
  const status = s && (s.state !== 'connected' ? (s.state === 'reconnecting' ? 'Reconnecting…' : s.state === 'connecting' ? 'Connecting…' : 'Disconnected') : s.track ? '' : 'Waiting for the screen…');
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 12, gap: 8, backgroundColor: c.surface }} accessibilityLabel="Presentation">
      <Text style={{ color: c.text, fontWeight: '700' }} accessibilityLiveRegion="polite">{label}</Text>
      {s ? (
        <>
          <View style={{ height: 220, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000', justifyContent: 'center' }} accessibilityLabel="Shared screen">
            {video}{!!status && <Text style={{ color: '#fff', textAlign: 'center', position: 'absolute', alignSelf: 'center' }}>{status}</Text>}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c[DOT[s.quality]] }} accessibilityLabel={`Quality ${s.quality}`} />
            <Btn c={c} label="Fullscreen" onPress={() => setFull(true)} disabled={!s.track} />
            <Btn c={c} label="Leave view" onPress={stop} />
          </View>
        </>
      ) : <Btn c={c} label="Watch" primary onPress={start} />}
      {!!err && <Text style={{ color: c.danger }}>{err}</Text>}
      <Modal visible={full} onRequestClose={() => setFull(false)} supportedOrientations={['portrait', 'landscape']} animationType="none">
        <StatusBar hidden />
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {video}
          {!!status && <Text style={{ color: '#fff', position: 'absolute', top: 40, alignSelf: 'center' }}>{status}</Text>}
          <Pressable accessibilityRole="button" accessibilityLabel="Exit fullscreen" onPress={() => setFull(false)} style={{ position: 'absolute', top: 24, right: 16, padding: 14, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.6)' }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>Exit</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

function Btn({ c, label, onPress, primary, disabled }: { c: C; label: string; onPress(): void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: primary ? c.accent : c.border, backgroundColor: primary ? c.accent : 'transparent', opacity: disabled ? 0.5 : 1 }}>
      <Text style={{ color: primary ? c.surface : c.text, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

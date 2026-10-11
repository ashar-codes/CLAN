// Voice messages on the phone (expo-audio): record → listen back → send or discard, and play received ones with
// play/pause, seek and replay. Recorded as AAC in MP4 (.m4a) so computers and both phone platforms can play it. The
// microphone is used only while recording; a received voice note is re-hashed against its fingerprint before playing.
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { File } from 'expo-file-system';
import { AudioQuality, createAudioPlayer, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, type AudioPlayer, type RecordingOptions } from 'expo-audio';
import type { PeopleTransfer } from '@clan/core';
import { phoneClan } from '../core/clan';
import { verify } from '../FileActions';
import { Btn, Row, useC } from '../ui/kit';

const LIMIT_MS = 5 * 60_000;
const VOICE: RecordingOptions = {
  extension: '.m4a', sampleRate: 44100, numberOfChannels: 1, bitRate: 64000,
  android: { extension: '.m4a', outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
  web: {},
};
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function VoiceRecorder({ convId, onError, onSent }: { convId: string; onError(e: string): void; onSent(): void }) {
  const c = useC();
  const rec = useAudioRecorder(VOICE);
  const [state, setState] = useState<'idle' | 'recording' | 'review'>('idle'), [ms, setMs] = useState(0);
  const started = useRef(0), uri = useRef<string | null>(null);
  const preview = useRef<AudioPlayer | null>(null);
  useEffect(() => { if (state !== 'recording') return; const t = setInterval(() => { const d = Date.now() - started.current; setMs(d); if (d >= LIMIT_MS) void stop(); }, 250); return () => clearInterval(t); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { preview.current?.remove(); }, []);
  const start = async () => {
    try {
      const p = await requestRecordingPermissionsAsync();
      if (!p.granted) return onError('Microphone access was denied. Allow CLAN to use the microphone in Settings.');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await rec.prepareToRecordAsync(); rec.record();
      started.current = Date.now(); setMs(0); setState('recording');
    } catch (e) { onError((e as Error).message); }
  };
  const stop = async () => {
    try { await rec.stop(); await setAudioModeAsync({ allowsRecording: false }); uri.current = rec.uri; setMs(Date.now() - started.current); setState(rec.uri ? 'review' : 'idle'); }
    catch (e) { onError((e as Error).message); setState('idle'); }
  };
  const discard = () => { preview.current?.remove(); preview.current = null; if (uri.current) { try { new File(uri.current).delete(); } catch { /* temp */ } } uri.current = null; setState('idle'); };
  const send = async () => {
    const u = uri.current; if (!u) return;
    preview.current?.remove(); preview.current = null;
    try { await phoneClan().people.offerFile(convId, u, { name: 'Voice message.m4a', mime: 'audio/mp4', voiceMs: ms }); onSent(); }
    catch (e) { onError((e as Error).message); }
    setState('idle');
  };
  if (state === 'recording') return <Row><Text accessibilityLiveRegion="polite" style={{ color: c.danger, fontWeight: '700' }}>● Recording {fmt(ms / 1000)}</Text><Btn small label="Stop" onPress={() => void stop()} /></Row>;
  if (state === 'review') return (
    <Row>
      <Btn small label="▶ Listen" a11y="Listen before sending" onPress={() => { preview.current?.remove(); preview.current = createAudioPlayer(uri.current!); preview.current.play(); }} />
      <Btn small primary label={`Send voice (${fmt(ms / 1000)})`} onPress={() => void send()} />
      <Btn small label="Discard" onPress={discard} />
    </Row>
  );
  return <Btn small label="🎙" a11y="Record a voice message" onPress={() => void start()} />;
}

/** Play a voice note (received after verification, or our own sent copy). */
export function VoiceNotePlayer({ t, mine, onError }: { t: PeopleTransfer; mine: boolean; onError(e: string): void }) {
  const c = useC();
  const player = useRef<AudioPlayer | null>(null);
  const [pos, setPos] = useState(0), [playing, setPlaying] = useState(false), [width, setWidth] = useState(1);
  const dur = (t.voiceMs ?? 0) / 1000;
  useEffect(() => () => { player.current?.remove(); }, []);
  const ready = t.state === 'complete' || (mine && !['cancelled', 'expired'].includes(t.state));
  const load = async () => {
    if (player.current) return player.current;
    const path = mine ? phoneClan().people.outgoingBytesLocal(t.id) : phoneClan().people.filePath(t.id);
    if (!path) throw new Error('This voice message is not on this phone.');
    await verify(new File(path), t.sha256);
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
    const p = createAudioPlayer(path);
    p.addListener('playbackStatusUpdate', (s) => { setPos(s.currentTime); setPlaying(s.playing); if (s.didJustFinish) { setPlaying(false); void p.seekTo(0); setPos(0); } });
    player.current = p; return p;
  };
  const toggle = () => void load().then((p) => { if (p.playing) p.pause(); else p.play(); }, (e) => onError((e as Error).message));
  const seek = (x: number) => void load().then((p) => p.seekTo(Math.max(0, Math.min(dur, (x / width) * dur))), (e) => onError((e as Error).message));
  return (
    <View style={{ gap: 4 }} accessibilityLabel="Voice message">
      <Row>
        {ready ? <Btn small label={playing ? '❚❚' : '▶'} a11y={playing ? 'Pause' : 'Play'} onPress={toggle} /> : <Text>🎙</Text>}
        <Pressable accessibilityRole="adjustable" accessibilityLabel="Position" accessibilityValue={{ min: 0, max: Math.round(dur), now: Math.round(pos) }} disabled={!ready}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width || 1)} onPress={(e) => seek(e.nativeEvent.locationX)}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={(e) => seek(((pos + (e.nativeEvent.actionName === 'increment' ? 5 : -5)) / Math.max(dur, 1)) * width)}
          style={{ flex: 1, minWidth: 120, height: 28, justifyContent: 'center' }}>
          <View style={{ height: 4, backgroundColor: c.border, borderRadius: 2 }}><View style={{ width: `${dur ? Math.min(100, (pos / dur) * 100) : 0}%`, height: 4, backgroundColor: c.accent, borderRadius: 2 }} /></View>
        </Pressable>
        <Text style={{ color: c.muted, fontSize: 12 }}>{fmt(pos)} / {fmt(dur)}</Text>
      </Row>
    </View>
  );
}

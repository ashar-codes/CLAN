// The presentation on the phone's room wall: Watch → the presenter's screen (fit, never cropped), fullscreen with the
// sharp layer, quality dot, "reconnecting" while the network recovers, Leave view. Viewing only.
import { useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StatusBar, Text, TextInput, View } from 'react-native';
import { VideoView } from '@livekit/react-native';
import type { PresentationView } from '@classroom/protocol';
import type { PinnedNativeTransport } from '../native';
import { watch, type ScreenState } from './viewer';
import { me, phoneClan } from '../core/clan';

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
          <Tools c={c} context={`${presenting.presenterName}’s presentation`} quality={s?.quality ?? 'unknown'} onExit={() => setFull(false)} onLeave={stop} />
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

/** Floating + over the fullscreen screen share: private notes and view controls; the stream keeps playing behind. */
function Tools({ c, context, quality, onExit, onLeave }: { c: C; context: string; quality: ScreenState['quality']; onExit(): void; onLeave(): void }) {
  const [menu, setMenu] = useState(false), [notes, setNotes] = useState(false), [min, setMin] = useState(false);
  const [title, setTitle] = useState(`Notes — ${context}`), [body, setBody] = useState(''), [saved, setSaved] = useState<{ id: string; t: string; b: string } | null>(null), [msg, setMsg] = useState('');
  const started = useRef(new Date());
  const text = () => `${body}\n\n— Taken during ${context}, ${started.current.toLocaleString()}`;
  const dirty = !!body.trim() && (!saved || saved.t !== title || saved.b !== text());
  const save = () => { // private: the phone's own notes (Inbox), works offline, never sent to the room
    const t = title.trim() || 'Presentation notes', b = text();
    if (saved) phoneClan().notes.update(me(), saved.id, { title: t, body: b });
    else return phoneClan().capture.capture(me(), { kind: 'note', title: t, body: b }).then((it) => { setSaved({ id: it.entityId, t, b }); setMsg('Saved to your Inbox'); });
    setSaved({ id: saved.id, t, b }); setMsg('Saved to your Inbox'); return Promise.resolve();
  };
  const latest = useRef({ dirty, save }); latest.current = { dirty, save };
  useEffect(() => () => { if (latest.current.dirty) void latest.current.save().catch(() => {}); }, []); // presentation ended or view closed: keep the note
  const close = () => { if (!dirty) return setNotes(false); Alert.alert('Unsaved note', 'Save this note before closing?', [{ text: 'Keep editing', style: 'cancel' }, { text: 'Discard', style: 'destructive', onPress: () => { latest.current.dirty = false; setBody(''); setNotes(false); } }, { text: 'Save', onPress: () => void save().then(() => setNotes(false), (e) => setMsg((e as Error).message)) }]); };
  const item = (label: string, on: () => void) => <Pressable key={label} accessibilityRole="menuitem" onPress={() => { setMenu(false); on(); }} style={{ minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 22, backgroundColor: 'rgba(20,24,36,0.9)' }}><Text style={{ color: '#fff', fontWeight: '700' }}>{label}</Text></Pressable>;
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'flex-end' }}>
      {notes && (
        <View accessibilityLabel="Notes" style={{ margin: 12, padding: 12, gap: 8, borderRadius: 16, backgroundColor: c.surface, maxHeight: '60%' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: c.text, fontWeight: '700' }}>Notes{dirty ? ' · not saved' : saved ? ' · saved' : ''}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}><Btn c={c} label={min ? 'Expand' : 'Minimize'} onPress={() => setMin(!min)} /><Btn c={c} label="Close" onPress={close} /></View>
          </View>
          {!min && <>
            <TextInput value={title} onChangeText={setTitle} accessibilityLabel="Note title" maxLength={200} style={{ color: c.text, borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 8 }} />
            <TextInput value={body} onChangeText={setBody} accessibilityLabel="Note" placeholder="Type your notes…" placeholderTextColor={c.muted} multiline autoFocus maxLength={100_000} style={{ color: c.text, borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 8, minHeight: 110, textAlignVertical: 'top' }} />
            <Text style={{ color: c.muted, fontSize: 12 }}>Private — saved to your Inbox, not shared with the room.{msg ? ` ${msg}.` : ''}</Text>
            <Btn c={c} label="Save" primary disabled={!dirty} onPress={() => void save().catch((e) => setMsg((e as Error).message))} />
          </>}
        </View>
      )}
      <View pointerEvents="box-none" style={{ alignItems: 'flex-end', padding: 20, gap: 8 }}>
        {menu && <>
          {item('Take Notes', () => { setNotes(true); setMin(false); })}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 32, borderRadius: 16, backgroundColor: 'rgba(20,24,36,0.9)' }}><View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c[DOT[quality]] }} /><Text style={{ color: '#fff' }}>Quality {quality}</Text></View>
          {item('Exit fullscreen', onExit)}
          {item('Leave presentation view', onLeave)}
        </>}
        <Pressable accessibilityRole="button" accessibilityLabel="Presentation tools" accessibilityState={{ expanded: menu }} onPress={() => setMenu(!menu)} testID="presentation-tools"
          style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: menu ? 'rgba(20,24,36,0.95)' : 'rgba(20,24,36,0.55)' }}>
          <Text style={{ color: '#fff', fontSize: 30, lineHeight: 34, transform: [{ rotate: menu ? '45deg' : '0deg' }] }}>+</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

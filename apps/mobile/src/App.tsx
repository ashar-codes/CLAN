import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { ClassroomConnection, joinByCode, JoinFailed, type Candidate, type JoinResult, type Quality } from '@classroom/client';
import { StudentProfile, type ClassroomInfo, type ClientMessage, type MemberStatus, type ResourceView, type StudentAssignmentView } from '@classroom/protocol';
import { ClassContent } from './ClassContent';
import { browse } from './discovery';
import { loadProfile, saveProfile } from './storage';

const QUALITY: Record<Quality, string> = { excellent: 'Excellent', good: 'Good', poor: 'Poor', disconnected: 'Reconnecting…' };

export default function App() {
  const dark = useColorScheme() === 'dark';
  const c = dark ? darkColors : lightColors;
  const [profile, setProfile] = useState<(Partial<StudentProfile> & { deviceId: string }) | null>(null);
  const [editing, setEditing] = useState(false);
  const [joined, setJoined] = useState<JoinResult | null>(null);

  useEffect(() => { loadProfile().then((p) => { setProfile(p); if (!StudentProfile.safeParse(p).success) setEditing(true); }); }, []);
  if (!profile) return null;

  return (
    <SafeAreaView style={[s.fill, { backgroundColor: c.bg }]}>
      <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {editing ? (
          <ProfileForm c={c} initial={profile} onSaved={(p) => { setProfile(p); setEditing(false); }} />
        ) : joined ? (
          <InClass c={c} joined={joined} onLeave={() => setJoined(null)} />
        ) : (
          <JoinScreen c={c} profile={profile as StudentProfile} onJoined={setJoined} onEdit={() => setEditing(true)} />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

type C = typeof lightColors;

function ProfileForm({ c, initial, onSaved }: { c: C; initial: Partial<StudentProfile> & { deviceId: string }; onSaved(p: StudentProfile): void }) {
  const [p, setP] = useState({ fullName: initial.fullName ?? '', rollNo: initial.rollNo ?? '', deviceName: initial.deviceName ?? '' });
  const [error, setError] = useState('');
  const save = async () => {
    const parsed = StudentProfile.safeParse({ ...p, deviceId: initial.deviceId });
    if (!parsed.success) return setError('Please fill in every field.');
    await saveProfile(parsed.data);
    onSaved(parsed.data);
  };
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={[s.h1, { color: c.text }]}>Your details</Text>
      <Text style={{ color: c.muted }}>Shown to your teacher so they know who is joining. Saved on this phone only.</Text>
      <Field c={c} label="Full name" value={p.fullName} placeholder="Ashar Khan" onChange={(v) => setP({ ...p, fullName: v })} />
      <Field c={c} label="Student / roll number" value={p.rollNo} placeholder="FA23-CS-114" onChange={(v) => setP({ ...p, rollNo: v })} />
      <Field c={c} label="Device name" value={p.deviceName} placeholder="Ashar-iPhone" onChange={(v) => setP({ ...p, deviceName: v })} />
      {!!error && <Text style={{ color: c.danger }}>{error}</Text>}
      <Button c={c} primary label="Save" onPress={save} />
    </ScrollView>
  );
}

function JoinScreen({ c, profile, onJoined, onEdit }: { c: C; profile: StudentProfile; onJoined(j: JoinResult): void; onEdit(): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<Candidate[]>([]);
  const foundRef = useRef<Candidate[]>([]);
  useEffect(() => browse((l) => { foundRef.current = l; setFound(l); }), []);

  const join = async () => {
    setBusy(true); setError('');
    try {
      for (let i = 0; i < 24 && foundRef.current.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
      onJoined(await joinByCode(foundRef.current, code, profile));
    } catch (e) {
      setError(e instanceof JoinFailed ? e.message : 'Something went wrong. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={[s.h1, { color: c.text }]}>Join Classroom</Text>
      <Pressable onPress={onEdit}><Text style={{ color: c.muted }}>Joining as <Text style={{ fontWeight: '600', color: c.text }}>{profile.fullName}</Text> · <Text style={{ color: c.accent }}>edit</Text></Text></Pressable>
      <TextInput
        style={[s.code, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
        value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad" maxLength={6} placeholder="000000" placeholderTextColor={c.border} autoFocus
        accessibilityLabel="Six digit classroom code" onSubmitEditing={() => code.length === 6 && join()}
      />
      {!!error && <Text style={{ color: c.danger }}>{error}</Text>}
      <Button c={c} primary label={busy ? 'Finding classroom…' : 'Join'} disabled={code.length !== 6 || busy} onPress={join} />
      <Text style={{ color: c.muted, marginTop: 24 }}>
        {found.length ? `Classrooms nearby: ${found.map((f) => f.title).join(', ')}` : 'Looking for classrooms on this Wi-Fi… Make sure you are on the same network as your teacher. Internet is not needed.'}
      </Text>
    </ScrollView>
  );
}

function InClass({ c, joined, onLeave }: { c: C; joined: JoinResult; onLeave(): void }) {
  const [status, setStatus] = useState<MemberStatus>(joined.status);
  const [info, setInfo] = useState<ClassroomInfo>(joined.classroom);
  const [quality, setQuality] = useState<Quality>('disconnected');
  const [closed, setClosed] = useState(false);
  const [resources, setResources] = useState<ResourceView[]>([]);
  const [assignments, setAssignments] = useState<StudentAssignmentView[]>([]);
  const [pushed, setPushed] = useState<string | null>(null);
  const ref = useRef<ClassroomConnection | null>(null);
  useEffect(() => {
    const conn = new ClassroomConnection(joined.url, joined.token, {
      onMessage: (m) => {
        if (m.t === 'hello') { setInfo(m.classroom); if (m.status) setStatus(m.status); }
        if (m.t === 'class.state') setInfo(m.classroom);
        if (m.t === 'member.status') setStatus(m.status);
        if (m.t === 'resources') setResources(m.resources as ResourceView[]);
        if (m.t === 'assignments') setAssignments(m.assignments as StudentAssignmentView[]);
        if (m.t === 'resource.push') setPushed(m.resourceId);
      },
      onQuality: setQuality,
      onClosed: () => setClosed(true),
    });
    ref.current = conn;
    return () => conn.close();
  }, [joined]);
  const send = useCallback((m: ClientMessage) => ref.current?.send(m), []);
  const conn = useMemo(() => ({ url: joined.url, token: joined.token, sessionId: joined.classroom.sessionId, classTitle: joined.classroom.title }), [joined]);

  const over = info.ended ? 'The class has ended.' : status === 'rejected' ? 'The teacher declined your request.' : status === 'removed' ? 'You were removed from the class.'
    : status === 'blocked' ? 'This device was blocked from the class.' : closed ? 'Your session expired. Join again with the code.' : '';

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={[s.h1, { color: c.text }]}>{info.title}</Text>
      {over ? (
        <><Text style={{ color: c.text, fontSize: 17 }}>{over}</Text><Button c={c} primary label="OK" onPress={onLeave} /></>
      ) : status === 'pending' ? (
        <><ActivityIndicator size="large" /><Text style={{ color: c.text, fontSize: 17, textAlign: 'center' }}>Waiting for the teacher to let you in…</Text><Button c={c} label="Cancel" onPress={onLeave} /></>
      ) : (
        <>
          <View style={[s.pill, { borderColor: c.border }]}>
            <View style={[s.dot, { backgroundColor: quality === 'disconnected' ? c.danger : quality === 'poor' ? c.warn : c.ok }]} />
            <Text style={{ color: c.text }}>{QUALITY[quality]}</Text>
          </View>
          <ClassContent c={c} conn={conn} resources={resources} assignments={assignments} pushed={pushed} send={send} />
          <Button c={c} label="Leave class" onPress={onLeave} />
        </>
      )}
    </ScrollView>
  );
}

function Field({ c, label, value, placeholder, onChange }: { c: C; label: string; value: string; placeholder: string; onChange(v: string): void }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.text, fontWeight: '600' }}>{label}</Text>
      <TextInput style={[s.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]} value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={c.muted} maxLength={80} accessibilityLabel={label} />
    </View>
  );
}

function Button({ c, label, onPress, primary, disabled }: { c: C; label: string; onPress(): void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={({ pressed }) => [s.btn, { backgroundColor: primary ? c.accent : c.surface, borderColor: primary ? c.accent : c.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}>
      <Text style={{ color: primary ? '#fff' : c.text, fontSize: 17, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const lightColors = { bg: '#f6f7f9', surface: '#fff', text: '#16191d', muted: '#646b75', border: '#d5dae0', accent: '#1f6feb', danger: '#c93c37', ok: '#1a7f37', warn: '#b7791f' };
const darkColors: C = { bg: '#111418', surface: '#1a1e24', text: '#e8ebef', muted: '#9aa3ad', border: '#2c323a', accent: '#4c8dff', danger: '#ff6b63', ok: '#3fb950', warn: '#e3b341' };

const s = StyleSheet.create({
  fill: { flex: 1 },
  page: { padding: 20, gap: 14, flexGrow: 1, justifyContent: 'center' },
  h1: { fontSize: 28, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 12, padding: 14, fontSize: 17 },
  code: { borderWidth: 1, borderRadius: 14, padding: 16, fontSize: 40, letterSpacing: 12, textAlign: 'center', fontVariant: ['tabular-nums'] },
  btn: { borderWidth: 1, borderRadius: 14, paddingVertical: 16, alignItems: 'center', minHeight: 52 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 99, paddingHorizontal: 14, paddingVertical: 8, alignSelf: 'flex-start' },
  dot: { width: 10, height: 10, borderRadius: 5 },
});

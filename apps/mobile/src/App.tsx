import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, PermissionsAndroid, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { ClassroomConnection, pairAndJoin, reconnect, TransferError, type Candidate, type DeviceSigner, type PairedJoin, type Quality } from '@classroom/client';
import { clanLabels, decodeDirectQr, shortFingerprint, StudentProfile, type DirectPackage, type ClassroomInfo, type ClientMessage, type MemberStatus, type PresentationView, type ResourceView, type StudentAssignmentView } from '@classroom/protocol';
import { ClassContent } from './ClassContent';
import { ChatSection, useMobileChat } from './Chat';
import { InboxCard } from './Inbox';
import { browse } from './discovery';
import { deviceSigner, loadProfile, saveProfile, type OwnProfile } from './storage';
import { opaqueClient, pinnedNativeTransport, type PinnedNativeTransport } from './native';
import { OpaqueBridgeHost } from './OpaqueBridgeHost';
import { dark, light } from '@clan/design/palette';
import { associator, bleCarriers } from '../modules/direct-join';

/** Android asks at run time; a refusal just means no BLE (QR / existing network still work). */
async function bleAllowed() {
  if (Platform.OS !== 'android') return true;
  const r = await PermissionsAndroid.requestMultiple(['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT', 'android.permission.ACCESS_FINE_LOCATION'] as never).catch(() => ({}));
  return Object.values(r).some((v) => v === 'granted');
}

const QUALITY: Record<Quality, string> = { excellent: 'Excellent', good: 'Good', poor: 'Poor', disconnected: 'Reconnecting…' };

export default function App() {
  const dark = useColorScheme() === 'dark';
  const c = dark ? darkColors : lightColors;
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [editing, setEditing] = useState(false);
  const [joined, setJoined] = useState<PairedJoin | null>(null);

  useEffect(() => { loadProfile().then((p) => { setProfile(p); if (!StudentProfile.safeParse(p).success) setEditing(true); }); }, []);
  if (!profile) return null;

  return (
    <SafeAreaView style={[s.fill, { backgroundColor: c.bg }]}>
      <OpaqueBridgeHost />
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

function ProfileForm({ c, initial, onSaved }: { c: C; initial: OwnProfile; onSaved(p: OwnProfile): void }) {
  const [p, setP] = useState({ fullName: initial.fullName ?? '', rollNo: initial.rollNo ?? '', deviceName: initial.deviceName ?? '' });
  const [error, setError] = useState('');
  const save = async () => {
    const parsed = StudentProfile.safeParse({ ...p, devicePublicKey: initial.devicePublicKey });
    if (!parsed.success) return setError('Please fill in every field.');
    await saveProfile(parsed.data);
    onSaved({ ...initial, ...parsed.data });
  };
  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={[s.h1, { color: c.text }]}>Your details</Text>
      <Text style={{ color: c.muted }}>Shown to the CLAN host so they know who is joining. Saved on this phone only.</Text>
      <Field c={c} label="Full name" value={p.fullName} placeholder="Ashar Khan" onChange={(v) => setP({ ...p, fullName: v })} />
      <Field c={c} label="Student / roll number" value={p.rollNo} placeholder="FA23-CS-114" onChange={(v) => setP({ ...p, rollNo: v })} />
      <Field c={c} label="Device name" value={p.deviceName} placeholder="Ashar-iPhone" onChange={(v) => setP({ ...p, deviceName: v })} />
      {!!error && <Text style={{ color: c.danger }}>{error}</Text>}
      <Text style={{ color: c.muted, fontSize: 12 }}>Device key {shortFingerprint(initial.fingerprint)} — kept in this phone's secure storage.</Text>
      <Button c={c} primary label="Save" onPress={save} />
    </ScrollView>
  );
}

function JoinScreen({ c, profile, onJoined, onEdit }: { c: C; profile: StudentProfile; onJoined(j: PairedJoin): void; onEdit(): void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState<Candidate[]>([]);
  const foundRef = useRef<Candidate[]>([]);
  useEffect(() => browse((l) => { foundRef.current = l; setFound(l); }), []);
  // QR fallback: the system camera opens clan://direct#… ; it gives the network only, the code is still needed.
  const [qr, setQr] = useState<DirectPackage | null>(null);
  const [manual, setManual] = useState<{ ssid: string; passphrase: string } | null>(null);
  useEffect(() => {
    const take = (url: string | null) => { if (!url) return; try { setQr(decodeDirectQr(url)); setError(''); } catch (e) { setError((e as Error).message); } };
    void Linking.getInitialURL().then(take);
    const sub = Linking.addEventListener('url', (e) => take(e.url));
    return () => sub.remove();
  }, []);

  const join = async () => {
    setBusy(true); setError(''); setManual(null);
    try {
      let candidates = foundRef.current;
      if (qr) {
        if (!associator) throw Object.assign(new TransferError('direct_manual', 'Join the CLAN network in Settings, then try again.'), { direct: qr });
        await associator(qr);
        candidates = [{ url: `http://${qr.host}:${qr.bootstrapPort}`, sid: qr.sessionId }];
      }
      const carriers = qr ? [] : (await bleAllowed()) ? await bleCarriers() : [];
      for (let i = 0; i < 12 && candidates.length === 0 && carriers.length === 0; i++) { await new Promise((r) => setTimeout(r, 250)); candidates = foundRef.current; }
      // Same secure flow as desktop: OPAQUE (official WASM in the isolated WebView) -> MACed binding -> pinned native TLS.
      onJoined(await pairAndJoin({ candidates, carriers, associate: associator, code, profile, device: await deviceSigner(), opaque: opaqueClient(), transportFor: pinnedNativeTransport }));
    } catch (e) {
      const d = (e as { code?: string; direct?: DirectPackage }).direct;
      if ((e as { code?: string }).code === 'direct_manual' && d) setManual({ ssid: d.ssid, passphrase: d.passphrase });
      else setError(e instanceof TransferError ? e.message : 'Something went wrong. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={[s.h1, { color: c.text }]}>Join CLAN</Text>
      <Pressable onPress={onEdit}><Text style={{ color: c.muted }}>Joining as <Text style={{ fontWeight: '600', color: c.text }}>{profile.fullName}</Text> · <Text style={{ color: c.accent }}>edit</Text></Text></Pressable>
      <TextInput
        style={[s.code, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]}
        value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad" maxLength={6} placeholder="000000" placeholderTextColor={c.border} autoFocus
        accessibilityLabel="Six digit classroom code" onSubmitEditing={() => code.length === 6 && join()}
      />
      {!!error && <Text style={{ color: c.danger }}>{error}</Text>}
      {qr && <Text style={{ color: c.muted }}>Network from QR ready ({qr.ssid}). Enter the code to join.</Text>}
      {manual && (
        <View style={[s.pill, { borderColor: c.border, flexDirection: 'column', alignItems: 'flex-start' }]}>
          <Text style={{ color: c.text, fontWeight: '600' }}>Connect to this network in Settings, then tap Join again</Text>
          <Text style={{ color: c.text }} selectable>Network: {manual.ssid}</Text>
          <Text style={{ color: c.text }} selectable>Password: {manual.passphrase}</Text>
        </View>
      )}
      <Button c={c} primary label={busy ? 'Joining…' : 'Join'} disabled={code.length !== 6 || busy} onPress={join} />
      <InboxCard c={c} />
      <Text style={{ color: c.muted, marginTop: 24 }}>
        {found.length ? `Nearby: ${found.map((f) => f.title).join(', ')}` : 'Looking for CLANs on this Wi-Fi… Make sure you are on the same network as the host. Internet is not needed.'}
      </Text>
    </ScrollView>
  );
}

/** Compact room for phones: wall, table with the files, no 3D (battery, small screens). */
function RoomHeader({ c, title, host, files, type }: { c: C; title: string; host: string | null; files: number; type: string }) {
  return (
    <View style={[s.room, { backgroundColor: c.wall }]} accessibilityRole="header" accessibilityLabel={`${title}, ${type}${host ? `, hosted by ${host}` : ''}, ${files} files`}>
      <View style={s.wall}><Text style={s.wallTitle}>{host ? `${host}’s room` : title}</Text><Text style={s.wallSub}>{type}</Text></View>
      <View style={[s.table, { backgroundColor: c.wood }]}>
        {Array.from({ length: Math.min(files, 6) }, (_, i) => <View key={i} style={[s.paper, { transform: [{ rotate: `${(i % 3) * 4 - 4}deg` }] }]} />)}
        {files === 0 && <Text style={s.tableEmpty}>No files yet</Text>}
      </View>
      <View style={[s.floorStrip, { backgroundColor: c.floor }]} />
    </View>
  );
}

function InClass({ c, joined: first, onLeave }: { c: C; joined: PairedJoin; onLeave(): void }) {
  const [joined, setJoined] = useState(first);
  const [status, setStatus] = useState<MemberStatus>(joined.status);
  const [info, setInfo] = useState<ClassroomInfo>(joined.classroom);
  const [quality, setQuality] = useState<Quality>('disconnected');
  const [closed, setClosed] = useState(false);
  const [resources, setResources] = useState<ResourceView[]>([]);
  const [assignments, setAssignments] = useState<StudentAssignmentView[]>([]);
  const [pushed, setPushed] = useState<string | null>(null);
  const [presenting, setPresenting] = useState<PresentationView | null>(null);
  const [people, setPeople] = useState<{ name: string; handle: string; host: boolean }[]>([]);
  const ref = useRef<ClassroomConnection | null>(null);
  const chatConn = useMemo(() => ({ url: joined.url, token: joined.token, sessionId: joined.classroom.sessionId, classTitle: joined.classroom.title, transport: joined.transport as PinnedNativeTransport, teacherPublicKey: joined.binding.teacherPublicKey }), [joined]);
  const chat = useMobileChat(chatConn, joined.classroom.clanId ?? joined.classroom.sessionId, useCallback((m: ClientMessage) => ref.current?.send(m), []));
  const chatRef = useRef(chat);
  chatRef.current = chat;
  useEffect(() => {
    const conn = new ClassroomConnection(joined.url, joined.token, {
      onMessage: (m) => {
        chatRef.current.onServer(m);
        if (m.t === 'members') setPeople(m.members);
        if (m.t === 'hello') { setInfo(m.classroom); if (m.status) setStatus(m.status); }
        if (m.t === 'class.state') setInfo(m.classroom);
        if (m.t === 'member.status') setStatus(m.status);
        if (m.t === 'resources') setResources(m.resources as ResourceView[]);
        if (m.t === 'assignments') setAssignments(m.assignments as StudentAssignmentView[]);
        if (m.t === 'resource.push' || m.t === 'resource.seed') setPushed(m.resourceId);
        if (m.t === 'presentation') setPresenting(m.state);
      },
      onQuality: setQuality,
      onClosed: (reason) => {
        // Token expired: prove the device key again over the pinned channel (no code), once.
        if (/expired|invalid/.test(reason) && joined === first) {
          deviceSigner().then((device) => reconnect({ url: joined.url, transport: joined.transport, sessionId: joined.classroom.sessionId, device }))
            .then((r) => setJoined({ ...joined, ...r }), () => setClosed(true));
        } else setClosed(true);
      },
    }, 5000, joined.transport);
    ref.current = conn;
    return () => conn.close();
  }, [joined]);
  const send = useCallback((m: ClientMessage) => ref.current?.send(m), []);
  const [device, setDevice] = useState<DeviceSigner>();
  useEffect(() => { deviceSigner().then(setDevice); }, []);
  const conn = useMemo(() => ({ url: joined.url, token: joined.token, sessionId: joined.classroom.sessionId, classTitle: joined.classroom.title,
    transport: joined.transport as PinnedNativeTransport, teacherPublicKey: joined.binding.teacherPublicKey, peerAssist: info.peerAssist, device }), [joined, info.peerAssist, device]);

  const L = clanLabels(info.clanType);
  const over = info.ended ? `The ${L.session} has ended.` : status === 'rejected' ? `The ${L.host.toLowerCase()} declined your request.` : status === 'removed' ? `You were removed from this ${L.session}.`
    : status === 'blocked' ? `This device was blocked from this ${L.session}.` : closed ? 'Your session expired. Join again with the code.' : '';

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={[s.h1, { color: c.text }]}>{info.title}</Text>
      <Text style={{ color: c.muted }}>{L.type}</Text>
      {over ? (
        <><Text style={{ color: c.text, fontSize: 17 }}>{over}</Text><Button c={c} primary label="OK" onPress={onLeave} /></>
      ) : status === 'pending' ? (
        <><ActivityIndicator size="large" /><Text style={{ color: c.text, fontSize: 17, textAlign: 'center' }}>Waiting for the {L.host.toLowerCase()} to let you in…</Text><Button c={c} label="Cancel" onPress={onLeave} /></>
      ) : (
        <>
          <View style={[s.pill, { borderColor: c.border }]}>
            <View style={[s.dot, { backgroundColor: quality === 'disconnected' ? c.danger : quality === 'poor' ? c.warn : c.ok }]} />
            <Text style={{ color: c.text }}>{QUALITY[quality]}</Text>
          </View>
          <RoomHeader c={c} title={info.title} host={info.hostName} files={resources.length} type={L.type} />
          {presenting && (
            // ponytail: phones show who is presenting but can't view yet — LiveKit signaling is binary and the pinned native socket is text-only (docs/MEDIA.md).
            <View accessibilityLiveRegion="polite" style={[s.pill, { borderColor: c.border }]}>
              <Text style={{ color: c.text }}>{`${presenting.presenterName} is presenting their ${presenting.source}${presenting.state === 'reconnecting' ? ' (reconnecting…)' : ''}. Viewing on phones is coming soon — use a computer to watch.`}</Text>
            </View>
          )}
          <ChatSection c={c} chat={chat} conn={conn} people={people} />
          <InboxCard c={c} onSend={(it) => { const g = chat.threads.find((t) => t.kind === 'group'); if (g) chat.post(g.id, it.kind === 'text' ? it.text : '', it.kind === 'url' ? { attachment: { kind: 'link', url: it.url, ...(it.title ? { title: it.title } : {}) } } : {}); }} />
          <ClassContent c={c} conn={conn} resources={resources} assignments={assignments} pushed={pushed} send={send} />
          <Button c={c} label={`Leave ${L.session}`} onPress={onLeave} />
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

// From the shared CLAN palette (packages/design/src/palette.ts = tokens.css).
const theme = (p: typeof light | typeof dark) => ({ bg: p.paper, surface: p.surface, text: p.ink, muted: p.ink3, border: p.line, accent: p.ink, danger: p.brick, ok: p.campus, warn: p.notebook, wall: p.wall, floor: p.floor, wood: p.wood, study: p.study, brick: p.brick, campus: p.campus });
const lightColors = theme(light);
const darkColors: C = theme(dark);

const s = StyleSheet.create({
  room: { borderRadius: 20, overflow: 'hidden', paddingTop: 12, alignItems: 'center' },
  wall: { width: '86%', borderRadius: 10, backgroundColor: '#23302b', borderWidth: 6, borderColor: '#3a2c22', paddingVertical: 14, alignItems: 'center' },
  wallTitle: { color: '#f3efe4', fontSize: 17, fontWeight: '700' }, wallSub: { color: '#f3efe4', opacity: 0.75, marginTop: 2 },
  table: { width: '78%', minHeight: 56, borderRadius: 22, marginTop: 14, flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'center', padding: 10, zIndex: 1 },
  paper: { width: 26, height: 32, borderRadius: 3, backgroundColor: '#fffbf3' }, tableEmpty: { color: '#fff8ec', fontWeight: '600' },
  floorStrip: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 40 },
  fill: { flex: 1 },
  page: { padding: 20, gap: 14, flexGrow: 1, justifyContent: 'center' },
  h1: { fontSize: 28, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 12, padding: 14, fontSize: 17 },
  code: { borderWidth: 1, borderRadius: 14, padding: 16, fontSize: 40, letterSpacing: 12, textAlign: 'center', fontVariant: ['tabular-nums'] },
  btn: { borderWidth: 1, borderRadius: 14, paddingVertical: 16, alignItems: 'center', minHeight: 52 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 99, paddingHorizontal: 14, paddingVertical: 8, alignSelf: 'flex-start' },
  dot: { width: 10, height: 10, borderRadius: 5 },
});

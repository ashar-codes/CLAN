import { PhoneMeeting } from './media/Meeting';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ClassroomConnection, SessionGate, leaveClanSession, pairAndJoin, reconnect, TransferError, type Candidate, type DeviceSigner, type PairedJoin, type Quality } from '@classroom/client';
import { clanLabels, decodeDirectQr, shortFingerprint, StudentProfile, type DirectPackage, type ClassroomInfo, type ClientMessage, type MemberStatus, type PresentationView, type ResourceView, type StudentAssignmentView } from '@classroom/protocol';
import { ClassContent } from './ClassContent';
import { pauseSession } from './transfers';
import { ChatSection, useMobileChat } from './Chat';
import { MobileBoard, useMobileBoard } from './board/Board';
import { me as meP, openPhoneClan, phoneClan } from './core/clan';
import { keyFingerprint } from '@classroom/protocol';
import { migrateOldPhoneData } from './core/migrate';
import { setupPhoneSync, startSyncSchedule } from './sync/phone';
import { bump, ThemeRoot } from './ui/kit';
import { onPeopleNotification } from './people/notifications';
import { PeopleScreen } from './screens/People';
import { PhoneCallProvider } from './people/Call';
import { Shell } from './Shell';
import { PresentationCard } from './media/Watch';
import { IntakeScreen, useIncomingShare } from './share/Intake';
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
  const [ready, setReady] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  useEffect(() => onPeopleNotification(() => { if (joined) setNotice(true); }), [joined]);
  const [share, clearShare] = useIncomingShare();

  useEffect(() => { loadProfile().then((p) => { setProfile(p); if (!StudentProfile.safeParse(p).success) setEditing(true); })
    .catch((e) => setReady(`CLAN could not open its secure identity: ${(e as Error).message}`)); }, []);
  // CLAN core (encrypted database) opens once the profile exists; then personal sync runs while the app is in front.
  useEffect(() => {
    if (!profile?.fullName || editing) return;
    let stop = () => {};
    openPhoneClan(profile.fullName).then(async (c) => {
      await setupPhoneSync(profile.deviceName ?? 'Phone');
      await migrateOldPhoneData().catch(() => {});
      c.sync.onApplied(() => bump());
      stop = startSyncSchedule();
      setReady('ok');
    }).catch((e) => setReady(`CLAN could not open its data: ${(e as Error).message}`));
    return () => stop();
  }, [profile?.fullName, editing]);
  if (!profile) return ready ? <SafeAreaProvider><SafeAreaView style={[s.fill, { backgroundColor: c.bg, padding: 24 }]}><Text style={{ color: c.text }} accessibilityRole="alert">{ready}</Text></SafeAreaView></SafeAreaProvider> : null;

  return (
    <SafeAreaProvider><SafeAreaView style={[s.fill, { backgroundColor: c.bg }]} edges={['top', 'bottom', 'left', 'right']}>
      <OpaqueBridgeHost />
      <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ThemeRoot><PhoneCallProvider>
        {editing ? (
          <ProfileForm c={c} initial={profile} onSaved={(p) => { setProfile(p); setEditing(false); }} />
        ) : joined ? (
          <InClass c={c} joined={joined} onLeave={() => setJoined(null)} />
        ) : ready === 'ok' ? (
          <Shell onEditProfile={() => setEditing(true)} intake={share ? <IntakeScreen share={share} onDone={clearShare} /> : undefined} join={<JoinScreen c={c} profile={profile as StudentProfile} onJoined={setJoined} onEdit={() => setEditing(true)} />} />
        ) : ready ? <Text style={{ color: c.danger, padding: 20 }}>{ready}</Text> : <ActivityIndicator style={{ marginTop: 80 }} size="large" />}
        {notice && joined && ready === 'ok' && <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: c.bg }}><Pressable onPress={() => setNotice(false)} accessibilityRole="button"><Text style={{ color: c.text, padding: 16 }}>Return to CLAN</Text></Pressable><PeopleScreen onJoin={() => Alert.alert('Already in a CLAN', 'Return to your current CLAN and leave it before joining another.')} /></View>}
        </PhoneCallProvider></ThemeRoot>
      </KeyboardAvoidingView>
    </SafeAreaView></SafeAreaProvider>
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
  const [address, setAddress] = useState('');
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
    const discoveryStarted = performance.now();
    try {
      let candidates = foundRef.current;
      // a typed host address (as the host's screen shows it) when this Wi-Fi blocks discovery
      if (/^\d+\.\d+\.\d+\.\d+:\d{2,5}$/.test(address.trim())) candidates = [{ url: `http://${address.trim()}` }, ...candidates];
      if (qr) {
        if (!associator) throw Object.assign(new TransferError('direct_manual', 'Join the CLAN network in Settings, then try again.'), { direct: qr });
        await associator(qr);
        candidates = [{ url: `http://${qr.host}:${qr.bootstrapPort}`, sid: qr.sessionId }];
      }
      // Bluetooth (and Android's location prompt it needs) only when the host wasn't found or typed in
      const carriers = qr || candidates.length ? [] : (await bleAllowed()) ? await bleCarriers() : [];
      for (let i = 0; i < 12 && candidates.length === 0 && carriers.length === 0; i++) { await new Promise((r) => setTimeout(r, 250)); candidates = foundRef.current; }
      // Same secure flow as desktop: OPAQUE (official WASM in the isolated WebView) -> MACed binding -> pinned native TLS.
      onJoined(await pairAndJoin({ candidates, candidatesNow: qr || address.trim() ? undefined : () => foundRef.current, discoveryWindowMs: Math.max(0, 3000-(performance.now()-discoveryStarted)), carriers, associate: associator, code, profile, device: await deviceSigner(), opaque: opaqueClient(), transportFor: pinnedNativeTransport }));
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
      <TextInput style={[s.input, { color: c.text, borderColor: c.border, backgroundColor: c.surface }]} value={address} onChangeText={setAddress} placeholder="Host address (only if not found)" placeholderTextColor={c.muted} autoCapitalize="none" keyboardType="numbers-and-punctuation" accessibilityLabel="Host address" />
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

/** This phone's core learns which CLAN it joined (as the desktop does); a Classroom gets its linked Course. */
async function recordJoined(j: PairedJoin, info: ClassroomInfo) {
    const c = phoneClan();
    c.clans.recordJoined({ id: info.clanId ?? info.sessionId, type: info.clanType, name: info.title, hostDeviceId: keyFingerprint(j.binding.teacherPublicKey), hostName: info.hostName ?? `${info.title} host`, expiresAt: info.expiresAt ?? null, me: c.me, sessionId: info.sessionId });
    // Persistent-hosting CLAN: anchor the owner from this authenticated session and check its host (see desktop clan:joined).
    await c.hosting.verifySession({ clanId: info.clanId ?? info.sessionId, sessionId: info.sessionId, teacherPublicKey: j.binding.teacherPublicKey, authority: info.authority });
    if (info.clanType === 'CLASSROOM') c.courses.linkClassrooms(meP());
}

function InClass({ c, joined: first, onLeave }: { c: C; joined: PairedJoin; onLeave(): void }) {
  const [leaving, setLeaving] = useState(false);
  const [handSupported, setHandSupported] = useState(false);
  const [handRaised, setHandRaised] = useState(false), [handError, setHandError] = useState('');
  const [joined, setJoined] = useState(first);
  const [status, setStatus] = useState<MemberStatus>(joined.status);
  const [info, setInfo] = useState<ClassroomInfo>(joined.classroom);
  const [quality, setQuality] = useState<Quality>('disconnected');
  const [wasUp, setWasUp] = useState(false); // "Reconnecting…" only after the connection has been up once
  useEffect(() => { if (quality !== 'disconnected') setWasUp(true); }, [quality]);
  const [closed, setClosed] = useState(false);
  const [hostFailure, setHostFailure] = useState(''), [hostConfirmed, setHostConfirmed] = useState(false);
  const [resources, setResources] = useState<ResourceView[]>([]);
  const [assignments, setAssignments] = useState<StudentAssignmentView[]>([]);
  const [pushed, setPushed] = useState<string | null>(null);
  const [presenting, setPresenting] = useState<PresentationView | null>(null);
  const [people, setPeople] = useState<{ name: string; handle: string; host: boolean }[]>([]);
  const ref = useRef<ClassroomConnection | null>(null);
  const gateRef = useRef<SessionGate | null>(null);
  const chatConn = useMemo(() => ({ url: joined.url, token: joined.token, sessionId: joined.classroom.sessionId, classTitle: joined.classroom.title, transport: joined.transport as PinnedNativeTransport, teacherPublicKey: joined.binding.teacherPublicKey }), [joined]);
  const chat = useMobileChat(chatConn, joined.classroom.clanId ?? joined.classroom.sessionId, useCallback((m: ClientMessage) => { if (gateRef.current?.confirmed) ref.current?.send(m); }, []));
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const boardRef = useRef<ReturnType<typeof useMobileBoard> | null>(null);
  useEffect(() => {
    setHostConfirmed(false);
    const gate = new SessionGate({
      verify: async (hello) => { if (hello.status === 'approved') await recordJoined(joined, hello.classroom); },
      failed: () => { setHostConfirmed(false); setHostFailure('This session could not be verified as run by the CLAN’s current host. Leave and contact the owner.'); ref.current?.close(); pauseSession(joined.classroom.sessionId); },
      message: (m) => {
        if (m.t.startsWith('wb.')) return boardRef.current?.onServer(m as never);
        if (m.t === 'hello') boardRef.current?.connected();
        chatRef.current.onServer(m);
        if (m.t === 'hands') { setHandSupported(true); setHandRaised(m.mine); setHandError(''); }
        if (m.t === 'error' && ['rate_limited', 'forbidden'].includes(m.code)) setHandError(m.message);
        if (m.t === 'members') setPeople(m.members);
        if (m.t === 'hello') { setHostConfirmed(true); setInfo(m.classroom); if (m.status) setStatus(m.status); }
        if (m.t === 'class.state') setInfo(m.classroom);
        if (m.t === 'member.status') { setStatus(m.status); if (m.status === 'approved') setHostConfirmed(true); }
        if (m.t === 'resources') setResources(m.resources as ResourceView[]);
        if (m.t === 'assignments') { setAssignments(m.assignments as StudentAssignmentView[]); try { phoneClan().assignments.seen(meP(), joined.classroom.clanId ?? joined.classroom.sessionId, m.assignments); } catch { /* projection only; never blocks the class */ } }
        if (m.t === 'resource.push' || m.t === 'resource.seed') setPushed(m.resourceId);
        if (m.t === 'presentation') setPresenting(m.state);
      },
    });
    gateRef.current = gate;
    const conn = new ClassroomConnection(joined.url, joined.token, {
      onMessage: (m) => { void gate.push(m); },
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
    return () => { gate.stop(); conn.close(); };
  }, [joined]);
  const send = useCallback((m: ClientMessage) => { if (gateRef.current?.confirmed) ref.current?.send(m); }, []);
  const board = useMobileBoard(send, joined.memberId);
  boardRef.current = board;
  const [device, setDevice] = useState<DeviceSigner>();
  useEffect(() => { deviceSigner().then(setDevice); }, []);
  const conn = useMemo(() => ({ url: joined.url, token: joined.token, sessionId: joined.classroom.sessionId, classTitle: joined.classroom.title,
    transport: joined.transport as PinnedNativeTransport, teacherPublicKey: joined.binding.teacherPublicKey, peerAssist: info.peerAssist, device }), [joined, info.peerAssist, device]);

  const L = clanLabels(info.clanType);
  const over = hostFailure || (info.ended ? `The ${L.session} has ended.` : status === 'rejected' ? `The ${L.host.toLowerCase()} declined your request.` : status === 'removed' ? `You were removed from this ${L.session}.`
    : status === 'blocked' ? `This device was blocked from this ${L.session}.` : closed ? 'Your session expired. Join again with the code.' : '');

  return (
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <Text style={[s.h1, { color: c.text }]}>{info.title}</Text>
      <Text style={{ color: c.muted }}>{L.type}</Text>
      {over ? (
        <><Text style={{ color: c.text, fontSize: 17 }}>{over}</Text><Button c={c} primary label="OK" onPress={onLeave} /></>
      ) : !hostConfirmed ? (
        <><ActivityIndicator /><Text style={{ color: c.text }}>Checking the CLAN host…</Text><Button c={c} label="Leave" onPress={onLeave} /></>
      ) : status === 'pending' ? (
        <><ActivityIndicator size="large" /><Text style={{ color: c.text, fontSize: 17, textAlign: 'center' }}>Waiting for the {L.host.toLowerCase()} to let you in…</Text><Button c={c} label="Cancel" onPress={onLeave} /></>
      ) : (
        <>
          <View style={[s.pill, { borderColor: c.border }]}>
            <View style={[s.dot, { backgroundColor: quality === 'disconnected' ? c.danger : quality === 'poor' ? c.warn : c.ok }]} />
            <Text style={{ color: c.text }}>{quality === 'disconnected' && !wasUp ? 'Connecting…' : QUALITY[quality]}</Text>
          </View>
          <RoomHeader c={c} title={info.title} host={info.hostName} files={resources.length} type={L.type} />
          {presenting && <PresentationCard c={c} presenting={presenting} conn={{ url: joined.url, token: joined.token, transport: joined.transport as PinnedNativeTransport }} />}
          {board.view?.wall === 'WHITEBOARD' && !presenting && <MobileBoard c={c} board={board} title={`${info.title} board`} />}
          <ChatSection c={c} chat={chat} conn={conn} people={people} canSendFiles={info.clanType !== 'CLASSROOM' || (info.fileSharingPolicy ?? 'teacher') !== 'teacher'} />
          <ClassContent c={c} conn={conn} resources={resources} assignments={assignments} pushed={pushed} send={send} />
          <PhoneMeeting conn={{url:joined.url,token:joined.token,transport:joined.transport as PinnedNativeTransport}} />
          {handSupported && <Button c={c} disabled={quality === 'disconnected'} label={handRaised ? 'Lower hand' : 'Raise hand'} onPress={() => send({ t: 'hand.set', raised: !handRaised })} />}
          {!!handError && <Text accessibilityRole="alert" style={{ color: c.danger }}>{handError}</Text>}
          <Button c={c} label={`Leave ${L.session}`} onPress={onLeave} />
          <Button c={c} label={leaving ? 'Leaving membership…' : 'Leave membership'} onPress={() => {
            if (leaving) return;
            Alert.alert('Leave CLAN membership?', 'Personal data and stored copies stay. If the host is unavailable, remote revocation cannot be confirmed.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Leave', style: 'destructive', onPress: () => { void (async () => {
              const clanId = info.clanId ?? info.sessionId;
              try { phoneClan().clans.leave(clanId, phoneClan().me); bump(); }
              catch (e) { Alert.alert('Cannot leave', (e as Error).message); return; }
              setLeaving(true); ref.current?.close(); pauseSession(conn.sessionId);
              let confirmed = false, timer: ReturnType<typeof setTimeout> | undefined;
              // Limit the UI wait. The small native request may finish later; it can only revoke this caller.
              try { const ack = await Promise.race([leaveClanSession(joined.transport, joined.url, joined.token, clanId), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 5000); })]); confirmed = ack?.left === true && ack.clanId === clanId && ack.sessionId === info.sessionId; } catch { /* local leave remains valid; never claim remote revocation */ }
              finally { if (timer) clearTimeout(timer); }
              if (!confirmed) Alert.alert('Left on this phone', 'The host did not confirm remote revocation. It may retain your session rights until they expire.');
              onLeave();
            })(); } }]);
          }} />
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

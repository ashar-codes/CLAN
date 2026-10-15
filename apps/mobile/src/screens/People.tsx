import { saveDirectory, directoryStatus, directoryEnrollmentKey } from '../people/directory';
// People on the phone: visibility and Nearby availability, codes (show and scan), direct connections without a router
// (Wi-Fi Direct, Wi-Fi Aware, Apple peer-to-peer, hotspots), friends and requests, personal chats with files and voice
// notes, calls, and QR file transfer.
import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { parseProfileQr, profileQr, safetyNumber, TEMP_TTLS } from '@classroom/protocol';
import { browse, clanDiscoveryStatus } from '../discovery';
import type { Candidate } from '@classroom/client';
import { Radar } from '../ui/Radar';
import type { Contact } from '@clan/core';
import { phoneClan, me } from '../core/clan';
import { allowPeopleNotifications, takePeopleChat, onPeopleNotification } from '../people/notifications';
import { phonePeople } from '../people/native';
import { PeerLink } from '../../modules/peer-link';
import { discoveryDiagnostics, nearby, parseWifiQr, wifiQr } from '../people/nearby';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { QrImage, QrScanner } from '../ui/qr';
import { OpticalScreen } from './Optical';
import { usePhoneCall } from '../people/Call';
import { ChatView } from '../people/ChatView';
import { pushStatus, pushTick, selfTestWake } from '../people/push';
import { act, bump, Btn, Card, Err, Field, H1, Muted, PersonPic, Row, Screen, useC, useData } from '../ui/kit';

type Seg = 'nearby' | 'chats' | 'friends';
const people = () => phoneClan().people;
const REL: Record<string, string> = { friend: 'Friend', incoming: 'Asked to be friends', outgoing: 'Request sent', none: '' };
const ttlText = (ms: number | null) => !ms ? 'Saved chat' : ms <= 3_600_000 ? 'Disappears after 1 hour' : ms <= 86_400_000 ? 'Disappears after 24 hours' : 'Disappears after 7 days';

export function PeopleScreen({ onJoin }: { onJoin(): void }) {
  const [seg, setSeg] = useState<Seg>('chats'), [chat, setChat] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  useEffect(() => { void phonePeople().catch((e) => setErr((e as Error).message)); }, []);
  const unread = useData(() => people().conversations().reduce((n, c) => n + c.unread + (c.state === 'invited_in' ? 1 : 0), 0)) ?? 0;
  const requests = useData(() => people().contacts('requests').filter((r) => r.relation === 'incoming').length) ?? 0;
  useEffect(() => { const open = (id: string | null) => { if (id) { setChat(id); setSeg('chats'); } }; open(takePeopleChat()); return onPeopleNotification(open); }, []);
  const open = (id: string) => { setChat(id); setSeg('chats'); };
  const [optical, setOptical] = useState(false);
  if (optical) return <OpticalScreen onBack={() => setOptical(false)} />;
  if (chat) return <ChatView id={chat} onBack={() => setChat(null)} />;
  return (
    <Screen>
      <H1>People</H1>
      <Row gap={6}>
        <Btn small label="Nearby" on={seg === 'nearby'} onPress={() => setSeg('nearby')} />
        <Btn small label={unread ? `Chats · ${unread}` : 'Chats'} on={seg === 'chats'} onPress={() => setSeg('chats')} />
        <Btn small label={requests ? `Friends · ${requests}` : 'Friends'} on={seg === 'friends'} onPress={() => setSeg('friends')} />
      </Row>
      <Err msg={err} />
      {seg === 'nearby' ? <Nearby onJoin={onJoin} onChat={open} onOptical={() => setOptical(true)} /> : seg === 'friends' ? <Friends onChat={open} /> : <ChatList onOpen={open} />}
    </Screen>
  );
}

function Nearby({ onJoin, onChat, onOptical }: { onJoin(): void; onChat(id: string): void; onOptical(): void }) {
  const c = useC();
  const [scan, setScan] = useState(false), [show, setShow] = useState<null | 'profile' | 'friend' | 'chat'>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null), [ok, setOk] = useState<string | null>(null);
  const [directoryText, setDirectoryText] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [pendingWifi, setPendingWifi] = useState<{ ssid: string; passphrase: string } | null>(null);
  const [connected, setConnected] = useState<{ key: string; intent: string } | null>(null);
  const met = useData(() => people().contacts('all').filter((x) => x.relation === 'none').slice(0, 20)) ?? [];
  const vis = useData(() => people().visibility());
  const myCode = useData(() => show ? profileQr({ key: people().myKey(), endpoints: [], links: nearby.myAddrs(), name: people().myProfile().name, invite: people().inviteToken(), intent: show }) : null);
  const entries = useData(() => [...nearby.entries.values()].sort((x, y) => Number(y.friend) - Number(x.friend))) ?? [];
  const caps = nearby.caps;
  const prefs = useData(() => phoneClan().notifications.prefs(me()));
  const [radarMode, setRadarMode] = useState<'people' | 'clans'>('people'), [clans, setClans] = useState<Candidate[]>([]);
  useEffect(() => radarMode === 'clans' ? browse(setClans) : undefined, [radarMode]);
  const run = async (f: () => Promise<unknown>, done?: string) => { setBusy(true); setErr(null); setOk(null); try { await f(); if (done) setOk(done); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); bump(); } };
  /** Every CLAN code this phone understands, from the camera or a picture. */
  const onCode = (t: string) => {
    if (t.startsWith('clan://p/')) {
      setScan(false);
      void run(async () => { const x = await (await phonePeople()).connectQr(t); const q = parseProfileQr(t); setConnected({ key: x.key, intent: q?.intent ?? 'profile' }); setOk(`Connected to ${x.name}. Their identity matched the code.`); });
      return true;
    }
    const wifi = parseWifiQr(t);
    if (wifi) { setScan(false); setPendingWifi(wifi); return true; }
    if (t.startsWith('CLQ1') || t.startsWith('clan://qrx/')) { setScan(false); onOptical(); return true; }
    if (t.startsWith('clan://link?')) { setScan(false); setOk('That is a device-link code. Open Me › My Devices › Link to use it.'); return true; }
    if (t.startsWith('clan://direct#')) { setScan(false); void Linking.openURL(t); return true; } // joining a CLAN Direct network (existing flow)
    setErr('That code is not a CLAN code.');
  };
  const intended = connected && people().contact(connected.key);
  return (
    <>
      <Card title="Connect with a code">
        <Field label="CLAN profile code" autoCapitalize="none" autoCorrect={false} value={manualCode} onChange={setManualCode} maxLength={2000} />
        <Btn label="Connect using profile code" disabled={busy || !manualCode.trim()} onPress={() => { const code = manualCode.trim(); if (!parseProfileQr(code)) { setErr('Enter a valid CLAN profile code from the other person.'); return; } onCode(code); }} />
        <Row gap={6}>
          <Btn primary label="Scan a code" onPress={() => { setScan(true); setShow(null); }} />
          <Btn label="Show my code" onPress={() => { setShow('profile'); setScan(false); }} />
          <Btn label="QR file transfer" onPress={onOptical} />
        </Row>
        {scan && <QrScanner hint="A person’s code, a hotspot’s Wi-Fi code, a CLAN or a QR transfer." onClose={() => setScan(false)} onCode={onCode} />}
        {show && (myCode && nearby.myAddrs().length ? <>
          <Row gap={6}>{(['profile', 'friend', 'chat'] as const).map((x) => <Btn key={x} small on={show === x} label={x === 'profile' ? 'My profile' : x === 'friend' ? 'Friend request' : 'Chat invitation'} onPress={() => setShow(x)} />)}</Row>
          <QrImage text={myCode} label="Your CLAN code" />
          <Muted small>Whoever scans this can reach you on this network, even in Friends Only mode. Make a new code to stop old copies working.</Muted>
          <Btn small label="Make a new code" onPress={() => { people().inviteToken(true); bump(); }} />
        </> : <Muted>{nearby.mode === 'off' ? 'Turn Nearby on to show a code others can connect to.' : 'Join a Wi-Fi or hotspot (or start one below) to show a code others can connect to. QR file transfer works without any network.'}</Muted>)}
        {pendingWifi && <View style={{ gap: 6 }}><Text style={{ color: c.text }}>Join the hotspot “{pendingWifi.ssid}”? CLAN uses it only to reach people on it; it has no internet.</Text>
          <Row><Btn small primary label="Join" onPress={() => { const w = pendingWifi; setPendingWifi(null); void run(() => nearby.joinHotspot(w.ssid, w.passphrase), `Joined ${w.ssid}. People on it appear below.`); }} /><Btn small label="Cancel" onPress={() => setPendingWifi(null)} /></Row></View>}
        {intended && connected!.intent !== 'profile' && <View style={{ gap: 6 }}>
          <Text style={{ color: c.text }}>{intended.name} {connected!.intent === 'friend' ? 'offered to be friends.' : 'invited you to chat.'}</Text>
          {connected!.intent === 'friend' && intended.relation === 'none' && <Btn small primary label="Send friend request" onPress={() => { setConnected(null); setErr(act(() => people().sendFriendRequest(intended.key))); void phonePeople().then((r) => r.tick()); }} />}
          {connected!.intent === 'chat' && <Btn small primary label="Start a chat" onPress={() => { setConnected(null); onChat(people().inviteChat(intended.key)); }} />}
        </View>}
        {ok && <Text accessibilityLiveRegion="polite" style={{ color: c.text }}>{ok}</Text>}<Err msg={err} />
      </Card>
      <Card title="Notifications"><Row>{(['direct', 'files', 'previews'] as const).map((key) => <Btn small key={key} label={`${key === 'direct' ? 'Messages & calls' : key === 'files' ? 'Files' : 'Notification previews'}: ${prefs?.[key] ? 'On' : 'Off'}`} on={!!prefs?.[key]} onPress={() => { phoneClan().notifications.setPrefs(me(), { [key]: !prefs?.[key] }); bump(); }} />)}</Row><Btn label={`Friend nearby alerts: ${people().nearbyAlerts() ? 'On' : 'Off'}`} on={people().nearbyAlerts()} onPress={() => void run(async () => { const on = !people().nearbyAlerts(); if (on && !await allowPeopleNotifications()) throw new Error('Allow notifications first.'); people().nearbyAlerts(on); })} /><Btn label="Enable message and call notifications" onPress={() => void run(async () => { if (!await allowPeopleNotifications()) throw new Error('Notifications are denied. Allow them in system settings.'); phoneClan().notifications.setPrefs(me(), { direct: true }); }, 'Message and call notifications enabled.')} /><Muted small>Notification previews follow your privacy preferences.</Muted></Card>
      <AutoDownloadCard />
      <PushCard />
      <Card title="Who can find you">
        <Row gap={6}>
          <Btn small label="Everyone nearby" on={vis === 'everyone'} onPress={() => setErr(act(() => people().setVisibility('everyone')))} />
          <Btn small label="Friends only" on={vis === 'friends'} onPress={() => setErr(act(() => people().setVisibility('friends')))} />
          <Btn small label="Invisible" on={vis === 'invisible'} onPress={() => setErr(act(() => people().setVisibility('invisible')))} />
        </Row>
        <Muted small>{vis === 'everyone' ? 'People on this network see your name, picture and the fields you mark for everyone, and can send you a friend or chat request. It stays on until you change it.' : vis === 'friends' ? 'Only friends can find you. Others can still reach you through your code.' : 'Nobody can find you nearby. You can still scan codes.'} People you block can't contact you, but in Everyone Nearby anyone on this network can see you — choose Friends Only or Invisible to hide. Your network’s administrator may see that a CLAN device is present.</Muted>
        {vis === 'everyone' && <Btn small label="Only for the next hour" onPress={() => setErr(act(() => people().setVisibility('everyone', 3_600_000)))} />}
        <Muted>Nearby on this phone</Muted>
        <Row gap={6}>
          <Btn small label="Off" on={nearby.mode === 'off'} onPress={() => nearby.setMode('off')} />
          <Btn small label="While using CLAN" on={nearby.mode === 'app'} onPress={() => nearby.setMode('app')} />
          {Platform.OS === 'android' && <Btn small label="Keep CLAN Available" on={nearby.mode === 'keep'} onPress={() => void run(async () => { if (!await allowPeopleNotifications()) throw new Error('Notifications are required for visible background availability.'); if (!await nearby.permissions()) throw new Error('Allow Nearby devices and notifications in Settings.'); nearby.setMode('keep'); await phonePeople(); })} />}
          <Btn small label="Stay available in a session" on={nearby.mode === 'session'} onPress={() => void run(async () => { if (Platform.OS === 'android' && !await allowPeopleNotifications()) throw new Error('Allow notifications for a visible background session.'); nearby.setMode('session'); })} />
        </Row>
        <Muted small>{Platform.OS === 'android' ? 'Keep CLAN Available receives local messages with a persistent notification, even without an open chat. Uses more battery; Android/MIUI battery restrictions or force-stop can interrupt it. Stop from the notification or select While using CLAN.' : 'iPhone keeps a session only while CLAN is open (plus a short moment after you leave, and during a call). Nobody can reach you while CLAN is closed.'}</Muted>
      </Card>

      <DiagnosticsCard>
        <Muted>{Platform.OS === 'android' ? PeerLink?.availabilityRunning() ? 'Background service active' : 'Background service disabled' : 'Limited by iOS: reopen CLAN to reconnect after suspension'}</Muted>
        {Platform.OS === 'android' && <Muted small>{PeerLink?.availabilityHealth?.().backgroundRestricted ? 'Android restricts background operation. Review CLAN battery settings.' : PeerLink?.availabilityHealth?.().batteryOptimized ? 'Battery optimization is enabled; Android or manufacturer policies may interrupt availability.' : 'Android battery optimization exemption is enabled; force-stop still prevents incoming calls.'}</Muted>}
        <Muted small>Network isolation and firewall rules can prevent connection even when discovery works. No media starts until you accept. Keep mode does not survive force-stop or a terminated app process.</Muted>
      </DiagnosticsCard>



      <Card title="No Wi-Fi network?">
        {Platform.OS === 'ios' ? <Muted>iPhones with CLAN open find each other directly (Apple peer-to-peer Wi-Fi) — keep Wi-Fi and Bluetooth on; no network needed. For Android or a computer, join their hotspot by scanning its Wi-Fi code, or turn on Settings › Personal Hotspot.</Muted>
          : <Muted>Phones can connect directly. Choose what both phones support; the other person must be on this screen too.</Muted>}
        <Row gap={6}>
          {caps?.wifiDirect && <Btn small label="Wi-Fi Direct" disabled={busy} onPress={() => void run(() => nearby.startDirect())} />}
          {caps?.wifiAware && <Btn small label="Wi-Fi Aware" disabled={busy || !caps.wifiAwareAvailable} onPress={() => void run(() => nearby.startAware())} />}
          {caps?.localHotspot && !nearby.hotspot && <Btn small label="Start a hotspot" disabled={busy} onPress={() => void run(() => nearby.startHotspot())} />}
          {nearby.hotspot && <Btn small label="Stop hotspot" onPress={() => nearby.stopHotspot()} />}
          <Btn small label="Join a hotspot" onPress={() => { setScan(true); setShow(null); }} />
        </Row>
        {caps?.wifiAware && !caps.wifiAwareAvailable && <Muted small>Wi-Fi Aware is supported but off right now (turn on Wi-Fi and Location).</Muted>}
        {!caps && <Muted small>This build has no direct-connection module; use the same Wi-Fi, a hotspot or QR transfer.</Muted>}
        {nearby.hotspot && <View style={{ gap: 6 }}><Muted>Others scan this to join your hotspot (no internet; it closes when you stop it):</Muted><QrImage text={wifiQr(nearby.hotspot.ssid, nearby.hotspot.passphrase)} size={200} label="Hotspot Wi-Fi code" /><Muted small>Network {nearby.hotspot.ssid}. Then show them your CLAN code.</Muted></View>}
        {!!nearby.status && <Muted small>{nearby.status}</Muted>}
      </Card>

      <Card title="Optional internal network directory"><Muted>Use your administrator’s public HTTPS configuration after checking its certificate pin. This enrolls your device public key and publishes listening addresses/rotating hints to the trusted administrator; no private chats/files are sent. Invisible stops People advertisements. No gateway forwarding or network scanning.</Muted><Field label="LAN directory configuration" value={directoryText} onChange={setDirectoryText} maxLength={20000} /><Row><Btn label="Enable internal directory" onPress={() => void run(async () => { await phonePeople(); saveDirectory(JSON.parse(directoryText)); }, 'Internal directory enabled. Select While using CLAN or Keep CLAN Available to publish this phone.')} /><Btn label="Disable directory" onPress={() => void run(async () => { saveDirectory(null); }, 'Directory disabled; registration expires within 90 seconds.')} /></Row><Muted>{directoryStatus}</Muted><Muted small>Device enrollment public key: {directoryEnrollmentKey()}</Muted><Muted small>Different routers require permitted internal routing. If discovery fails, use a trusted QR or host address and ask the administrator about isolated VLANs.</Muted></Card>
      <Row><Btn label="People Radar" on={radarMode === 'people'} onPress={() => setRadarMode('people')} /><Btn label="CLAN Radar" on={radarMode === 'clans'} onPress={() => setRadarMode('clans')} /></Row>
      <Radar items={radarMode === 'people' ? entries.map((e) => ({ id: e.id, name: e.name, kind: 'Person', verified: e.friend && !!e.key && !!people().contact(e.key)?.verified })) : clans.map((x) => ({ id: x.sid ?? x.url, name: x.title ?? 'CLAN', kind: `CLAN · ${'discoverySource' in x && x.discoverySource === 'directory' ? 'Internal Network' : 'Nearby'} (not joined)` }))} onSelect={(id) => { if (radarMode === 'clans') onJoin(); else setOk(`Choose the Connect or Chat action for ${entries.find((x) => x.id === id)?.name ?? 'this person'} below.`); }} />
      <Muted small>Real discovery only. Positions do not indicate distance. CLAN discovery is an untrusted hint; joining requires the host's code.</Muted>
      {radarMode === 'clans' && <><Btn primary label="Join or request access by code" onPress={onJoin} />{clans.map((x) => <Card key={x.sid ?? x.url} title={x.title ?? 'CLAN'}><Muted>{'discoverySource' in x && x.discoverySource === 'directory' ? 'Internal Network · Directory hint' : 'Nearby · Same LAN discovery'} · Not joined; host authentication is required.</Muted><Btn label={`Join ${x.title ?? 'CLAN'}`} onPress={onJoin} /></Card>)}{!clans.length && <Muted>No live CLANs found on this network yet. A CLAN appears only while its host is running it. {clanDiscoveryStatus}. If the network blocks discovery, use the host address or QR in Join.</Muted>}</>}
      {radarMode === 'people' && entries.map((e) => (
        <Card key={e.id}>
          <Row><PersonPic pic={e.key ? people().avatarOf(e.key) : null} name={e.name} size={36} /><View style={{ flex: 1 }}><Text style={{ fontWeight: '700', color: c.text }}>{e.name}{e.friend ? ' · friend' : ''}</Text>
            <Muted small>{e.via === 'direct' ? 'Wi-Fi Direct' : e.via === 'aware' ? 'Wi-Fi Aware' : e.via === 'apple' ? 'Apple peer-to-peer' : e.via === 'internal' ? 'Internal Network (directory discovery)' : 'Same LAN'}{e.key && nearby.state(e.key) ? ` · ${STATE[nearby.state(e.key)!]}` : ' · Nearby'}{e.profile?.university ? ` · ${e.profile.university}` : ''}</Muted></View></Row>
          <Row gap={6}>
            {e.via === 'direct' && !e.key && <Btn small label="Connect directly" onPress={() => void run(() => nearby.connectDirect(e))} />}
            {e.via === 'aware' && !e.key && <Btn small label="Connect" onPress={() => void run(() => nearby.connectAware(e.address!.replace('aware-peer:', ''), e))} />}
            {e.key && !e.friend && people().contact(e.key)?.relation === 'none' && <Btn small label="Add friend" onPress={() => void run(async () => { await nearby.connectAs(e); people().sendFriendRequest(e.key!); await nearby.cm?.tick(); }, 'Friend request sent.')} />}
            {e.key && <Btn small label="Chat" onPress={() => void run(async () => { if (!nearby.cm?.connected(e.key!)) await nearby.connectAs(e); const x = people().conversations().find((v) => v.peerKey === e.key && v.state === 'active'); onChat(x ? x.id : people().inviteChat(e.key!)); })} />}
          </Row>
        </Card>
      ))}
      {met.map((x) => <PersonCard key={x.key} c={x} onChat={onChat} />)}
    </>
  );
}
const STATE: Record<string, string> = { connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', offline: 'Offline', failed: 'Failed' };

function PersonCard({ c, onChat }: { c: Contact; onChat(id: string): void }) {
  const calls = usePhoneCall();
  const pic = useData(() => people().avatarOf(c.key));
  const [err, setErr] = useState<string | null>(null), [invite, setInvite] = useState(false), [confirm, setConfirm] = useState<'remove' | 'block' | null>(null);
  const myKey = useData(() => people().myKey());
  const run = (f: () => unknown) => { setErr(act(f)); void phonePeople().then((r) => r.tick()); };
  const p = c.profile;
  const chat = () => { const x = people().conversations().find((v) => v.peerKey === c.key && v.state === 'active'); if (x) onChat(x.id); else setInvite(true); };
  return (
    <Card>
      <Row><PersonPic pic={pic} name={c.name} /><View style={{ flex: 1 }}><Text style={{ fontWeight: '700', fontSize: 16 }}>{c.name}{c.verified ? ' ✓' : ''}</Text>
        <Muted small>{[p?.university, p?.department, p?.course].filter(Boolean).join(' · ') || (REL[c.relation] || (c.blocked ? 'Blocked' : 'Not connected'))}{nearby.state(c.key) ? ` · ${STATE[nearby.state(c.key)!]}` : ''}</Muted></View></Row>
      {p?.bio ? <Muted>{p.bio}</Muted> : null}
      {myKey && <Muted small>Safety number: {safetyNumber(myKey, c.key)}{c.verified ? ' · verified' : ''}</Muted>}
      <Row gap={6}>
        {c.relation === 'none' && !c.blocked && <Btn small label="Add friend" onPress={() => run(() => people().sendFriendRequest(c.key))} />}
        {c.relation === 'incoming' && <><Btn small primary label="Accept" onPress={() => run(() => people().acceptFriend(c.key))} /><Btn small label="Decline" onPress={() => run(() => people().rejectFriend(c.key))} /></>}
        {c.relation === 'outgoing' && <Btn small label="Cancel request" onPress={() => run(() => people().cancelFriendRequest(c.key))} />}
        {!c.blocked && c.relation !== 'incoming' && <Btn small label="Chat" onPress={chat} />}
        {c.relation === 'friend' && !c.blocked && <Btn small label="Call" disabled={calls.active} onPress={() => calls.call(c.key, c.name)} />}
        {!c.verified && !c.blocked && <Btn small label="Numbers match" a11y="The safety numbers match" onPress={() => run(() => people().markVerified(c.key))} />}
        {c.relation === 'friend' && <Btn small label="Remove" onPress={() => setConfirm('remove')} />}
        {c.blocked ? <Btn small label="Unblock" onPress={() => run(() => people().unblock(c.key))} /> : <Btn small danger label="Block" onPress={() => setConfirm('block')} />}
      </Row>
      {confirm && <View style={{ gap: 6 }}><Muted>{confirm === 'remove' ? `Remove ${c.name} as a friend? They are told; your chats stay.` : `Block ${c.name}? They can no longer message you or send files. They are not told.`}</Muted>
        <Row><Btn small danger label={confirm === 'remove' ? 'Remove' : 'Block'} onPress={() => { const a = confirm; setConfirm(null); run(() => a === 'remove' ? people().removeFriend(c.key) : people().block(c.key)); }} /><Btn small label="Cancel" onPress={() => setConfirm(null)} /></Row></View>}
      {invite && <InviteTerms onSend={(mode, ttl) => { setInvite(false); run(() => onChat(people().inviteChat(c.key, mode, ttl))); }} onCancel={() => setInvite(false)} />}
      <Err msg={err} />
    </Card>
  );
}

function InviteTerms({ onSend, onCancel }: { onSend(mode: 'permanent' | 'temporary', ttl: number | null): void; onCancel(): void }) {
  const [ttl, setTtl] = useState<number | null>(null);
  return (
    <View style={{ gap: 6 }} accessibilityLabel="Chat invitation">
      <Muted>How should this chat be kept? They see these terms and choose whether to accept. Either of you can still keep copies.</Muted>
      <Row gap={6}>
        <Btn small label="Saved" on={ttl === null} onPress={() => setTtl(null)} />
        {TEMP_TTLS.map((t) => <Btn key={t} small on={ttl === t} label={t === 3_600_000 ? '1 hour' : t === 86_400_000 ? '24 hours' : '7 days'} onPress={() => setTtl(t)} />)}
      </Row>
      <Row><Btn small primary label="Send invitation" onPress={() => onSend(ttl ? 'temporary' : 'permanent', ttl)} /><Btn small label="Cancel" onPress={onCancel} /></Row>
    </View>
  );
}

function Friends({ onChat }: { onChat(id: string): void }) {
  const list = useData(() => [...people().contacts('requests'), ...people().contacts('friends'), ...people().contacts('blocked')]) ?? [];
  const me = useData(() => people().myProfile());
  const offers = useData(() => people().deviceOffers()) ?? [];
  const c = useC();
  const [name, setName] = useState(me?.name ?? ''), [device, setDevice] = useState(me?.deviceName ?? ''), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {offers.map((o) => (
        <Card key={`${o.fromKey}:${o.key}`} title="A friend’s other device">
          <Text style={{ color: c.text }}><Text style={{ fontWeight: '700' }}>{o.name}</Text> — {o.fromName} says this device is also theirs.</Text>
          <Muted small>Safety number for that device: {o.safety}. If you can, compare it on their device first.</Muted>
          <Row><Btn small primary label={`Trust as ${o.fromName}`} onPress={() => { setErr(act(() => people().acceptDeviceOffer(o.fromKey, o.key))); void phonePeople().then((r) => r.tick()); }} /><Btn small label="Not now" onPress={() => setErr(act(() => people().declineDeviceOffer(o.fromKey, o.key)))} /></Row>
        </Card>
      ))}
      {!list.length && <Muted>No friends yet. Find people in Nearby or scan their code.</Muted>}
      {list.map((c) => <PersonCard key={c.key} c={c} onChat={onChat} />)}
      <Card title="Your profile">
        <Row><PersonPic pic={me?.avatar ? undefined : null} name={me?.name || '?'} size={48} /><View style={{ flex: 1 }}><Text style={{ color: c.text, fontWeight: '700' }}>{me?.name || 'Name not set'}</Text><Muted small>{me?.deviceName ?? 'Device name not set'}</Muted></View></Row>
        <Field label="Your full name" value={name} onChange={setName} maxLength={80} />
        <Field label="Device name" value={device} onChange={setDevice} maxLength={60} />
        <Btn small label="Save" disabled={!name.trim() || !device.trim()} onPress={() => setErr(act(() => people().updateProfile({ name: name.trim(), deviceName: device.trim() })))} />
        <Btn small label={me?.avatar ? 'Change picture' : 'Add your profile picture'} onPress={() => void (async () => {
          const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.6 });
          const a = !r.canceled && r.assets[0]; if (!a) return;
          try { await people().setAvatar(a.uri, a.mimeType === 'image/png' ? 'image/png' : 'image/jpeg'); bump(); } catch (e) { setErr((e as Error).message); }
        })()} />
        <Muted small>Your picture is shown to people who can see your profile, and sent only to them.</Muted>
        <Err msg={err} />
      </Card>
    </>
  );
}

function ChatList({ onOpen }: { onOpen(id: string): void }) {
  const c = useC();
  const [q, setQ] = useState('');
  const all = useData(() => people().conversations()) ?? [];
  const convs = q.trim() ? all.filter((x) => x.peerName.toLowerCase().includes(q.trim().toLowerCase()) || x.lastText?.toLowerCase().includes(q.trim().toLowerCase())) : all;
  if (!all.length) return <Card><Muted>No conversations yet. Find people in Nearby, or add a friend with their code.</Muted></Card>;
  return <>
    <Field label="Search chats" value={q} onChange={setQ} placeholder="Name or message" />
    {convs.map((x) => (
      <Pressable key={x.id} accessibilityRole="button" accessibilityLabel={`Chat with ${x.peerName}${x.unread ? `, ${x.unread} unread` : ''}`} onPress={() => onOpen(x.id)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderColor: c.border, opacity: pressed ? 0.7 : 1 })}>
        <PersonPic pic={people().avatarOf(x.peerKey)} name={x.peerName} size={48} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, fontWeight: '700', fontSize: 16, color: c.text }}>{x.peerName}</Text>
            {x.lastAt && <Text style={{ color: x.unread ? c.ok : c.muted, fontSize: 12 }}>{new Date(x.lastAt).toDateString() === new Date().toDateString() ? new Date(x.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(x.lastAt).toLocaleDateString()}</Text>}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text numberOfLines={1} style={{ flex: 1, color: c.muted }}>{x.state === 'invited_in' ? 'Invites you to chat' : x.state === 'invited_out' ? 'Invitation sent' : x.state === 'ended' ? 'Chat ended' : x.state === 'declined' ? 'Declined' : (x.lastText ?? ttlText(x.ttlMs))}</Text>
            {!!x.unread && <View style={{ minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: c.ok, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>{x.unread}</Text></View>}
          </View>
        </View>
      </Pressable>
    ))}
  </>;
}

function AutoDownloadCard() {
  const a = useData(() => people().autoDownload());
  const [err, setErr] = useState<string | null>(null);
  if (!a) return null;
  const set = (x: Partial<typeof a>) => setErr(act(() => people().autoDownload({ ...a, ...x })));
  const toggle = (k: (typeof a.kinds)[number]) => set({ kinds: a.kinds.includes(k) ? a.kinds.filter((x) => x !== k) : [...a.kinds, k] });
  return <Card title="Automatic downloads">
    <Btn small label={`From friends: ${a.on ? 'On' : 'Off'}`} on={a.on} onPress={() => set({ on: !a.on })} />
    {a.on && <>
      <Row gap={6}>{(['image', 'video', 'audio', 'document'] as const).map((k) => <Btn key={k} small label={k === 'image' ? 'Photos' : k === 'video' ? 'Videos' : k === 'audio' ? 'Audio' : 'Documents'} on={a.kinds.includes(k)} onPress={() => toggle(k)} />)}</Row>
      <Row gap={6}>{[10, 25, 100].map((n) => <Btn key={n} small label={`Up to ${n} MB`} on={a.maxBytes === n * 1024 * 1024} onPress={() => set({ maxBytes: n * 1024 * 1024 })} />)}</Row>
    </>}
    <Muted small>Downloads into CLAN on this phone only (verified by SHA-256); use Save to Gallery/Photos or Save to Files to export. Files from people who are not your friends, larger files, and anything that could run code (apps, scripts, web pages) always ask first. Nothing is opened automatically.</Muted>
    <Err msg={err} />
  </Card>;
}

function PushCard() {
  const relay = useData(() => people().pushRelay());
  const [url, setUrl] = useState(relay ?? ''), [err, setErr] = useState<string | null>(null);
  return <Card title="Internet-assisted notifications (optional)">
    <Muted small>Local messages and calls never need the internet. When CLAN is closed or the phone is asleep, the operating system can stop local listening. A notification relay (FCM on Android, Apple Push on iPhone) lets friends wake this phone — it carries no message text, names or files; the message itself still arrives over the local network when CLAN opens. Requires internet on both sides and a relay your school or you operate.</Muted>
    <Field label="Relay address (https://…)" value={url} onChange={setUrl} autoCapitalize="none" autoCorrect={false} placeholder="https://relay.example.edu" />
    <Row><Btn small label="Save relay" onPress={() => { setErr(act(() => people().pushRelay(url.trim() || null))); pushTick(); }} /><Btn small label="Turn off" onPress={() => { setUrl(''); setErr(act(() => people().pushRelay(null))); pushTick(); }} /></Row>
    <Muted small>{pushStatus()}</Muted>
    {Platform.OS === 'android' && <Row>{(['msg', 'call'] as const).map((k) => <Btn key={k} small label={k === 'msg' ? 'Test a message wake-up' : 'Test an incoming-call ring'} onPress={() => void selfTestWake(k).then((r) => setErr(`Self-test: genuine ${r.genuine}, forged ${r.forged}, repeated ${r.replay}`), (e) => setErr((e as Error).message))} />)}</Row>}
    <Err msg={err} />
  </Card>;
}

/** Each discovery stage, the last failure with what to do, a real restart of native discovery and a shareable report. */
function DiagnosticsCard({ children }: { children: ReactNode }) {
  const c = useC(), d = useData(() => ({ ...discoveryDiagnostics.state }));
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => discoveryDiagnostics.onChange(() => bump()), []);
  if (!d) return null;
  const yes = (b: boolean) => (b ? '✓' : '✕');
  const share = async () => {
    const text = discoveryDiagnostics.export({ app: 'CLAN', source: process.env.EXPO_PUBLIC_CLAN_SOURCE_SHA ?? 'development', platform: `${Platform.OS} ${Platform.Version}`, nearbyMode: nearby.mode, generated: new Date().toISOString() });
    const f = new File(Paths.cache, `clan-diagnostics-${Date.now()}.txt`); f.create({ overwrite: true }); f.write(text);
    await Sharing.shareAsync(f.uri, { mimeType: 'text/plain', dialogTitle: 'CLAN diagnostics' });
  };
  return <Card title="Connectivity diagnostics">
    <Muted small>{yes(d.network)} Network {d.addresses.length ? `(${d.addresses.join(', ')})` : '— no Wi-Fi/LAN address'}</Muted>
    <Muted small>{yes(!!d.listener)} Listener {d.listener ? `ready (port ${d.listener})` : nearby.mode === 'off' ? 'off (Nearby is Off)' : 'not ready'}</Muted>
    <Muted small>{yes(d.advertising)} Announcing this phone</Muted>
    <Muted small>{yes(d.browsing)} Looking for people · heard {d.servicesFound} · resolved {d.servicesResolved} · reached {d.probesOk} · failed {d.probesFailed}</Muted>
    <Muted small>{yes(d.clanBrowsing)} Looking for CLANs · {d.clansFound} found</Muted>
    <Muted small>Last authenticated person: {d.lastPeerAt ? new Date(d.lastPeerAt).toLocaleTimeString() : '—'} · restarts {d.restarts}</Muted>
    {Platform.OS === 'android' && <Muted small>{yes(d.backgroundService && !!d.lastPulseAt && Date.now() - d.lastPulseAt < 30_000)} Background availability {d.lastPulseAt ? `· last processed ${Math.round((Date.now() - d.lastPulseAt) / 1000)} s ago` : '· not running'}</Muted>}
    {discoveryDiagnostics.hint() && <Text accessibilityLiveRegion="polite" style={{ color: c.text }}>{d.lastFailure}: {discoveryDiagnostics.hint()}</Text>}
    {children}
    <Row><Btn small label="Refresh discovery" onPress={() => { nearby.restartDiscovery(); setMsg('Discovery restarted.'); bump(); }} /><Btn small label="Share diagnostics" onPress={() => void share().catch((e) => setMsg((e as Error).message))} /></Row>
    <Muted small>Shared reports contain no keys, codes, messages, names of files or contacts.</Muted>
    {msg && <Muted small>{msg}</Muted>}
  </Card>;
}

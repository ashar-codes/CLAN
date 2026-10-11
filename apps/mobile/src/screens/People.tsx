// People on the phone: visibility and Nearby availability, codes (show and scan), direct connections without a router
// (Wi-Fi Direct, Wi-Fi Aware, Apple peer-to-peer, hotspots), friends and requests, personal chats with files and voice
// notes, calls, and QR file transfer.
import { useEffect, useState } from 'react';
import { Alert, Linking, Platform, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { parseProfileQr, profileQr, safetyNumber, TEMP_TTLS } from '@classroom/protocol';
import type { Contact, PeopleMessage } from '@clan/core';
import { phoneClan } from '../core/clan';
import { phonePeople } from '../people/native';
import { verify } from '../FileActions';
import { nearby, parseWifiQr, wifiQr } from '../people/nearby';
import { QrImage, QrScanner } from '../ui/qr';
import { OpticalScreen } from './Optical';
import { act, bump, Btn, Card, Err, Field, H1, Mate, Muted, Row, Screen, useC, useData, when } from '../ui/kit';

type Seg = 'nearby' | 'chats' | 'friends';
const people = () => phoneClan().people;
const REL: Record<string, string> = { friend: 'Friend', incoming: 'Asked to be friends', outgoing: 'Request sent', none: '' };
const ttlText = (ms: number | null) => !ms ? 'Saved chat' : ms <= 3_600_000 ? 'Disappears after 1 hour' : ms <= 86_400_000 ? 'Disappears after 24 hours' : 'Disappears after 7 days';
const mb = (n: number) => n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(1)} MB`;

export function PeopleScreen() {
  const [seg, setSeg] = useState<Seg>('chats'), [chat, setChat] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  useEffect(() => { void phonePeople().catch((e) => setErr((e as Error).message)); }, []);
  const unread = useData(() => people().conversations().reduce((n, c) => n + c.unread + (c.state === 'invited_in' ? 1 : 0), 0)) ?? 0;
  const requests = useData(() => people().contacts('requests').filter((r) => r.relation === 'incoming').length) ?? 0;
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
      {seg === 'nearby' ? <Nearby onChat={open} onOptical={() => setOptical(true)} /> : seg === 'friends' ? <Friends onChat={open} /> : <ChatList onOpen={open} />}
    </Screen>
  );
}

function Nearby({ onChat, onOptical }: { onChat(id: string): void; onOptical(): void }) {
  const c = useC();
  const [scan, setScan] = useState(false), [show, setShow] = useState<null | 'profile' | 'friend' | 'chat'>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null), [ok, setOk] = useState<string | null>(null);
  const [pendingWifi, setPendingWifi] = useState<{ ssid: string; passphrase: string } | null>(null);
  const [connected, setConnected] = useState<{ key: string; intent: string } | null>(null);
  const met = useData(() => people().contacts('all').filter((x) => x.relation === 'none').slice(0, 20)) ?? [];
  const vis = useData(() => people().visibility());
  const myCode = useData(() => show ? profileQr({ key: people().myKey(), endpoints: [], links: nearby.myAddrs(), name: people().myProfile().name, invite: people().inviteToken(), intent: show }) : null);
  const entries = useData(() => [...nearby.entries.values()].sort((x, y) => Number(y.friend) - Number(x.friend))) ?? [];
  const caps = nearby.caps;
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
      <Card title="Who can find you">
        <Row gap={6}>
          <Btn small label="Everyone nearby (1 h)" on={vis === 'everyone'} onPress={() => setErr(act(() => people().setVisibility('everyone', 3_600_000)))} />
          <Btn small label="Friends only" on={vis === 'friends'} onPress={() => setErr(act(() => people().setVisibility('friends')))} />
          <Btn small label="Invisible" on={vis === 'invisible'} onPress={() => setErr(act(() => people().setVisibility('invisible')))} />
        </Row>
        <Muted small>Everyone Nearby shows only fields you mark for everyone and switches back by itself. Avoid it on public networks. Others only ever see a random id unless you let them in.</Muted>
        <Muted>Nearby on this phone</Muted>
        <Row gap={6}>
          <Btn small label="Off" on={nearby.mode === 'off'} onPress={() => nearby.setMode('off')} />
          <Btn small label="While using CLAN" on={nearby.mode === 'app'} onPress={() => nearby.setMode('app')} />
          <Btn small label="Stay available in a session" on={nearby.mode === 'session'} onPress={() => nearby.setMode('session')} />
        </Row>
        <Muted small>{Platform.OS === 'android' ? 'During an open chat, call or transfer, Android keeps it connected with a visible notification. Nothing runs when no session is open.' : 'iPhone keeps a session only while CLAN is open (plus a short moment after you leave, and during a call). Nobody can reach you while CLAN is closed.'}</Muted>
      </Card>

      <Card title="Connect with a code">
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

      {entries.map((e) => (
        <Card key={e.id}>
          <Row><Mate name={e.name} size={36} /><View style={{ flex: 1 }}><Text style={{ fontWeight: '700', color: c.text }}>{e.name}{e.friend ? ' · friend' : ''}</Text>
            <Muted small>{e.via === 'direct' ? 'Wi-Fi Direct' : e.via === 'aware' ? 'Wi-Fi Aware' : e.via === 'apple' ? 'Apple peer-to-peer' : 'Same network'}{e.key && nearby.state(e.key) ? ` · ${STATE[nearby.state(e.key)!]}` : ''}{e.profile?.university ? ` · ${e.profile.university}` : ''}</Muted></View></Row>
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
  const [err, setErr] = useState<string | null>(null), [invite, setInvite] = useState(false), [confirm, setConfirm] = useState<'remove' | 'block' | null>(null);
  const myKey = useData(() => people().myKey());
  const run = (f: () => unknown) => { setErr(act(f)); void phonePeople().then((r) => r.tick()); };
  const p = c.profile;
  const chat = () => { const x = people().conversations().find((v) => v.peerKey === c.key && v.state === 'active'); if (x) onChat(x.id); else setInvite(true); };
  return (
    <Card>
      <Row><Mate name={c.name} /><View style={{ flex: 1 }}><Text style={{ fontWeight: '700', fontSize: 16 }}>{c.name}{c.verified ? ' ✓' : ''}</Text>
        <Muted small>{[p?.university, p?.department, p?.course].filter(Boolean).join(' · ') || (REL[c.relation] || (c.blocked ? 'Blocked' : 'Not connected'))}{nearby.state(c.key) ? ` · ${STATE[nearby.state(c.key)!]}` : ''}</Muted></View></Row>
      {p?.bio ? <Muted>{p.bio}</Muted> : null}
      {myKey && <Muted small>Safety number: {safetyNumber(myKey, c.key)}{c.verified ? ' · verified' : ''}</Muted>}
      <Row gap={6}>
        {c.relation === 'none' && !c.blocked && <Btn small label="Add friend" onPress={() => run(() => people().sendFriendRequest(c.key))} />}
        {c.relation === 'incoming' && <><Btn small primary label="Accept" onPress={() => run(() => people().acceptFriend(c.key))} /><Btn small label="Decline" onPress={() => run(() => people().rejectFriend(c.key))} /></>}
        {c.relation === 'outgoing' && <Btn small label="Cancel request" onPress={() => run(() => people().cancelFriendRequest(c.key))} />}
        {!c.blocked && c.relation !== 'incoming' && <Btn small label="Chat" onPress={chat} />}
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
  const [name, setName] = useState(me?.name ?? ''), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {!list.length && <Muted>No friends yet. Connect to someone’s computer with their code in Nearby.</Muted>}
      {list.map((c) => <PersonCard key={c.key} c={c} onChat={onChat} />)}
      <Card title="Your name for people">
        <Field label="Name" value={name} onChange={setName} maxLength={80} />
        <Btn small label="Save" disabled={!name.trim()} onPress={() => setErr(act(() => people().updateProfile({ name: name.trim() })))} />
        <Err msg={err} />
      </Card>
    </>
  );
}

function ChatList({ onOpen }: { onOpen(id: string): void }) {
  const convs = useData(() => people().conversations()) ?? [];
  if (!convs.length) return <Muted>No chats yet. Start one from Friends or Nearby.</Muted>;
  return <>{convs.map((c) => (
    <Card key={c.id}>
      <Row><Mate name={c.peerName} size={36} /><View style={{ flex: 1 }}><Text style={{ fontWeight: '700' }}>{c.peerName}{c.unread ? ` · ${c.unread} new` : ''}</Text>
        <Muted small>{c.state === 'invited_in' ? 'Invites you to chat' : c.state === 'invited_out' ? 'Invitation sent' : c.state === 'ended' ? 'Ended' : c.state === 'declined' ? 'Declined' : (c.lastText ?? ttlText(c.ttlMs))}</Muted></View>
        <Btn small label="Open" a11y={`Open chat with ${c.peerName}`} onPress={() => onOpen(c.id)} /></Row>
    </Card>
  ))}</>;
}

/** Refuse up front when the phone cannot hold the file (plus a margin) instead of failing half-way. */
function roomFor(bytes: number) {
  const free = Paths.availableDiskSpace, need = bytes + 64 * 1024 * 1024;
  if (free < need) throw new Error(`Not enough free space on this phone (needs ${Math.ceil(need / 1e6)} MB, ${Math.floor(free / 1e6)} MB free).`);
}

const PAGE = 40;
function ChatView({ id, onBack }: { id: string; onBack(): void }) {
  const c = useC();
  const [limit, setLimit] = useState(PAGE), [text, setText] = useState(''), [err, setErr] = useState<string | null>(null);
  const conv = useData(() => people().conversation(id));
  const msgs = useData(() => people().page(id, { limit })) ?? [];
  const tick = () => void phonePeople().then((r) => r.tick());
  useEffect(() => { if (conv?.unread) { act(() => people().markRead(id)); tick(); } }, [conv?.unread, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!conv) return <Screen><Btn label="← Back" onPress={onBack} /><Muted>This conversation was removed.</Muted></Screen>;
  const run = (f: () => unknown) => { setErr(act(f)); tick(); };
  const send = () => { const t = text.trim(); if (!t) return; run(() => people().sendText(id, t)); setText(''); };
  const sendFile = async () => {
    const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }); const a = !r.canceled && r.assets[0];
    if (!a) return;
    try { await people().offerFile(id, a.uri, { name: a.name, mime: a.mimeType ?? 'application/octet-stream' }); tick(); } catch (e) { setErr((e as Error).message); }
  };
  const confirm = (what: 'clear' | 'remove' | 'end') => Alert.alert(what === 'end' ? 'End this chat?' : what === 'clear' ? 'Clear history on this phone?' : 'Remove this conversation from this phone?',
    what === 'end' ? 'Neither of you can send more until a new invitation is accepted.' : `${conv.peerName} keeps their own copy — CLAN cannot delete what is already on their device.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: what === 'end' ? 'End chat' : what === 'clear' ? 'Clear' : 'Remove', style: 'destructive', onPress: () => {
      if (what === 'end') run(() => people().endChat(id));
      else void (what === 'clear' ? people().clearHistory(id) : people().removeConversation(id).then(onBack)).catch((e) => setErr((e as Error).message));
    } }]);
  return (
    <Screen>
      <Row><Btn small label="← Chats" onPress={onBack} /><View style={{ flex: 1 }}><Text style={{ fontWeight: '800', fontSize: 18, color: c.text }}>{conv.peerName}</Text><Muted small>{ttlText(conv.ttlMs)}</Muted></View></Row>
      <Row gap={6}>
        {conv.state === 'active' && <Btn small label="End chat" onPress={() => confirm('end')} />}
        <Btn small label="Clear history" onPress={() => confirm('clear')} />
        <Btn small danger label="Remove" onPress={() => confirm('remove')} />
      </Row>
      {conv.state === 'invited_in' && <Card tone="ok"><Text style={{ color: c.text }}>{conv.peerName} invites you to {conv.mode === 'temporary' ? `a temporary chat (${ttlText(conv.ttlMs).toLowerCase()} on both devices)` : 'a saved chat'}.</Text>
        <Row><Btn small primary label="Accept" onPress={() => run(() => people().acceptChat(id))} /><Btn small label="Decline" onPress={() => run(() => people().declineChat(id))} /></Row></Card>}
      {conv.state === 'invited_out' && <Muted>Waiting for {conv.peerName} to accept.</Muted>}
      {msgs.length >= limit && <Btn small label="Load earlier messages" onPress={() => setLimit(limit + PAGE)} />}
      {msgs.map((m) => <Bubble key={m.id} m={m} onError={setErr} onAct={run} />)}
      <Err msg={err} />
      {conv.state === 'active' ? <>
        <Field label="Message" value={text} onChange={setText} multiline maxLength={8000} />
        <Row><Btn primary label="Send" disabled={!text.trim()} onPress={send} /><Btn label="📎 File" a11y="Send a file" onPress={() => void sendFile()} /></Row>
      </> : conv.state !== 'invited_in' && conv.state !== 'invited_out' ? <Muted>This chat is closed.</Muted> : null}
    </Screen>
  );
}

function Bubble({ m, onError, onAct }: { m: PeopleMessage; onError(e: string): void; onAct(f: () => unknown): void }) {
  const c = useC(), t = m.transfer;
  const st = m.mine ? ({ queued: 'Sending…', delivered: 'Delivered', read: 'Read', failed: 'Not sent', received: '' } as const)[m.state] : '';
  if (m.kind === 'event' || m.kind === 'call') return <Muted small>{m.text} · {when(m.createdAt)}</Muted>;
  const share = async () => {
    try {
      const path = m.mine ? people().outgoingBytesLocal(t!.id) : people().filePath(t!.id);
      if (!path) throw new Error('This file is not on this phone.');
      await verify(new File(path), t!.sha256);
      await Sharing.shareAsync(path, { mimeType: t!.mime, dialogTitle: t!.name });
    } catch (e) { onError((e as Error).message); }
  };
  return (
    <View style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '86%', backgroundColor: m.mine ? c.accent + '22' : c.surface, borderRadius: 14, padding: 10, gap: 4, borderWidth: 1, borderColor: m.state === 'failed' ? c.danger : c.border }}>
      {t ? <>
        <Text style={{ fontWeight: '700', color: c.text }}>{m.kind === 'voice' ? `Voice message · ${Math.round((t.voiceMs ?? 0) / 1000)} s` : t.name}</Text>
        <Muted small>{mb(t.size)} · {t.retention} · {t.state === 'complete' ? 'Verified' : t.state === 'transferring' ? `${Math.round((t.received / Math.max(1, t.size)) * 100)}%` : t.state}{t.error ? ` — ${t.error}` : ''}</Muted>
        {m.kind === 'voice' && <Muted small>Voice playback on phones comes in a later build; Share opens it in another app.</Muted>}
        <Row gap={6}>
          {!m.mine && t.state === 'offered' && <><Btn small primary label={`Accept ${mb(t.size)}`} onPress={() => onAct(() => { roomFor(t.size - t.received); people().acceptFile(t.id); })} /><Btn small label="Decline" onPress={() => onAct(() => people().declineFile(t.id))} /></>}
          {['offered', 'accepted', 'transferring'].includes(t.state) && (m.mine || t.state !== 'offered') && <Btn small label="Cancel" onPress={() => void people().cancelFile(t.id).catch((e) => onError((e as Error).message))} />}
          {!m.mine && t.state === 'failed' && <Btn small label="Retry" onPress={() => onAct(() => { roomFor(t.size - t.received); people().retryDownload(t.id); })} />}
          {(t.state === 'complete' || (m.mine && !['cancelled', 'expired'].includes(t.state))) && <Btn small label="Share / Open" onPress={() => void share()} />}
        </Row>
      </> : <Text style={{ color: c.text, fontSize: 16 }}>{m.text}</Text>}
      <Muted small>{when(m.createdAt)}{st ? ` · ${st}` : ''}{m.expiresAt ? ` · disappears ${when(m.expiresAt)}` : ''}</Muted>
      {m.mine && m.state === 'failed' && <Btn small label="Retry" onPress={() => onAct(() => people().retryMessage(m.id))} />}
    </View>
  );
}

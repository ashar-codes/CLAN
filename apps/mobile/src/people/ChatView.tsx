// A personal conversation on the phone: fixed header (person, device, call/video/options), date-separated grouped
// bubbles with real delivery states, long-press or chevron action sheet (react, reply, copy, forward, edit, info,
// delete for me / for everyone), reply and edit banners, attachments (photo/video/document) and voice notes.
// Everything is the shared People core; this file only presents it.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, FlatList, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { StorageAccessFramework } from 'expo-file-system/legacy';
import { safeFileName } from '@classroom/protocol';
import { fileKind, type PeopleMessage } from '@clan/core';
import { phoneClan, me } from '../core/clan';
import { verify } from '../FileActions';
import { nativeFileActions } from '../../modules/file-actions';
import { act, bump, Btn, Err, Muted, PersonPic, useC, useData } from '../ui/kit';
import { phonePeople } from './native';
import { nearby } from './nearby';
import { setPeopleViewing } from './notifications';
import { usePhoneCall } from './Call';
import { VoiceNotePlayer, VoiceRecorder } from './Voice';

const people = () => phoneClan().people;
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const PAGE = 60;
const mb = (n: number) => n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(1)} MB`;
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (t: number) => { const d = new Date(t), n = new Date(), y = new Date(); y.setDate(n.getDate() - 1);
  return d.toDateString() === n.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' }); };
const ttlText = (ms: number | null) => !ms ? '' : ms <= 3_600_000 ? 'Messages disappear after 1 hour' : ms <= 86_400_000 ? 'Messages disappear after 24 hours' : 'Messages disappear after 7 days';
/** Refuse up front when the phone cannot hold the file (plus a margin) instead of failing half-way. */
export function roomFor(bytes: number) {
  const free = Paths.availableDiskSpace, need = bytes + 64 * 1024 * 1024;
  if (free < need) throw new Error(`Not enough free space on this phone (needs ${Math.ceil(need / 1e6)} MB, ${Math.floor(free / 1e6)} MB free).`);
}
const tick = () => void phonePeople().then((r) => r.tick()).catch(() => {});
type Row = { t: 'day'; key: string; label: string } | { t: 'msg'; key: string; m: PeopleMessage; first: boolean; last: boolean };

export function ChatView({ id, onBack }: { id: string; onBack(): void }) {
  useEffect(() => { setPeopleViewing(id); return () => setPeopleViewing(null); }, [id]);
  const c = useC(), calls = usePhoneCall();
  const [limit, setLimit] = useState(PAGE), [text, setText] = useState(''), [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false), [query, setQuery] = useState<string | null>(null), [attach, setAttach] = useState(false);
  const [sheet, setSheet] = useState<PeopleMessage | null>(null), [reply, setReply] = useState<PeopleMessage | null>(null), [editing, setEditing] = useState<PeopleMessage | null>(null);
  const [forward, setForward] = useState<PeopleMessage | null>(null);
  const conv = useData(() => people().conversation(id));
  const contact = useData(() => conv ? people().contact(conv.peerKey) : null);
  const pic = useData(() => conv ? people().avatarOf(conv.peerKey) : null);
  const msgs = useData(() => people().page(id, { limit })) ?? [];
  useEffect(() => { if (conv?.unread) { act(() => people().markRead(id)); tick(); } }, [conv?.unread, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => {
    const q = query?.trim().toLowerCase(), list = q ? msgs.filter((m) => m.text?.toLowerCase().includes(q) || m.transfer?.name.toLowerCase().includes(q)) : msgs;
    const out: Row[] = [];
    list.forEach((m, i) => {
      const prev = list[i - 1], next = list[i + 1];
      if (!prev || day(prev.createdAt) !== day(m.createdAt)) out.push({ t: 'day', key: `d${m.id}`, label: day(m.createdAt) });
      const near = (a?: PeopleMessage) => !!a && a.author === m.author && Math.abs(a.createdAt - m.createdAt) < 5 * 60_000 && day(a.createdAt) === day(m.createdAt) && a.kind !== 'call' && a.kind !== 'event';
      out.push({ t: 'msg', key: m.id, m, first: !near(prev), last: !near(next) });
    });
    return out.reverse(); // inverted list: newest at the bottom, keyboard-friendly
  }, [msgs, query]);
  if (!conv) return <View style={{ flex: 1, padding: 16, gap: 12, backgroundColor: c.bg }}><Btn label="← Back" onPress={onBack} /><Muted>This conversation was removed.</Muted></View>;

  const run = (f: () => unknown) => { setErr(act(f)); tick(); };
  const runAsync = (f: () => Promise<unknown>) => void f().then(() => { bump(); tick(); }, (e) => setErr((e as Error).message));
  const send = () => {
    const t = text.trim(); if (!t) return;
    if (editing) { run(() => people().editMessage(editing.id, t)); setEditing(null); setText(''); return; }
    const r = reply?.id; setReply(null);
    run(() => people().sendText(id, t, r ? { replyTo: r } : {})); setText('');
  };
  const offer = async (uri: string, name: string, mime: string) => { await people().offerFile(id, uri, { name, mime }); tick(); };
  const pickMedia = async () => {
    setAttach(false);
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 1, allowsMultipleSelection: true, selectionLimit: 10 });
    if (r.canceled) return;
    for (const a of r.assets) await offer(a.uri, a.fileName ?? `photo-${Date.now()}.${a.type === 'video' ? 'mp4' : 'jpg'}`, a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg')).catch((e) => setErr((e as Error).message));
  };
  const pickCamera = async () => {
    setAttach(false);
    if (!(await ImagePicker.requestCameraPermissionsAsync()).granted) return setErr('Allow the camera for CLAN in Settings.');
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 }); const a = !r.canceled && r.assets[0];
    if (a) await offer(a.uri, a.fileName ?? `photo-${Date.now()}.jpg`, a.mimeType ?? 'image/jpeg').catch((e) => setErr((e as Error).message));
  };
  const pickDoc = async () => {
    setAttach(false);
    const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true }); if (r.canceled) return;
    for (const a of r.assets) await offer(a.uri, a.name, a.mimeType ?? 'application/octet-stream').catch((e) => setErr((e as Error).message));
  };
  const confirm = (what: 'clear' | 'remove' | 'end') => Alert.alert(what === 'end' ? 'End this chat?' : what === 'clear' ? 'Clear history on this phone?' : 'Remove this conversation from this phone?',
    what === 'end' ? 'Neither of you can send more until a new invitation is accepted.' : `${conv.peerName} keeps their own copy — CLAN cannot delete what is already on their device.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: what === 'end' ? 'End chat' : what === 'clear' ? 'Clear' : 'Remove', style: 'destructive', onPress: () => {
      if (what === 'end') run(() => people().endChat(id));
      else runAsync(() => what === 'clear' ? people().clearHistory(id) : people().removeConversation(id).then(onBack));
    } }]);
  const state = nearby.state(conv.peerKey);
  const sub = query !== null ? '' : [contact?.deviceName, state === 'connected' ? 'Connected nearby' : state === 'connecting' || state === 'reconnecting' ? 'Connecting…' : null, ttlText(conv.ttlMs)].filter(Boolean).join(' · ');
  const canCall = conv.friend || conv.state === 'active';
  const icon = (label: string, glyph: string, onPress: () => void, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} hitSlop={6} onPress={onPress}
      style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}>
      <Text style={{ fontSize: 20, color: c.text }}>{glyph}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* fixed header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4, paddingVertical: 6, borderBottomWidth: 1, borderColor: c.border, backgroundColor: c.surface }}>
        {icon('Back to chats', '‹', onBack)}
        {query === null ? <>
          <PersonPic pic={pic} name={conv.peerName} size={38} />
          <View style={{ flex: 1, marginLeft: 6 }}>
            <Text numberOfLines={1} style={{ color: c.text, fontWeight: '800', fontSize: 17 }}>{conv.peerName}</Text>
            {!!sub && <Text numberOfLines={1} style={{ color: c.muted, fontSize: 12 }}>{sub}</Text>}
          </View>
          {icon(`Voice call ${conv.peerName}`, '📞', () => calls.call(conv.peerKey, conv.peerName), !canCall || calls.active)}
          {icon(`Video call ${conv.peerName}`, '🎥', () => calls.call(conv.peerKey, conv.peerName, true), !canCall || calls.active)}
          {icon('Chat options', '⋮', () => setMenu(true))}
        </> : <>
          <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Search this chat" placeholderTextColor={c.muted} accessibilityLabel="Search this chat"
            style={{ flex: 1, minHeight: 44, fontSize: 16, color: c.text }} />
          {icon('Close search', '✕', () => setQuery(null))}
        </>}
      </View>

      {conv.state === 'invited_in' && <View style={{ margin: 12, padding: 12, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.ok, gap: 8 }}>
        <Text style={{ color: c.text }}>{conv.peerName} invites you to {conv.mode === 'temporary' ? `a temporary chat (${ttlText(conv.ttlMs).toLowerCase()} on both phones)` : 'a saved chat'}.</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}><Btn small primary label="Accept" onPress={() => run(() => people().acceptChat(id))} /><Btn small label="Decline" onPress={() => run(() => people().declineChat(id))} /></View>
      </View>}

      <FlatList inverted data={rows} keyExtractor={(r) => r.key} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 8 }}
        keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        onEndReached={() => { if (msgs.length >= limit) setLimit(limit + PAGE); }} onEndReachedThreshold={0.3}
        ListEmptyComponent={<View style={{ transform: [{ scaleY: -1 }], padding: 24, alignItems: 'center' }}><Muted>{query ? 'No messages match.' : conv.state === 'invited_out' ? `Waiting for ${conv.peerName} to accept.` : 'No messages yet. Say hello 👋'}</Muted></View>}
        renderItem={({ item: r }) => r.t === 'day'
          ? <View style={{ alignItems: 'center', marginVertical: 8 }}><Text style={{ color: c.text2, fontSize: 12, backgroundColor: c.bg2, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, overflow: 'hidden' }}>{r.label}</Text></View>
          : <Bubble m={r.m} first={r.first} last={r.last} peerName={conv.peerName} onMenu={() => setSheet(r.m)} onError={setErr} onAct={run} />} />

      <Err msg={err} />
      {(reply || editing) && <View style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: 10, padding: 8, borderLeftWidth: 4, borderLeftColor: c.ok, backgroundColor: c.surface, borderRadius: 8 }}>
        <View style={{ flex: 1 }}><Text style={{ color: c.ok, fontWeight: '700', fontSize: 12 }}>{editing ? 'Editing message' : `Replying to ${reply!.mine ? 'yourself' : conv.peerName}`}</Text>
          <Text numberOfLines={1} style={{ color: c.muted }}>{(editing ?? reply)!.text ?? (reply?.transfer?.name ?? 'Attachment')}</Text></View>
        {icon('Cancel', '✕', () => { setReply(null); if (editing) { setEditing(null); setText(''); } })}
      </View>}
      {conv.state === 'active' ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 8, borderTopWidth: 1, borderColor: c.border, backgroundColor: c.surface }}>
          {!editing && icon('Attach a photo, video or document', '📎', () => setAttach(true))}
          <TextInput value={text} onChangeText={setText} multiline maxLength={8000} placeholder="Message" placeholderTextColor={c.muted} accessibilityLabel="Message"
            style={{ flex: 1, minHeight: 44, maxHeight: 140, fontSize: 16, color: c.text, backgroundColor: c.bg, borderRadius: 22, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 11, borderWidth: 1, borderColor: c.border }} />
          {text.trim() || editing
            ? <Pressable accessibilityRole="button" accessibilityLabel={editing ? 'Save edit' : 'Send'} onPress={send} disabled={!text.trim()}
                style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: c.ok, alignItems: 'center', justifyContent: 'center', opacity: text.trim() ? 1 : 0.5 }}><Text style={{ color: '#fff', fontSize: 18, fontWeight: '800' }}>{editing ? '✓' : '➤'}</Text></Pressable>
            : <VoiceRecorder convId={id} onError={setErr} onSent={tick} />}
        </View>
      ) : conv.state !== 'invited_in' && conv.state !== 'invited_out' ? <View style={{ padding: 12, alignItems: 'center' }}><Muted>This chat is closed. Start a new one from People.</Muted></View> : null}

      {/* attachment picker */}
      <Sheet open={attach} onClose={() => setAttach(false)} title="Send">
        <SheetItem label="Photos & videos" glyph="🖼" onPress={() => void pickMedia()} />
        <SheetItem label="Camera" glyph="📷" onPress={() => void pickCamera()} />
        <SheetItem label="Document" glyph="📄" onPress={() => void pickDoc()} />
      </Sheet>
      {/* chat options */}
      <Sheet open={menu} onClose={() => setMenu(false)} title={conv.peerName}>
        <SheetItem label="Search chat" glyph="🔍" onPress={() => { setMenu(false); setQuery(''); }} />
        <SheetItem label="Contact details" glyph="ℹ️" onPress={() => { setMenu(false); Alert.alert(conv.peerName, [conv.friend ? 'Friend' : 'Chat contact', contact?.deviceName ? `Device: ${contact.deviceName}` : null, contact?.verified ? 'Safety number verified' : 'Not verified in person yet'].filter(Boolean).join('\n')); }} />
        <SheetItem label={phoneClan().notifications.prefs(me()).direct ? 'Mute message notifications' : 'Unmute message notifications'} glyph="🔔" onPress={() => { setMenu(false); const n = phoneClan().notifications; n.setPrefs(me(), { direct: !n.prefs(me()).direct }); bump(); }} />
        {conv.state === 'active' && <SheetItem label="End chat" glyph="⏹" onPress={() => { setMenu(false); confirm('end'); }} />}
        <SheetItem label="Clear history on this phone" glyph="🧹" onPress={() => { setMenu(false); confirm('clear'); }} />
        <SheetItem danger label="Remove conversation" glyph="🗑" onPress={() => { setMenu(false); confirm('remove'); }} />
      </Sheet>
      {/* message actions (long-press or chevron) */}
      <Sheet open={!!sheet} onClose={() => setSheet(null)}>
        {sheet && !sheet.deleted && sheet.kind !== 'call' && sheet.kind !== 'event' && conv.state === 'active' &&
          <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 8 }} accessibilityLabel="React">
            {REACTIONS.map((e) => { const mine = sheet.reactions[people().myKey()] === e; return (
              <Pressable key={e} accessibilityRole="button" accessibilityLabel={mine ? `Remove reaction ${e}` : `React ${e}`} onPress={() => { const m = sheet; setSheet(null); run(() => people().react(m.id, mine ? null : e)); }}
                style={{ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: mine ? c.bg2 : 'transparent' }}><Text style={{ fontSize: 24 }}>{e}</Text></Pressable>); })}
          </View>}
        {sheet && !sheet.deleted && conv.state === 'active' && sheet.kind !== 'call' && sheet.kind !== 'event' && <SheetItem label="Reply" glyph="↩" onPress={() => { setReply(sheet); setEditing(null); setSheet(null); }} />}
        {sheet?.text && !sheet.deleted && <SheetItem label="Copy" glyph="⧉" onPress={() => { const t = sheet.text!; setSheet(null); void nativeFileActions().copyText(t).catch((e) => setErr((e as Error).message)); }} />}
        {sheet && !sheet.deleted && (sheet.kind === 'text' || sheet.transfer?.state === 'complete' || (sheet.mine && sheet.transfer)) && <SheetItem label="Forward" glyph="↪" onPress={() => { setForward(sheet); setSheet(null); }} />}
        {sheet?.canEdit && <SheetItem label="Edit" glyph="✎" onPress={() => { setEditing(sheet); setReply(null); setText(sheet.text ?? ''); setSheet(null); }} />}
        {sheet?.mine && sheet.state === 'failed' && sheet.kind === 'text' && <SheetItem label="Retry sending" glyph="⟳" onPress={() => { const m = sheet; setSheet(null); run(() => people().retryMessage(m.id)); }} />}
        {sheet && <SheetItem label="Message info" glyph="ℹ️" onPress={() => { const m = sheet; setSheet(null); Alert.alert('Message info', info(m, conv.peerName)); }} />}
        {sheet && <SheetItem danger label="Delete for me" glyph="🗑" onPress={() => { const m = sheet; setSheet(null);
          Alert.alert('Delete for me?', `This removes it from this phone only. ${m.mine ? `${conv.peerName} keeps their copy.` : ''}`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => runAsync(() => people().deleteForMe(m.id)) }]); }} />}
        {sheet?.canDeleteForEveryone && <SheetItem danger label="Delete for everyone" glyph="⊘" onPress={() => { const m = sheet; setSheet(null);
          Alert.alert('Delete for everyone?', `CLAN removes it from ${conv.peerName}'s CLAN as soon as their device receives the deletion. It cannot remove screenshots or copies saved outside CLAN.`,
            [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete for everyone', style: 'destructive', onPress: () => runAsync(() => people().deleteForEveryone(m.id)) }]); }} />}
      </Sheet>
      <ForwardSheet m={forward} from={id} onClose={() => setForward(null)} onError={setErr} />
    </View>
  );
}

function info(m: PeopleMessage, peer: string) {
  const st = { queued: 'Waiting to send (stored on this phone)', sending: 'Sending…', delivered: `Delivered to ${peer}`, read: `Read by ${peer}`, failed: 'Not delivered', received: `From ${peer}` }[m.state];
  return [`Sent ${new Date(m.createdAt).toLocaleString()}`, st, m.editedAt ? `Edited ${new Date(m.editedAt).toLocaleString()}` : null,
    m.op === 'edit_pending' ? 'Edit not delivered yet' : m.op === 'delete_pending' ? 'Deletion not delivered yet' : m.op === 'op_failed' ? `${peer}'s CLAN could not apply the change (it may be an older version).` : null,
    m.expiresAt ? `Disappears ${new Date(m.expiresAt).toLocaleString()}` : null, m.transfer ? `${m.transfer.name} · ${mb(m.transfer.size)} · SHA-256 ${m.transfer.sha256.slice(0, 12)}…` : null].filter(Boolean).join('\n');
}

function Bubble({ m, first, last, peerName, onMenu, onError, onAct }: { m: PeopleMessage; first: boolean; last: boolean; peerName: string; onMenu(): void; onError(e: string): void; onAct(f: () => unknown): void }) {
  const c = useC(), t = m.transfer;
  if (m.kind === 'event' || m.kind === 'call') return (
    <Pressable onLongPress={onMenu} style={{ alignSelf: 'center', marginVertical: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: c.bg2 }}>
      <Text style={{ color: c.text2, fontSize: 13 }}>{m.kind === 'call' ? '📞 ' : ''}{m.text} · {time(m.createdAt)}</Text>
    </Pressable>);
  const tick = !m.mine ? '' : m.op === 'op_failed' ? ' ⚠︎' : m.state === 'failed' ? ' ⚠︎' : m.state === 'queued' ? ' 🕓' : m.state === 'sending' ? ' ✓' : m.state === 'read' ? ' ✓✓' : ' ✓✓';
  const readColor = m.state === 'read' ? '#34B7F1' : c.muted;
  const reactions = Object.values(m.reactions);
  const kind = t ? fileKind(t.name, t.mime) : null;
  const local = () => t ? (m.mine ? people().outgoingBytesLocal(t.id) : people().filePath(t.id)) : null;
  const withFile = async (f: (uri: string) => Promise<unknown>, done?: string) => {
    try { const p = local(); if (!p) throw new Error('This file is not on this phone.'); await verify(new File(p), t!.sha256); await f(p.startsWith('file://') ? p : `file://${p}`); if (done) onError(done); }
    catch (e) { onError((e as Error).message); }
  };
  const toGallery = () => withFile((u) => nativeFileActions().saveToGallery(u, t!.sha256, t!.mime, t!.name), Platform.OS === 'ios' ? 'Saved to Photos.' : 'Saved to Gallery (Pictures/CLAN or Movies/CLAN).');
  const toFiles = () => withFile(async (u) => {
    if (Platform.OS === 'android') {
      const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync(); if (!perm.granted) return;
      const target = await StorageAccessFramework.createFileAsync(perm.directoryUri, safeFileName(t!.name), t!.mime || 'application/octet-stream');
      await nativeFileActions().saveCopy(u, target, t!.sha256, t!.size); onError('Saved a verified copy to the folder you chose.');
    } else await Sharing.shareAsync(u, { mimeType: t!.mime, dialogTitle: 'Save to Files' });
  });
  const share = () => withFile((u) => Sharing.shareAsync(u, { mimeType: t!.mime, dialogTitle: t!.name }));
  const open = () => withFile((u) => Platform.OS === 'android' ? nativeFileActions().openWith(u, t!.sha256) : Sharing.shareAsync(u, { mimeType: t!.mime, dialogTitle: 'Open with' }));
  return (
    <View style={{ alignItems: m.mine ? 'flex-end' : 'flex-start', marginTop: first ? 8 : 2 }}>
      <Pressable onLongPress={onMenu} delayLongPress={300} accessibilityHint="Long-press for message actions"
        accessibilityLabel={`${m.mine ? 'You' : peerName}: ${m.deleted ? 'deleted message' : m.text ?? t?.name ?? ''}, ${time(m.createdAt)}`}
        style={({ pressed }) => ({ maxWidth: '84%', minWidth: 90, paddingHorizontal: 10, paddingTop: 7, paddingBottom: 5, gap: 4, opacity: pressed ? 0.85 : 1,
          backgroundColor: m.mine ? c.ok + '30' : c.surface, borderWidth: 1, borderColor: m.state === 'failed' ? c.danger : m.mine ? c.ok + '55' : c.border,
          borderRadius: 16, borderTopRightRadius: m.mine && first ? 4 : 16, borderTopLeftRadius: !m.mine && first ? 4 : 16 })}>
        <Pressable accessibilityRole="button" accessibilityLabel="Message actions" hitSlop={10} onPress={onMenu} style={{ position: 'absolute', right: 4, top: 2, zIndex: 1, paddingHorizontal: 4 }}>
          <Text style={{ color: c.muted, fontSize: 12 }}>⌄</Text>
        </Pressable>
        {m.replyTo && !m.deleted && <View style={{ borderLeftWidth: 3, borderLeftColor: c.ok, backgroundColor: c.bg2, borderRadius: 6, padding: 6, marginRight: 14 }}>
          <Text style={{ color: c.ok, fontWeight: '700', fontSize: 12 }}>{m.replyTo.author === people().myKey() ? 'You' : peerName}</Text>
          <Text numberOfLines={2} style={{ color: c.text2, fontSize: 13 }}>{m.replyTo.text ?? 'Message deleted'}</Text></View>}
        {m.deleted ? <Text style={{ color: c.muted, fontStyle: 'italic', marginRight: 14 }}>⊘ {m.mine ? 'You deleted this message' : 'This message was deleted'}</Text>
        : t ? <View style={{ gap: 6, marginRight: 14 }}>
            <Text style={{ fontWeight: '700', color: c.text }}>{m.kind === 'voice' ? `🎤 Voice message · ${Math.round((t.voiceMs ?? 0) / 1000)} s` : `${kind === 'image' ? '🖼' : kind === 'video' ? '🎞' : kind === 'audio' ? '🎵' : '📄'} ${t.name}`}</Text>
            <Text style={{ color: c.muted, fontSize: 12 }}>{mb(t.size)} · {t.state === 'complete' ? (m.mine ? 'Sent' : 'Downloaded to CLAN · verified') : t.state === 'transferring' ? `${Math.round((t.received / Math.max(1, t.size)) * 100)}%` : t.state === 'offered' ? (m.mine ? 'Waiting for them to accept' : 'Tap Download to receive') : t.state === 'accepted' ? 'Starting…' : t.state}{t.error ? ` — ${t.error}` : ''}</Text>
            {t.state === 'transferring' && <View style={{ height: 4, borderRadius: 2, backgroundColor: c.bg2 }}><View style={{ height: 4, borderRadius: 2, width: `${Math.round((t.received / Math.max(1, t.size)) * 100)}%`, backgroundColor: c.ok }} /></View>}
            {m.kind === 'voice' && <VoiceNotePlayer t={t} mine={m.mine} onError={onError} />}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {!m.mine && t.state === 'offered' && <><Btn small primary label={`Download ${mb(t.size)}`} onPress={() => onAct(() => { roomFor(t.size - t.received); people().acceptFile(t.id); })} /><Btn small label="Decline" onPress={() => onAct(() => people().declineFile(t.id))} /></>}
              {['offered', 'accepted', 'transferring'].includes(t.state) && (m.mine || t.state !== 'offered') && <Btn small label="Cancel" onPress={() => void people().cancelFile(t.id).then(bump, (e) => onError((e as Error).message))} />}
              {!m.mine && t.state === 'failed' && <Btn small label="Retry" onPress={() => onAct(() => { roomFor(t.size - t.received); people().retryDownload(t.id); })} />}
              {m.kind !== 'voice' && (t.state === 'complete' || (m.mine && !['cancelled', 'expired'].includes(t.state))) && <>
                {(kind === 'image' || kind === 'video') && <Btn small label={Platform.OS === 'ios' ? 'Save to Photos' : 'Save to Gallery'} onPress={() => void toGallery()} />}
                <Btn small label="Save to Files" onPress={() => void toFiles()} />
                <Btn small label="Open" onPress={() => void open()} />
                <Btn small label="Share" onPress={() => void share()} />
              </>}
            </View>
          </View>
        : <Text selectable={false} style={{ color: c.text, fontSize: 16, marginRight: 14 }}>{m.text}</Text>}
        <Text style={{ alignSelf: 'flex-end', color: c.muted, fontSize: 11 }}>
          {m.editedAt && !m.deleted ? 'Edited · ' : ''}{m.expiresAt ? '⏳ ' : ''}{time(m.createdAt)}<Text style={{ color: readColor }}>{tick}</Text>
        </Text>
        {m.mine && m.op === 'edit_pending' && <Text style={{ color: c.muted, fontSize: 11 }}>Edit waiting to reach {peerName}</Text>}
        {m.mine && m.op === 'delete_pending' && <Text style={{ color: c.muted, fontSize: 11 }}>Deletion waiting to reach {peerName}</Text>}
        {m.mine && m.op === 'op_failed' && <Text style={{ color: c.danger, fontSize: 11 }}>{peerName}'s CLAN could not apply this change</Text>}
        {m.mine && m.state === 'failed' && m.kind === 'text' && <Btn small label="Retry" onPress={() => onAct(() => people().retryMessage(m.id))} />}
      </Pressable>
      {!!reactions.length && <View style={{ flexDirection: 'row', marginTop: -6, marginHorizontal: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border }}>
        <Text accessibilityLabel={`Reactions ${reactions.join(' ')}`}>{[...new Set(reactions)].join('')}{reactions.length > 1 ? ` ${reactions.length}` : ''}</Text></View>}
      {last && <View style={{ height: 2 }} />}
    </View>
  );
}

function ForwardSheet({ m, from, onClose, onError }: { m: PeopleMessage | null; from: string; onClose(): void; onError(e: string): void }) {
  const convs = useData(() => people().conversations().filter((x) => x.state === 'active' && x.id !== from)) ?? [];
  const go = async (to: string) => {
    if (!m) return; onClose();
    try {
      if (m.kind === 'text' && m.text) people().sendText(to, m.text);
      else if (m.transfer) { const p = m.mine ? people().outgoingBytesLocal(m.transfer.id) : people().filePath(m.transfer.id); if (!p) throw new Error('This file is not on this phone.'); await people().offerFile(to, p, { name: m.transfer.name, mime: m.transfer.mime }); }
      bump(); tick();
    } catch (e) { onError((e as Error).message); }
  };
  return <Sheet open={!!m} onClose={onClose} title="Forward to">
    {!convs.length && <View style={{ padding: 16 }}><Muted>No other active chats.</Muted></View>}
    {convs.map((x) => <SheetItem key={x.id} label={x.peerName} glyph="💬" onPress={() => void go(x.id)} />)}
  </Sheet>;
}

/** Bottom sheet: thumb-reachable, safe-area aware, dismissed by tapping outside or back. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose(): void; title?: string; children: ReactNode }) {
  const c = useC(), insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable accessibilityLabel="Close" style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={onClose} />
      <View style={{ backgroundColor: c.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 8, paddingBottom: Math.max(12, insets.bottom), maxHeight: '75%' }}>
        <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 6 }} />
        {title && <Text accessibilityRole="header" style={{ color: c.text, fontWeight: '800', fontSize: 16, paddingHorizontal: 18, paddingVertical: 6 }}>{title}</Text>}
        <View>{children}</View>
      </View>
    </Modal>
  );
}
export function SheetItem({ label, glyph, onPress, danger }: { label: string; glyph: string; onPress(): void; danger?: boolean }) {
  const c = useC();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: 18, backgroundColor: pressed ? c.bg2 : 'transparent' })}>
    <Text style={{ fontSize: 18, width: 26, textAlign: 'center' }}>{glyph}</Text><Text style={{ color: danger ? c.danger : c.text, fontSize: 16 }}>{label}</Text>
  </Pressable>;
}

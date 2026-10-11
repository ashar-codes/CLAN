// Mobile chat: the same wire contracts as desktop (group + direct conversations, text, attachments), over the pinned
// native transport. The Outbox is a file on the phone, so unsent messages survive an app restart and are re-sent with
// the same ids (the host recognises repeats). Files go only to the conversation that is open (the whole CLAN, or the one
// person of a direct conversation); the host re-checks that scope on every send.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as Notifications from 'expo-notifications';
import { Directory, File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { api, catchUpChat, mergeChatMessages as merge, formatBytes } from '@classroom/client';
import type { ChatMessageView, ChatThreadView, ClientMessage, ResourceView, ServerMessage } from '@classroom/protocol';
import { download, shareFile, type Conn, type FileState } from './transfers';
import { phoneClan, me as meP } from './core/clan';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
/** A local notice for a message that arrives while you're not looking at that conversation (text only if short). */
async function notify(title: string, body: string) {
  const p = await Notifications.getPermissionsAsync();
  if (!p.granted) return;
  await Notifications.scheduleNotificationAsync({ content: { title, body: body.slice(0, 120) }, trigger: null });
}

type C = { text: string; muted: string; border: string; surface: string; accent: string; danger: string };
type Send = Extract<ClientMessage, { t: 'chat.send' }>;
const dir = () => new Directory(Paths.document, 'CLAN');
const outboxFile = () => new File(dir(), 'chat-outbox.json');
const readJson = <T,>(f: File, fallback: T): T => { try { return f.exists ? JSON.parse(f.textSync()) : fallback; } catch { return fallback; } };
const writeJson = (f: File, v: unknown) => { if (!dir().exists) dir().create({ intermediates: true }); f.write(JSON.stringify(v)); };
const outbox = {
  list: (clanId: string) => readJson<Record<string, Send[]>>(outboxFile(), {})[clanId] ?? [],
  add(clanId: string, m: Send) { const all = readJson<Record<string, Send[]>>(outboxFile(), {}); all[clanId] = [...(all[clanId] ?? []).filter((x) => x.id !== m.id), m]; writeJson(outboxFile(), all); },
  sent(id: string) { const all = readJson<Record<string, Send[]>>(outboxFile(), {}); for (const k of Object.keys(all)) all[k] = all[k]!.filter((x) => x.id !== id); writeJson(outboxFile(), all); },
};

/** Chat state; `onServer` must receive every server message of this connection. */
export function useMobileChat(conn: Conn, clanId: string, send: (m: ClientMessage) => void) {
  const [me, setMe] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThreadView[]>([]);
  const [msgs, setMsgs] = useState<Record<string, ChatMessageView[]>>({});
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState('');
  const loaded = useRef(new Set<string>()), paging = useRef(false);
  const viewing = useRef(false);
  const [pending, setPending] = useState<Record<string, { m: Send; failed?: string; at: number }>>({});
  const [active, setActive] = useState<string | null>(null);
  const ref = useRef({ active, me, msgs, pending }); ref.current = { active, me, msgs, pending };
  const get = useCallback(<T,>(path: string, init?: RequestInit) => api<T>(conn.transport, conn.url, conn.token, path, init), [conn]);
  const [opening, setOpening] = useState(false);

  const open = useCallback(async (id: string) => {
    setActive(id);
    setOpening(true);
    try {
      if (!loaded.current.has(id)) {
        const p = await get<{ messages: ChatMessageView[] }>(`/api/chat/threads/${id}/messages?limit=50`);
        const through = p.messages.at(-1)?.seq ?? 0;
        setMsgs((x) => ({ ...x, [id]: merge(p.messages, (x[id] ?? []).filter((m) => m.seq > through)) }));
        setMore((x) => ({ ...x, [id]: p.messages.length === 50 && (p.messages[0]?.seq ?? 1) > 1 }));
        loaded.current.add(id);
        if (through) send({ t: 'chat.cursor', threadId: id, delivered: through });
      }
      setError('');
    } catch (e) { setError((e as Error).message); }
    finally { setOpening(false); }
  }, [get, send]);

  const loadEarlier = useCallback(async (id: string) => {
    if (paging.current) return;
    const first = ref.current.msgs[id]?.[0]?.seq;
    if (!first || first <= 1) { setMore((x) => ({ ...x, [id]: false })); return; }
    paging.current = true; setLoadingEarlier(true);
    try {
      const p = await get<{ messages: ChatMessageView[] }>(`/api/chat/threads/${id}/messages?before=${first}&limit=50`);
      setMsgs((x) => ({ ...x, [id]: merge(x[id] ?? [], p.messages) }));
      setMore((x) => ({ ...x, [id]: p.messages.length === 50 && (p.messages[0]?.seq ?? 1) > 1 })); setError('');
    } catch (e) { setError((e as Error).message); }
    finally { paging.current = false; setLoadingEarlier(false); }
  }, [get]);

  const refresh = useCallback(async () => {
    const r = await get<{ me: string; host: string; threads: ChatThreadView[] }>('/api/chat/threads');
    setMe(r.me); setHost(r.host); setThreads(r.threads);
    const list = outbox.list(clanId);
    setPending((p) => ({ ...p, ...Object.fromEntries(list.map((m) => [m.id, { m, at: Date.now() }])) }));
    for (const m of list) send(m);
    // (Re)connected: messages sent while the socket was down only show up in the thread list's unread count — reload
    // the conversation that is open so they appear.
    for (const id of loaded.current) {
      const thread = r.threads.find((t) => t.id === id); if (!thread) continue;
      const after = Math.max(0, (ref.current.msgs[id]?.[0]?.seq ?? 1) - 1); // edits/removals keep their original seq
      await catchUpChat(after, thread.lastSeq, async (cursor) => (await get<{ messages: ChatMessageView[] }>(`/api/chat/threads/${id}/messages?after=${cursor}&limit=200`)).messages,
        (messages) => setMsgs((x) => ({ ...x, [id]: merge(x[id] ?? [], messages) })));
    }
    setError('');
  }, [get, clanId, send, open]);

  /** No composer while a direct conversation opens, so nothing typed meanwhile goes to the wrong conversation. */
  const openDirect = useCallback(async (to: string) => {
    setOpening(true);
    try {
      const t = await get<ChatThreadView>('/api/chat/direct', { method: 'POST', body: JSON.stringify({ to }) });
      setThreads((ts) => [...ts.filter((x) => x.id !== t.id), t]);
      await open(t.id);
    } finally { setOpening(false); }
  }, [get, open]);

  const post = useCallback((threadId: string, body: string, extra: Partial<Send> = {}) => {
    const m: Send = { t: 'chat.send', id: randomUUID(), thread: { id: threadId }, body, ...extra };
    outbox.add(clanId, m); // durable before it leaves
    setPending((p) => ({ ...p, [m.id]: { m, at: Date.now() } }));
    send(m);
  }, [clanId, send]);

  const onServer = useCallback((m: ServerMessage) => {
    if (m.t === 'hello' || (m.t === 'member.status' && m.status === 'approved')) void refresh().catch((e) => setError((e as Error).message));
    else if (m.t === 'chat.ack') { outbox.sent(m.id); setPending(({ [m.id]: _, ...rest }) => rest); }
    else if (m.t === 'chat.nack' && m.code !== 'rate_limited') { outbox.sent(m.id); setPending((p) => (p[m.id] ? { ...p, [m.id]: { ...p[m.id]!, failed: m.message } } : p)); }
    else if (m.t === 'chat.message') {
      setMsgs((x) => ({ ...x, [m.thread.id]: merge(x[m.thread.id] ?? [], [m.message]) }));
      const reading = viewing.current && AppState.currentState === 'active' && ref.current.active === m.thread.id;
      setThreads((ts) => [...ts.filter((t) => t.id !== m.thread.id), reading ? { ...m.thread, unread: 0 } : m.thread]);
      if (m.message.author !== ref.current.me) {
        send({ t: 'chat.cursor', threadId: m.thread.id, delivered: m.message.seq, ...(reading ? { read: m.message.seq } : {}) });
        if (!reading || AppState.currentState !== 'active') void notify(m.thread.kind === 'direct' ? m.message.authorName : `${m.message.authorName} · ${conn.classTitle}`, m.message.attachment?.kind === 'file' ? `sent ${m.message.attachment.name}` : m.message.body).catch(() => {});
      }
    }
  }, [refresh, send, conn.classTitle]);
  useEffect(() => { void Notifications.requestPermissionsAsync().catch(() => {}); }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      for (const p of Object.values(ref.current.pending)) if (!p.failed && Date.now() - p.at >= 8000) { p.at = Date.now(); send(p.m); }
    }, 1000);
    return () => clearInterval(timer);
  }, [send]);
  const setViewing = useCallback((visible: boolean) => {
    viewing.current = visible;
    const id = ref.current.active, last = id ? ref.current.msgs[id]?.at(-1)?.seq : null;
    if (visible && id && last && AppState.currentState === 'active') {
      send({ t: 'chat.cursor', threadId: id, delivered: last, read: last });
      setThreads((ts) => ts.map((t) => t.id === id ? { ...t, unread: 0 } : t));
    }
  }, [send]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state === 'active') setViewing(viewing.current); });
    return () => sub.remove();
  }, [setViewing]);
  const retry = useCallback((id: string) => {
    const p = ref.current.pending[id]; if (!p) return;
    outbox.add(clanId, p.m);
    setPending((x) => ({ ...x, [id]: { m: p.m, at: Date.now() } })); send(p.m);
  }, [clanId, send]);
  const discard = useCallback((id: string) => { outbox.sent(id); setPending(({ [id]: _, ...rest }) => rest); }, []);

  /** Attach a file to the OPEN conversation only: the audience is fixed before the upload starts. */
  const [sending, setSending] = useState<{ name: string; sent: number; size: number; error?: string; notice?: string } | null>(null);
  const sendFile = useCallback(async (thread: ChatThreadView, file: { uri: string; name: string; size: number }) => {
    const to = thread.kind === 'group' ? 'clan' : thread.with?.handle;
    if (!to) return;
    setSending({ name: file.name, sent: 0, size: file.size });
    try {
      const r = await shareFile(conn, file, to, randomUUID(), (sent, size) => setSending({ name: file.name, sent, size }));
      if ('pending' in r) { setSending({ name: file.name, sent: file.size, size: file.size, notice: 'Sent for teacher approval. Approved files appear in Classroom files.' }); return; }
      post(thread.id, '', { attachment: { kind: 'file', resourceId: r.id } });
      setSending(null);
    } catch (e) { setSending({ name: file.name, sent: 0, size: file.size, error: (e as Error).message }); }
  }, [conn, post]);
  return { me, host, threads, msgs, more, loadingEarlier, error, pending, retry, discard, active, setActive, setViewing, open, openDirect, loadEarlier, post, onServer, opening, sendFile, sending };
}
export type MobileChat = ReturnType<typeof useMobileChat>;

export function ChatSection({ c, chat, conn, people, canSendFiles }: { c: C; chat: MobileChat; conn: Conn; people: { name: string; handle: string; host: boolean }[]; canSendFiles: boolean }) {
  const [shown, setShown] = useState(false);
  const [away, setAway] = useState(false);
  const following = useRef(true);
  const log = useRef<FlatList<ChatMessageView>>(null);
  // Drafts belong to one conversation: switching conversations never carries typed text to another audience.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fromInbox, setFromInbox] = useState(false);
  const [files, setFiles] = useState<Record<string, FileState>>({});
  const t = chat.threads.find((x) => x.id === chat.active);
  const text = t ? drafts[t.id] ?? '' : '';
  const setText = (v: string) => { if (t) setDrafts((d) => ({ ...d, [t.id]: v })); };
  const group = chat.threads.find((x) => x.kind === 'group');
  useEffect(() => { if (!chat.active && group) void chat.open(group.id).catch(() => {}); }, [group?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const others = people.filter((p) => p.handle && p.handle !== chat.me);
  const reach = others.length ? others : chat.host ? [{ name: 'Host', handle: chat.host, host: true }] : [];
  const list = t ? chat.msgs[t.id] ?? [] : [];
  useEffect(() => { chat.setViewing(shown && !chat.opening); return () => chat.setViewing(false); }, [shown, t?.id, chat.opening, chat.setViewing]);
  useEffect(() => { following.current = true; setAway(false); log.current?.scrollToOffset({ offset: 0, animated: false }); }, [t?.id, shown]);
  const waiting = Object.values(chat.pending).filter((p) => 'id' in p.m.thread && p.m.thread.id === t?.id && !list.some((m) => m.id === p.m.id));
  const get = (m: ChatMessageView) => {
    if (m.attachment?.kind !== 'file') return;
    const rv: ResourceView = { id: m.attachment.resourceId, name: m.attachment.name, size: m.attachment.size, sha256: m.attachment.sha256, mime: m.attachment.mime, addedAt: 0, status: 'ready', available: true, pushed: false };
    void download({ ...conn, peerAssist: false }, rv, (s) => setFiles((x) => ({ ...x, [s.resourceId]: s }))); // from the host only
  };
  return (
    <View style={[s.card, { borderColor: c.border, backgroundColor: c.surface }]} accessibilityLabel="Chat">
      <Pressable accessibilityRole="button" accessibilityLabel="Open chat" onPress={() => setShown(true)} style={[s.chip, { borderColor: c.accent, minHeight: 44, justifyContent: 'center' }]}>
        <Text style={{ color: c.accent, fontWeight: '700' }}>Open chat{chat.threads.reduce((n, x) => n + x.unread, 0) ? ` · ${chat.threads.reduce((n, x) => n + x.unread, 0)} unread` : ''}</Text>
      </Pressable>
      {!shown && !!list.at(-1)?.body && <Text style={{ color: c.muted }} numberOfLines={2}>{list.at(-1)!.authorName}: {list.at(-1)!.body}</Text>}
      <Modal visible={shown} animationType="slide" onRequestClose={() => setShown(false)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.surface }}>
      <KeyboardAvoidingView style={{ flex: 1, padding: 12, gap: 8 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={{ color: c.text, fontSize: 20, fontWeight: '700' }}>Chat · {conn.classTitle}</Text>
        <Pressable accessibilityRole="button" onPress={() => setShown(false)} style={[s.chip, { minHeight: 44, borderColor: c.border, justifyContent: 'center' }]}><Text style={{ color: c.accent }}>Close chat</Text></Pressable>
      </View>
      <ScrollView horizontal style={{ maxHeight: 64, flexGrow: 0 }} contentContainerStyle={[s.row, { flexWrap: 'nowrap' }]} keyboardShouldPersistTaps="handled" accessibilityLabel="Conversations">
        {chat.threads.map((x) => (
          <Pressable key={x.id} onPress={() => void chat.open(x.id)} accessibilityRole="button" style={[s.chip, { borderColor: x.id === chat.active ? c.accent : c.border }]}>
            <Text numberOfLines={1} style={{ maxWidth: 180, color: c.text, fontWeight: x.id === chat.active ? '700' : '400' }}>{x.kind === 'group' ? 'Everyone' : x.with?.name}{x.unread ? ` · ${x.unread}` : ''}</Text>
          </Pressable>
        ))}
        {reach.filter((p) => !chat.threads.some((x) => x.with?.handle === p.handle)).map((p) => (
          <Pressable key={p.handle} onPress={() => void chat.openDirect(p.handle)} accessibilityRole="button" style={[s.chip, { borderColor: c.border }]}><Text style={{ color: c.accent }}>Send to {p.name}</Text></Pressable>
        ))}
      </ScrollView>
      <Text style={{ color: c.muted, fontSize: 12 }}>{t?.kind === 'direct' ? 'Direct conversation · relayed and kept by the host' : 'Group conversation · kept by the host'}</Text>
      <FlatList<ChatMessageView> ref={log} key={t?.id ?? 'loading'} inverted data={[...list].reverse()} keyExtractor={(m) => m.id}
        style={{ flex: 1 }} contentContainerStyle={{ gap: 6, paddingVertical: 8 }} keyboardShouldPersistTaps="handled"
        accessibilityLabel="Chat messages" maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onScroll={(e) => { following.current = e.nativeEvent.contentOffset.y < 80; setAway(!following.current); }} scrollEventThrottle={32}
        onContentSizeChange={() => { if (following.current) log.current?.scrollToOffset({ offset: 0, animated: false }); }}
        ListEmptyComponent={<Text style={{ color: c.muted }}>No messages yet.</Text>}
        ListHeaderComponent={waiting.length ? <View style={{ gap: 6 }}>{waiting.map((p) => <View key={p.m.id} style={[s.msg, s.own, { borderColor: c.border, opacity: 0.6 }]}><Text style={{ color: c.text }}>{p.m.body}</Text><Text style={{ color: p.failed ? c.danger : c.muted, fontSize: 11 }}>{p.failed ? `Not sent — ${p.failed}` : 'Sending…'}</Text>{p.failed && <View style={s.row}><Pressable accessibilityRole="button" onPress={() => chat.retry(p.m.id)} style={s.chip}><Text style={{ color: c.accent }}>Retry</Text></Pressable><Pressable accessibilityRole="button" onPress={() => chat.discard(p.m.id)} style={s.chip}><Text style={{ color: c.muted }}>Discard</Text></Pressable></View>}</View>)}</View> : null}
        ListFooterComponent={t && chat.more[t.id] ? <Pressable accessibilityRole="button" disabled={chat.loadingEarlier} onPress={() => { following.current = false; void chat.loadEarlier(t.id); }} style={[s.chip, { borderColor: c.border, minHeight: 44, justifyContent: 'center' }]}><Text style={{ color: c.accent }}>{chat.loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}</Text></Pressable> : null}
        renderItem={({ item: m }) => (
          <View key={m.id} style={[s.msg, m.author === chat.me && s.own, { borderColor: c.border }]}>
            {m.author !== chat.me && <Text style={{ color: c.accent, fontWeight: '700', fontSize: 12 }}>{m.authorName}</Text>}
            {m.replyTo && <Text style={{ color: c.muted, fontSize: 12 }}>↪ {list.find((x) => x.id === m.replyTo)?.body.slice(0, 60) ?? 'Earlier message'}</Text>}
            {m.removed ? <Text style={{ color: c.muted, fontStyle: 'italic' }}>Message removed</Text> : !!m.body && <Text style={{ color: c.text }}>{m.body}</Text>}
            {m.attachment?.kind === 'link' && <Text style={{ color: c.accent }}>↗ {m.attachment.title} ({m.attachment.source})</Text>}
            {m.attachment?.kind === 'file' && (
              <Pressable onPress={() => get(m)} accessibilityRole="button" disabled={m.author === chat.me}>
                <Text style={{ color: c.text }}>▤ {m.attachment.name} · {formatBytes(m.attachment.size)} · {files[m.attachment.resourceId]?.state === 'completed' ? 'verified ✓' : m.author === chat.me ? 'sent' : files[m.attachment.resourceId] ? files[m.attachment.resourceId]!.state : 'tap to download'}</Text>
              </Pressable>
            )}
            <Text style={{ color: c.muted, fontSize: 11 }}>{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{m.editedAt ? ' · edited' : ''}{m.reactions.map((r) => ` ${r.reaction}${r.by.length}`).join('')}</Text>
          </View>
        )} />
      {away && <Pressable accessibilityRole="button" style={[s.chip, { borderColor: c.accent, minHeight: 44, justifyContent: 'center' }]} onPress={() => { following.current = true; setAway(false); log.current?.scrollToOffset({ offset: 0, animated: false }); }}><Text style={{ color: c.accent }}>Jump to latest</Text></Pressable>}
      {!!chat.error && <Text style={{ color: c.danger }} accessibilityLiveRegion="polite">{chat.error}</Text>}
      {chat.opening && <Text style={{ color: c.muted }} accessibilityLiveRegion="polite">Opening a conversation…</Text>}
      {t && fromInbox && (
        <View style={{ gap: 4 }} accessibilityLabel="Send from your Inbox">
          <Text style={{ color: c.muted, fontSize: 12 }}>From your Inbox → {t.kind === 'group' ? 'everyone in this CLAN' : t.with?.name}</Text>
          {phoneClan().capture.inbox(meP()).filter((i) => i.module !== 'files').slice(0, 10).map((i) => (
            <Pressable key={i.id} accessibilityRole="button" style={[s.chip, { borderColor: c.border }]} onPress={() => {
              const saved = i.module === 'saved' ? phoneClan().saved.get(meP(), i.entityId) : null, note = i.module === 'notes' ? phoneClan().notes.get(meP(), i.entityId) : null;
              if (saved) chat.post(t.id, '', { attachment: { kind: 'link', url: saved.url, title: saved.title } }); else if (note) chat.post(t.id, note.body.slice(0, 4000) || note.title);
              setFromInbox(false);
            }}><Text style={{ color: c.text }} numberOfLines={1}>{i.kind === 'link' ? '↗ ' : '❝ '}{i.title}</Text></Pressable>
          ))}
        </View>
      )}
      {chat.sending && <Text style={{ color: chat.sending.error ? c.danger : c.muted }} accessibilityLiveRegion="polite">{chat.sending.error ? `${chat.sending.name}: ${chat.sending.error}` : chat.sending.notice ?? `Sending ${chat.sending.name} · ${formatBytes(chat.sending.sent)} of ${formatBytes(chat.sending.size)}`}</Text>}
      {t && !chat.opening && (
        <View style={s.row}>
          {canSendFiles && <Pressable accessibilityRole="button" accessibilityLabel={t.kind === 'group' ? 'Send a file to everyone' : `Send a file to ${t.with?.name}`} disabled={!!chat.sending && !chat.sending.error && !chat.sending.notice}
            onPress={async () => { const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }); const a = !r.canceled && r.assets[0]; if (a && a.size) void chat.sendFile(t, { uri: a.uri, name: a.name, size: a.size }); }}
            style={[s.chip, { borderColor: c.border, minHeight: 44, justifyContent: 'center' }]}><Text style={{ color: c.text }}>📎</Text></Pressable>}
          <Pressable accessibilityRole="button" accessibilityLabel="Send something from your Inbox" onPress={() => setFromInbox(!fromInbox)} style={[s.chip, { borderColor: c.border, minHeight: 44, justifyContent: 'center' }]}><Text style={{ color: c.text }}>⇣</Text></Pressable>
          <TextInput style={[s.input, { color: c.text, borderColor: c.border }]} value={text} onChangeText={setText} maxLength={4000} placeholder="Message" placeholderTextColor={c.muted} accessibilityLabel="Message" multiline />
          <Pressable accessibilityRole="button" disabled={!text.trim()} onPress={() => { following.current = true; setAway(false); chat.post(t.id, text.trim()); setText(''); }} style={[s.chip, { borderColor: c.accent, opacity: text.trim() ? 1 : 0.5, minHeight: 44, justifyContent: 'center' }]}><Text style={{ color: c.accent, fontWeight: '700' }}>Send</Text></Pressable>
        </View>
      )}
      </KeyboardAvoidingView></SafeAreaView></Modal>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 12, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, minHeight: 44, justifyContent: 'center' },
  msg: { borderWidth: 1, borderRadius: 12, padding: 8, maxWidth: '88%', alignSelf: 'flex-start', gap: 2 },
  own: { alignSelf: 'flex-end' },
  input: { flex: 1, minHeight: 44, maxHeight: 120, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10 },
});

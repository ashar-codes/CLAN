// Mobile chat: the same wire contracts as desktop (group + direct conversations, text, attachments), over the pinned
// native transport. The Outbox is a file on the phone, so unsent messages survive an app restart and are re-sent with
// the same ids (the host recognises repeats). Files go only to the conversation that is open (the whole CLAN, or the one
// person of a direct conversation); the host re-checks that scope on every send.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Notifications from 'expo-notifications';
import { Directory, File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { api, formatBytes } from '@classroom/client';
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
  const [pending, setPending] = useState<Record<string, { m: Send; failed?: string }>>({});
  const [active, setActive] = useState<string | null>(null);
  const ref = useRef({ active, me }); ref.current = { active, me };
  const get = useCallback(<T,>(path: string, init?: RequestInit) => api<T>(conn.transport, conn.url, conn.token, path, init), [conn]);
  const merge = (list: ChatMessageView[], add: ChatMessageView[]) => [...new Map([...list, ...add].map((x) => [x.id, x])).values()].sort((a, b) => a.seq - b.seq);

  const refresh = useCallback(async () => {
    const r = await get<{ me: string; host: string; threads: ChatThreadView[] }>('/api/chat/threads');
    setMe(r.me); setHost(r.host); setThreads(r.threads);
    const list = outbox.list(clanId);
    setPending((p) => ({ ...p, ...Object.fromEntries(list.map((m) => [m.id, { m }])) }));
    for (const m of list) send(m);
  }, [get, clanId, send]);

  const open = useCallback(async (id: string) => {
    setActive(id);
    const p = await get<{ messages: ChatMessageView[] }>(`/api/chat/threads/${id}/messages?limit=50`);
    setMsgs((x) => ({ ...x, [id]: merge(x[id] ?? [], p.messages) }));
    const last = p.messages.at(-1)?.seq;
    if (last) send({ t: 'chat.cursor', threadId: id, delivered: last, read: last });
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, unread: 0 } : t)));
  }, [get, send]);

  /** No composer while a direct conversation opens, so nothing typed meanwhile goes to the wrong conversation. */
  const [opening, setOpening] = useState(false);
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
    setPending((p) => ({ ...p, [m.id]: { m } }));
    send(m);
  }, [clanId, send]);

  const onServer = useCallback((m: ServerMessage) => {
    if (m.t === 'hello' || (m.t === 'member.status' && m.status === 'approved')) void refresh().catch(() => {});
    else if (m.t === 'chat.ack') { outbox.sent(m.id); setPending(({ [m.id]: _, ...rest }) => rest); }
    else if (m.t === 'chat.nack' && m.code !== 'rate_limited') { outbox.sent(m.id); setPending((p) => (p[m.id] ? { ...p, [m.id]: { ...p[m.id]!, failed: m.message } } : p)); }
    else if (m.t === 'chat.message') {
      setMsgs((x) => ({ ...x, [m.thread.id]: merge(x[m.thread.id] ?? [], [m.message]) }));
      const reading = ref.current.active === m.thread.id;
      setThreads((ts) => [...ts.filter((t) => t.id !== m.thread.id), reading ? { ...m.thread, unread: 0 } : m.thread]);
      if (m.message.author !== ref.current.me) {
        send({ t: 'chat.cursor', threadId: m.thread.id, delivered: m.message.seq, ...(reading ? { read: m.message.seq } : {}) });
        if (!reading || AppState.currentState !== 'active') void notify(m.thread.kind === 'direct' ? m.message.authorName : `${m.message.authorName} · ${conn.classTitle}`, m.message.attachment?.kind === 'file' ? `sent ${m.message.attachment.name}` : m.message.body).catch(() => {});
      }
    }
  }, [refresh, send, conn.classTitle]);
  useEffect(() => { void Notifications.requestPermissionsAsync().catch(() => {}); }, []);

  /** Attach a file to the OPEN conversation only: the audience is fixed before the upload starts. */
  const [sending, setSending] = useState<{ name: string; sent: number; size: number; error?: string } | null>(null);
  const sendFile = useCallback(async (thread: ChatThreadView, file: { uri: string; name: string; size: number }) => {
    const to = thread.kind === 'group' ? 'clan' : thread.with?.handle;
    if (!to) return;
    setSending({ name: file.name, sent: 0, size: file.size });
    try {
      const r = await shareFile(conn, file, to, randomUUID(), (sent, size) => setSending({ name: file.name, sent, size }));
      post(thread.id, '', { attachment: { kind: 'file', resourceId: r.id } });
      setSending(null);
    } catch (e) { setSending({ name: file.name, sent: 0, size: file.size, error: (e as Error).message }); }
  }, [conn, post]);
  return { me, host, threads, msgs, pending, active, setActive, open, openDirect, post, onServer, opening, sendFile, sending };
}
export type MobileChat = ReturnType<typeof useMobileChat>;

export function ChatSection({ c, chat, conn, people }: { c: C; chat: MobileChat; conn: Conn; people: { name: string; handle: string; host: boolean }[] }) {
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
  const waiting = Object.values(chat.pending).filter((p) => 'id' in p.m.thread && p.m.thread.id === t?.id && !list.some((m) => m.id === p.m.id));
  const get = (m: ChatMessageView) => {
    if (m.attachment?.kind !== 'file') return;
    const rv: ResourceView = { id: m.attachment.resourceId, name: m.attachment.name, size: m.attachment.size, sha256: m.attachment.sha256, mime: m.attachment.mime, addedAt: 0, status: 'ready', available: true, pushed: false };
    void download({ ...conn, peerAssist: false }, rv, (s) => setFiles((x) => ({ ...x, [s.resourceId]: s }))); // from the host only
  };
  return (
    <View style={[s.card, { borderColor: c.border, backgroundColor: c.surface }]} accessibilityLabel="Chat">
      <View style={s.row}>
        {chat.threads.map((x) => (
          <Pressable key={x.id} onPress={() => void chat.open(x.id)} accessibilityRole="button" style={[s.chip, { borderColor: x.id === chat.active ? c.accent : c.border }]}>
            <Text style={{ color: c.text, fontWeight: x.id === chat.active ? '700' : '400' }}>{x.kind === 'group' ? 'Everyone' : x.with?.name}{x.unread ? ` · ${x.unread}` : ''}</Text>
          </Pressable>
        ))}
        {reach.filter((p) => !chat.threads.some((x) => x.with?.handle === p.handle)).map((p) => (
          <Pressable key={p.handle} onPress={() => void chat.openDirect(p.handle)} accessibilityRole="button" style={[s.chip, { borderColor: c.border }]}><Text style={{ color: c.accent }}>Send to {p.name}</Text></Pressable>
        ))}
      </View>
      <Text style={{ color: c.muted, fontSize: 12 }}>{t?.kind === 'direct' ? 'Direct conversation · relayed and kept by the host' : 'Group conversation · kept by the host'}</Text>
      <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
        {list.map((m) => (
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
        ))}
        {waiting.map((p) => <View key={p.m.id} style={[s.msg, s.own, { borderColor: c.border, opacity: 0.6 }]}><Text style={{ color: c.text }}>{p.m.body}</Text><Text style={{ color: p.failed ? c.danger : c.muted, fontSize: 11 }}>{p.failed ? `Not sent — ${p.failed}` : 'Sending…'}</Text></View>)}
      </View>
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
      {chat.sending && <Text style={{ color: chat.sending.error ? c.danger : c.muted }} accessibilityLiveRegion="polite">{chat.sending.error ? `${chat.sending.name}: ${chat.sending.error}` : `Sending ${chat.sending.name} · ${formatBytes(chat.sending.sent)} of ${formatBytes(chat.sending.size)}`}</Text>}
      {t && !chat.opening && (
        <View style={s.row}>
          <Pressable accessibilityRole="button" accessibilityLabel={t.kind === 'group' ? 'Send a file to everyone' : `Send a file to ${t.with?.name}`} disabled={!!chat.sending && !chat.sending.error}
            onPress={async () => { const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }); const a = !r.canceled && r.assets[0]; if (a && a.size) void chat.sendFile(t, { uri: a.uri, name: a.name, size: a.size }); }}
            style={[s.chip, { borderColor: c.border, minHeight: 44, justifyContent: 'center' }]}><Text style={{ color: c.text }}>📎</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Send something from your Inbox" onPress={() => setFromInbox(!fromInbox)} style={[s.chip, { borderColor: c.border, minHeight: 44, justifyContent: 'center' }]}><Text style={{ color: c.text }}>⇣</Text></Pressable>
          <TextInput style={[s.input, { color: c.text, borderColor: c.border }]} value={text} onChangeText={setText} maxLength={4000} placeholder="Message" placeholderTextColor={c.muted} accessibilityLabel="Message" multiline />
          <Pressable accessibilityRole="button" disabled={!text.trim()} onPress={() => { chat.post(t.id, text.trim()); setText(''); }} style={[s.chip, { borderColor: c.accent, opacity: text.trim() ? 1 : 0.5 }]}><Text style={{ color: c.accent, fontWeight: '700' }}>Send</Text></Pressable>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 12, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  msg: { borderWidth: 1, borderRadius: 12, padding: 8, maxWidth: '88%', alignSelf: 'flex-start', gap: 2 },
  own: { alignSelf: 'flex-end' },
  input: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10 },
});

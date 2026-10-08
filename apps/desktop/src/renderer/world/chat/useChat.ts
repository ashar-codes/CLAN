// Chat state for one live CLAN connection (always loaded, small). The UI (ChatPanel) is a lazy chunk.
// Sending: the message goes to the durable Outbox first, then over the existing WSS; it stays SENDING until the host
// acknowledges it, and is re-sent with the same id after every reconnect — the host recognises repeats.
// Delivery states are only what the host can know: SENT (stored), DELIVERED / READ (the recipient's own cursor reports).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttachmentInput, ChatCursors, ChatMessageView, ChatThreadView, ClientMessage, ServerMessage } from '@classroom/protocol';
import type { ChatConn } from '../../../shared.ts';
import { api } from '../../App.tsx';

type Send = Extract<ClientMessage, { t: 'chat.send' }>;
export type Pending = { payload: Send; state: 'sending' | 'failed'; error?: string; at: number };
export type Delivery = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
export type ChatPerson = { handle: string; name: string; host: boolean; connected: boolean };
type Target = Send['thread'];
const PAGE = 50;
const byId = (list: ChatMessageView[], add: ChatMessageView[]) => {
  const m = new Map(list.map((x) => [x.id, x]));
  for (const x of add) m.set(x.id, x);
  return [...m.values()].sort((a, b) => a.seq - b.seq);
};

export function useChat(o: { role: 'host' | 'member'; conn: ChatConn; clanId: string | null; send(m: ClientMessage): void }) {
  const [me, setMe] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThreadView[]>([]);
  const [msgs, setMsgs] = useState<Record<string, ChatMessageView[]>>({});
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [cursors, setCursors] = useState<Record<string, ChatCursors>>({});
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [typing, setTyping] = useState<Record<string, { handle: string; name: string; until: number }[]>>({});
  const [active, setActiveState] = useState<string | null>(null);
  const [error, setError] = useState('');
  const ref = useRef({ o, me, active, threads, msgs, pending });
  ref.current = { o, me, active, threads, msgs, pending };
  const loaded = useRef(new Set<string>());
  const lastTyping = useRef(0);
  const clanId = o.clanId;

  const http = useCallback(<T,>(method: 'GET' | 'POST', path: string, body?: { to: string }) => api.chat.http<T>(ref.current.o.conn, { method, path, body }), []);
  const upsertThread = (t: ChatThreadView) => setThreads((ts) => [t, ...ts.filter((x) => x.id !== t.id)].sort((a, b) => (a.kind === 'group' ? -1 : b.kind === 'group' ? 1 : b.updatedAt - a.updatedAt)));
  const cache = (t: ChatThreadView, list: ChatMessageView[]) => { const m = ref.current.me; if (ref.current.o.role === 'member' && m && list.length) void api.chat.ingest(t, m, list).catch(() => {}); };

  /** Tell the host what this device received / showed (truthful delivery state for senders). */
  const report = useCallback((threadId: string, seq: number, read: boolean) => {
    ref.current.o.send({ t: 'chat.cursor', threadId, delivered: seq, ...(read ? { read: seq } : {}) });
    if (read) void api.notify.readThread(threadId);
  }, []);
  const visible = () => document.visibilityState === 'visible' && document.hasFocus();

  const refresh = useCallback(async () => {
    try {
      const r = await http<{ me: string; host: string; threads: ChatThreadView[] }>('GET', '/api/chat/threads');
      setMe(r.me); setHost(r.host); setThreads(r.threads); setError('');
      if (ref.current.o.role === 'member' && ref.current.o.clanId) void api.chat.setMe(ref.current.o.clanId, r.me);
      // Catch up the conversations already open on screen (after a reconnect).
      for (const id of loaded.current) {
        const last = ref.current.msgs[id]?.at(-1)?.seq ?? 0;
        const p = await http<{ messages: ChatMessageView[]; cursors: ChatCursors }>('GET', `/api/chat/threads/${id}/messages?after=${last}&limit=200`);
        setMsgs((m) => ({ ...m, [id]: byId(m[id] ?? [], p.messages) }));
        setCursors((c) => ({ ...c, [id]: p.cursors }));
        const t = r.threads.find((x) => x.id === id);
        if (t) cache(t, p.messages);
      }
    } catch (e) { setError((e as Error).message); }
  }, [http]);

  /** Re-send everything still in the Outbox (same ids: the host answers repeats with the stored message). */
  const flush = useCallback(async () => {
    if (!ref.current.o.clanId) return;
    const list = await api.chat.outbox(ref.current.o.clanId).catch(() => [] as Send[]);
    setPending((p) => { const n = { ...p }; for (const x of list) n[x.id] ??= { payload: x, state: 'sending', at: Date.now() }; return n; });
    for (const x of list) ref.current.o.send(x);
  }, []);

  const open = useCallback(async (threadId: string | null) => {
    setActiveState(threadId);
    void api.notify.context({ viewing: threadId });
    if (!threadId) return;
    if (!loaded.current.has(threadId)) {
      const p = await http<{ messages: ChatMessageView[]; cursors: ChatCursors }>('GET', `/api/chat/threads/${threadId}/messages?limit=${PAGE}`);
      loaded.current.add(threadId);
      setMsgs((m) => ({ ...m, [threadId]: byId(m[threadId] ?? [], p.messages) }));
      setCursors((c) => ({ ...c, [threadId]: p.cursors }));
      setMore((x) => ({ ...x, [threadId]: p.messages.length === PAGE }));
      const t = ref.current.threads.find((x) => x.id === threadId);
      if (t) cache(t, p.messages);
    }
    const last = ref.current.threads.find((t) => t.id === threadId)?.lastSeq ?? 0;
    if (last && visible()) { report(threadId, last, true); setThreads((ts) => ts.map((t) => (t.id === threadId ? { ...t, unread: 0, readSeq: last } : t))); }
  }, [http, report]);

  const loadEarlier = useCallback(async (threadId: string) => {
    const first = ref.current.msgs[threadId]?.[0]?.seq;
    if (!first || first <= 1) return setMore((x) => ({ ...x, [threadId]: false }));
    const p = await http<{ messages: ChatMessageView[] }>('GET', `/api/chat/threads/${threadId}/messages?before=${first}&limit=${PAGE}`);
    setMsgs((m) => ({ ...m, [threadId]: byId(m[threadId] ?? [], p.messages) }));
    setMore((x) => ({ ...x, [threadId]: p.messages.length === PAGE }));
  }, [http]);

  /** While a direct conversation opens, no composer is shown — so nothing typed meanwhile can go to the wrong conversation. */
  const [opening, setOpening] = useState<string | null>(null);
  const openDirect = useCallback(async (handle: string) => {
    setOpening(handle);
    try {
      const t = await http<ChatThreadView>('POST', '/api/chat/direct', { to: handle });
      upsertThread(t);
      await open(t.id);
      return t.id;
    } finally { setOpening(null); }
  }, [http, open]);

  const post = useCallback(async (target: Target, body: string, extra: { replyTo?: string; attachment?: AttachmentInput } = {}) => {
    const payload: Send = { t: 'chat.send', id: crypto.randomUUID(), thread: target, body, ...extra };
    if (ref.current.o.clanId) await api.chat.outboxAdd(ref.current.o.clanId, payload); // durable before it leaves
    setPending((p) => ({ ...p, [payload.id]: { payload, state: 'sending', at: Date.now() } }));
    ref.current.o.send(payload);
    return payload.id;
  }, []);
  const retry = useCallback((id: string) => {
    const p = ref.current.pending[id];
    if (!p) return;
    if (ref.current.o.clanId) void api.chat.outboxAdd(ref.current.o.clanId, p.payload);
    setPending((x) => ({ ...x, [id]: { ...p, state: 'sending', error: undefined, at: Date.now() } }));
    ref.current.o.send(p.payload);
  }, []);
  const discard = useCallback((id: string) => { void api.chat.outboxSent(id); setPending((x) => { const n = { ...x }; delete n[id]; return n; }); }, []);

  /** Every server message passes through here (the dashboards forward them). */
  const onServer = useCallback((m: ServerMessage) => {
    if (m.t === 'hello' || (m.t === 'member.status' && m.status === 'approved')) { void refresh().then(flush); return; }
    if (m.t === 'members' && m.me) setMe(m.me);
    if (m.t === 'chat.ack') {
      void api.chat.outboxSent(m.id);
      setPending((p) => { const n = { ...p }; delete n[m.id]; return n; });
    } else if (m.t === 'chat.nack') {
      if (m.code === 'rate_limited') { setTimeout(() => retry(m.id), 3000); return; } // transient: stays in the Outbox
      void api.chat.outboxSent(m.id);
      setPending((p) => (p[m.id] ? { ...p, [m.id]: { ...p[m.id]!, state: 'failed', error: m.message } } : p));
    } else if (m.t === 'chat.message') {
      const { message: msg, thread } = m;
      setMsgs((x) => ({ ...x, [thread.id]: byId(x[thread.id] ?? [], [msg]) }));
      const mine = msg.author === ref.current.me;
      const reading = ref.current.active === thread.id && visible();
      upsertThread(reading || mine ? { ...thread, unread: 0, readSeq: Math.max(thread.readSeq, msg.seq) } : thread);
      cache(thread, [msg]);
      if (!mine) report(thread.id, msg.seq, reading);
      setTyping((t) => ({ ...t, [thread.id]: (t[thread.id] ?? []).filter((x) => x.handle !== msg.author) }));
    } else if (m.t === 'chat.cursors') setCursors((c) => ({ ...c, [m.threadId]: m.cursors }));
    else if (m.t === 'chat.typing') setTyping((t) => ({ ...t, [m.threadId]: [...(t[m.threadId] ?? []).filter((x) => x.handle !== m.handle), { handle: m.handle, name: m.name, until: Date.now() + Math.min(8000, Math.max(0, m.until - Date.now())) }] }));
  }, [refresh, flush, report, retry]);

  // Expire typing locally; re-send anything stuck in SENDING (a send can be lost on a half-open socket).
  useEffect(() => {
    const t = setInterval(() => {
      setTyping((x) => { const now = Date.now(); let changed = false; const n: typeof x = {};
        for (const [k, v] of Object.entries(x)) { const keep = v.filter((y) => y.until > now); if (keep.length !== v.length) changed = true; n[k] = keep; }
        return changed ? n : x; });
      for (const p of Object.values(ref.current.pending)) if (p.state === 'sending' && Date.now() - p.at > 8000) { p.at = Date.now(); ref.current.o.send(p.payload); }
    }, 1000);
    return () => clearInterval(t);
  }, []);
  // Coming back to the window marks the open conversation read.
  useEffect(() => {
    const f = () => { const a = ref.current.active, t = ref.current.threads.find((x) => x.id === a); if (a && t?.lastSeq && visible()) { report(a, t.lastSeq, true); setThreads((ts) => ts.map((x) => (x.id === a ? { ...x, unread: 0 } : x))); } };
    addEventListener('focus', f); return () => removeEventListener('focus', f);
  }, [report]);
  useEffect(() => () => { void api.notify.context({ viewing: null }); }, []);

  const typingPing = useCallback((threadId: string) => {
    if (Date.now() - lastTyping.current < 2500) return;
    lastTyping.current = Date.now();
    ref.current.o.send({ t: 'chat.typing', threadId });
  }, []);

  /** What the sender can truthfully show for its own message. */
  const delivery = useCallback((t: ChatThreadView, m: ChatMessageView): { state: Delivery; seen: number } => {
    const others = Object.entries(cursors[t.id] ?? {}).filter(([h]) => h !== me);
    const read = others.filter(([, c]) => c.read >= m.seq).length, got = others.filter(([, c]) => c.delivered >= m.seq).length;
    return { state: read ? 'read' : got ? 'delivered' : 'sent', seen: read };
  }, [cursors, me]);

  const unread = useMemo(() => threads.reduce((n, t) => n + t.unread, 0), [threads]);
  return {
    me, host, threads, msgs, more, cursors, pending, typing, active, error, unread, clanId, conn: o.conn, opening,
    open, openDirect, loadEarlier, post, retry, discard, onServer, typingPing, delivery, refresh,
    react: (id: string, reaction: string, on: boolean) => o.send({ t: 'chat.react', id, reaction: reaction as never, on }),
    edit: (id: string, body: string) => o.send({ t: 'chat.edit', id, body }),
    remove: (id: string) => o.send({ t: 'chat.remove', id }),
  };
}
export type ChatState = ReturnType<typeof useChat>;

// The room's conversation panel (lazy chunk): CLAN group chat + direct conversations with CLANmates, beside the room.
// Wording is deliberate: the host relays and stores these messages, so nothing here says "private" or "encrypted".
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { EDIT_WINDOW_MS, REACTIONS, type ChatAttachment, type ChatMessageView, type ChatThreadView, type ResourceView } from '@classroom/protocol';
import { formatBytes } from '@classroom/client';
import type { Conn, FileState, SavedItem } from '../../../shared.ts';
import { api } from '../../App.tsx';
import type { ChatPerson, ChatState } from './useChat.ts';

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const errText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

export default function ChatPanel({ chat, role, people, clanName, canSendFiles, conn, request }: {
  chat: ChatState; role: 'host' | 'member'; people: ChatPerson[]; clanName: string; canSendFiles: boolean;
  /** Members: the session used for downloads. */
  conn: Conn | null;
  /** A request from the room (CLANmate › Message): open that person's conversation. */
  request: { handle: string; n: number } | null;
}) {
  const group = chat.threads.find((t) => t.kind === 'group');
  const active = chat.threads.find((t) => t.id === chat.active) ?? null;
  useEffect(() => { if (!chat.active && group) void chat.open(group.id); }, [group?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (request) void chat.openDirect(request.handle).catch(() => {}); }, [request?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const others = people.filter((p) => p.handle && p.handle !== chat.me);
  const reachable = role === 'host' || others.length ? others : chat.host ? [{ handle: chat.host, name: 'Host', host: true, connected: true }] : [];

  return (
    <section className="card chat" aria-label="Chat" data-testid="chat">
      <nav className="chat-threads" aria-label="Conversations">
        {chat.threads.map((t) => (
          <button key={t.id} className={`chat-thread ${t.id === chat.active ? 'on' : ''}`} aria-current={t.id === chat.active} onClick={() => void chat.open(t.id)} data-testid={t.kind === 'group' ? 'thread-group' : `thread-${t.with?.name}`}>
            <span className={`chat-avatar ${t.kind}`} aria-hidden>{t.kind === 'group' ? '#' : initials(t.with?.name ?? '?')}</span>
            <span className="chat-thread-name">{t.kind === 'group' ? 'Everyone' : t.with?.name}{t.kind === 'direct' && !t.with?.here && <small className="muted"> · away</small>}</span>
            {t.unread > 0 && <span className="badge" aria-label={`${t.unread} unread`}>{t.unread}</span>}
          </button>
        ))}
        {reachable.length > 0 && <div className="chat-people"><span className="eyebrow">Message someone</span>
          {reachable.filter((p) => !chat.threads.some((t) => t.with?.handle === p.handle)).map((p) => (
            <button key={p.handle} className="link small" onClick={() => void chat.openDirect(p.handle)}>{p.name}{p.host ? ' (host)' : ''}</button>
          ))}</div>}
      </nav>
      {active ? <Conversation key={active.id} t={active} chat={chat} role={role} clanName={clanName} canSendFiles={canSendFiles} conn={conn} />
        : <div className="chat-empty muted">{chat.error || 'Loading the conversation…'}</div>}
    </section>
  );
}

function Conversation({ t, chat, role, clanName, canSendFiles, conn }: { t: ChatThreadView; chat: ChatState; role: 'host' | 'member'; clanName: string; canSendFiles: boolean; conn: Conn | null }) {
  const list = chat.msgs[t.id] ?? [];
  const mine = Object.values(chat.pending).filter((p) => ('id' in p.payload.thread ? p.payload.thread.id === t.id : p.payload.thread.kind === t.kind && (t.kind === 'group' || ('to' in p.payload.thread && p.payload.thread.to === t.with?.handle))) && !list.some((m) => m.id === p.payload.id));
  const [text, setText] = useState('');
  const [reply, setReply] = useState<ChatMessageView | null>(null);
  const [editing, setEditing] = useState<ChatMessageView | null>(null);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<SavedItem[] | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const target = { id: t.id };
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [list.length, mine.length]);
  const typers = (chat.typing[t.id] ?? []).map((x) => x.name.split(' ')[0]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    if (editing) { chat.edit(editing.id, body); setEditing(null); setText(''); return; }
    setText(''); setReply(null);
    await chat.post(target, body, reply ? { replyTo: reply.id } : {});
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } else if (e.key === 'Escape') { setReply(null); setEditing(null); } };
  const attach = async () => {
    setNote('');
    try {
      const files = await api.chat.sendPicked(chat.conn, t.kind === 'group' ? 'clan' : t.with!.handle);
      for (const f of files) await chat.post(target, '', { attachment: { kind: 'file', resourceId: f.id } });
    } catch (x) { setNote(errText(x)); }
  };
  const shareSaved = async (it: SavedItem) => { setSaved(null); await chat.post(target, '', { attachment: { kind: 'link', url: it.url, title: it.title, savedItemId: it.id } }); };

  let lastDay = '';
  return (
    <div className="chat-conv">
      <header className="chat-head">
        <b>{t.kind === 'group' ? `Everyone in ${clanName}` : t.with?.name}</b>
        <span className="muted small-text">{t.kind === 'group' ? 'Group conversation · kept by the host' : `Direct conversation · only you two see it here · relayed and kept by the host${t.with && !t.with.here ? ' · not in the room right now' : ''}`}</span>
      </header>
      <div className="chat-log" role="log" aria-live="polite" aria-label={t.kind === 'group' ? 'Group messages' : `Messages with ${t.with?.name}`}>
        {chat.more[t.id] && <button className="link small chat-more" onClick={() => void chat.loadEarlier(t.id)}>Load earlier messages</button>}
        {list.length === 0 && mine.length === 0 && <p className="muted chat-empty">{t.kind === 'group' ? 'No messages yet. Say hello to the CLAN.' : 'No messages yet.'}</p>}
        {list.map((m) => {
          const d = day(m.createdAt), sep = d !== lastDay; lastDay = d;
          const own = m.author === chat.me;
          return (
            <div key={m.id}>
              {sep && <div className="chat-day" role="separator"><span>{d}</span></div>}
              <Message m={m} own={own} t={t} chat={chat} list={list} role={role} conn={conn}
                onReply={() => { setEditing(null); setReply(m); }} onEdit={() => { setReply(null); setEditing(m); setText(m.body); }} />
            </div>
          );
        })}
        {mine.map((p) => (
          <div key={p.payload.id} className={`chat-msg own ${p.state}`} data-testid="chat-pending">
            <div className="chat-bubble"><p>{p.payload.body || (p.payload.attachment?.kind === 'file' ? 'File' : p.payload.attachment?.kind === 'link' ? p.payload.attachment.url : '')}</p></div>
            <span className="chat-meta">{p.state === 'failed' ? <><span className="error">Not sent — {p.error}</span> <button className="link small" onClick={() => chat.retry(p.payload.id)}>Retry</button> <button className="link small" onClick={() => chat.discard(p.payload.id)}>Discard</button></> : 'Sending…'}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      <p className="chat-typing muted small-text" aria-live="polite">{typers.length ? `${typers.join(', ')} ${typers.length === 1 ? 'is' : 'are'} typing…` : ' '}</p>
      {(reply || editing) && (
        <div className="chat-replying"><span>{editing ? 'Editing your message' : <>Replying to <b>{reply!.authorName}</b>: {reply!.body.slice(0, 80) || 'an attachment'}</>}</span>
          <button className="link small" onClick={() => { setReply(null); setEditing(null); setText(''); }}>Cancel</button></div>
      )}
      <form className="chat-compose" onSubmit={submit}>
        <textarea value={text} rows={2} maxLength={4000} placeholder={t.kind === 'group' ? `Message ${clanName}` : `Message ${t.with?.name ?? ''}`} aria-label="Message"
          onChange={(e) => { setText(e.target.value); if (e.target.value) chat.typingPing(t.id); }} onKeyDown={key} data-testid="chat-input" />
        <div className="chat-tools">
          {canSendFiles && !editing && <button type="button" className="small" onClick={attach} title={t.kind === 'group' ? 'Shared with everyone in this CLAN (also on the table)' : `Only ${t.with?.name} can download it`}>Attach file</button>}
          {!editing && <button type="button" className="small" onClick={async () => setSaved(saved ? null : await api.clan.savedItems())}>Share a saved link</button>}
          <button className="primary small" disabled={!text.trim()} data-testid="chat-send">{editing ? 'Save' : 'Send'}</button>
        </div>
      </form>
      {saved && <div className="chat-saved card" role="listbox" aria-label="Your saved links">{saved.length ? saved.slice(0, 30).map((s) => <button key={s.id} role="option" aria-selected={false} className="line" onClick={() => void shareSaved(s)}>{s.title}<span className="muted">{s.source}</span></button>) : <p className="muted small-text">Nothing saved yet.</p>}</div>}
      {note && <p className="error small-text">{note}</p>}
    </div>
  );
}

function Message({ m, own, t, chat, list, role, conn, onReply, onEdit }: { m: ChatMessageView; own: boolean; t: ChatThreadView; chat: ChatState; list: ChatMessageView[]; role: 'host' | 'member'; conn: Conn | null; onReply(): void; onEdit(): void }) {
  const [picking, setPicking] = useState(false);
  const quoted = m.replyTo ? list.find((x) => x.id === m.replyTo) : null;
  const d = own ? chat.delivery(t, m) : null;
  const canEdit = own && !m.removed && Date.now() - m.createdAt < EDIT_WINDOW_MS && !!m.body;
  const canRemove = !m.removed && (own || (role === 'host' && t.kind === 'group'));
  return (
    <article className={`chat-msg ${own ? 'own' : ''} ${m.removed ? 'removed' : ''}`} data-testid="chat-message" aria-label={`${m.authorName} at ${time(m.createdAt)}`}>
      {!own && <span className="chat-author">{m.authorName}</span>}
      <div className="chat-bubble">
        {m.replyTo && <blockquote className="chat-quote">{quoted ? (quoted.removed ? 'Original message was removed' : <><b>{quoted.authorName}</b> {quoted.body.slice(0, 120) || (quoted.attachment ? 'an attachment' : '')}</>) : 'Earlier message (not loaded)'}</blockquote>}
        {m.removed ? <p className="muted"><i>{m.removed.by === 'host' ? 'Message removed by the host' : 'Message removed'}</i></p> : m.body && <p>{m.body}</p>}
        {m.attachment && <Attachment a={m.attachment} own={own} direct={t.kind === 'direct'} role={role} conn={conn} />}
      </div>
      {m.reactions.length > 0 && <div className="chat-reactions">{m.reactions.map((r) => {
        const on = !!chat.me && r.by.includes(chat.me);
        return <button key={r.reaction} className={`chip-btn small ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => chat.react(m.id, r.reaction, !on)} aria-label={`${r.reaction} ${r.by.length}`}>{r.reaction} {r.by.length}</button>;
      })}</div>}
      <span className="chat-meta">
        {time(m.createdAt)}{m.editedAt && ' · edited'}
        {d && <> · <span data-testid="chat-delivery">{d.state === 'read' ? (t.kind === 'direct' ? 'Read' : `Seen by ${d.seen}`) : d.state === 'delivered' ? 'Delivered' : 'Sent'}</span></>}
        {!m.removed && <> · <button className="link small" onClick={onReply}>Reply</button> · <button className="link small" aria-expanded={picking} onClick={() => setPicking(!picking)}>React</button></>}
        {canEdit && <> · <button className="link small" onClick={onEdit}>Edit</button></>}
        {canRemove && <> · <button className="link small" onClick={() => confirm(own ? 'Remove this message for everyone?' : 'Remove this message from the group?') && chat.remove(m.id)}>Remove</button></>}
      </span>
      {picking && <div className="chat-react-pick" role="group" aria-label="Reactions">{REACTIONS.map((r) => <button key={r} className="small" onClick={() => { setPicking(false); chat.react(m.id, r, !(m.reactions.find((x) => x.reaction === r)?.by.includes(chat.me ?? ''))); }}>{r}</button>)}</div>}
    </article>
  );
}

function Attachment({ a, own, direct, role, conn }: { a: ChatAttachment; own: boolean; direct: boolean; role: 'host' | 'member'; conn: Conn | null }) {
  const [st, setSt] = useState<FileState | null>(null);
  const [err, setErr] = useState('');
  const rv = useMemo<ResourceView | null>(() => (a.kind === 'file' ? { id: a.resourceId, name: a.name, size: a.size, sha256: a.sha256, mime: a.mime, addedAt: 0, status: 'ready', available: true, pushed: false } : null), [a]);
  useEffect(() => {
    if (!rv || !conn || role !== 'member') return;
    void api.fileStatus(conn, [rv]).then((s) => s[0] && setSt(s[0]));
    return api.onFileState((s) => { if (s.resourceId === rv.id) setSt(s); });
  }, [rv, conn, role]);
  if (a.kind === 'link') return <a className="chat-link" href={a.url} target="_blank" rel="noreferrer noopener"><b>{a.title}</b><span className="muted small-text">{a.source} · opens in your browser</span></a>;
  const pct = st && st.size ? Math.floor((st.bytes / st.size) * 100) : 0;
  return (
    <div className="chat-file" data-testid="chat-file">
      <span className="tag">{a.name.split('.').pop()?.toUpperCase().slice(0, 5) ?? 'FILE'}</span>
      <span className="grow"><b>{a.name}</b><br /><small className="muted">{formatBytes(a.size)}{direct ? ' · only the two of you' : ' · everyone in the CLAN'}{st?.state === 'completed' ? ' · verified ✓' : ''}</small></span>
      {role === 'host' && !own && <button className="small" onClick={() => api.chat.hostSave(a.resourceId).then(() => setErr(''), (e) => setErr(errText(e)))}>Save a copy</button>}
      {role === 'member' && !own && conn && rv && (
        !st || st.state === 'not_started' || st.state === 'failed' ? <button className="small" data-testid="chat-download" onClick={() => api.download(conn, rv, true)}>{st?.state === 'failed' ? 'Retry' : 'Download'}</button>
          : st.state === 'paused' ? <button className="small" onClick={() => api.download(conn, rv, true)}>Resume ({pct}%)</button>
          : st.state === 'completed' ? <span className="row tight">{st.canOpen && <button className="small" onClick={() => api.openFile(conn.sessionId, rv.id).catch((e) => setErr(errText(e)))}>Open</button>}<button className="small" onClick={() => api.showFile(conn.sessionId, rv.id)}>Show</button></span>
          : <span className="row tight"><small>{st.state === 'verifying' ? 'Verifying…' : `${pct}%`}</small><button className="small" onClick={() => api.pause(rv.id)}>Pause</button></span>
      )}
      {own && <small className="muted">sent</small>}
      {err && <small className="error">{err}</small>}
    </div>
  );
}

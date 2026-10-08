// Host-side chat relay: authorizes every chat action against the live session (approved membership, capabilities),
// stores through the injected Chat store (@clan/core modules/chat — keyed by CLAN, so history survives sessions and
// re-hosting) and decides who receives what. Transport is the existing pinned WSS; nothing here opens a socket.
import { createHash } from 'node:crypto';
import {
  b64u, keyFingerprint, type AttachmentInput, type ChatAttachment, type ChatCursors, type ChatMessageView, type ChatThreadView,
} from '@classroom/protocol';
import type { Classroom, Principal } from './classroom.ts';
import type { Resources } from './resources.ts';
import { ApiError, RateLimit } from './storage.ts';

type Thread = { id: string; clanId: string; kind: 'group' | 'direct'; pair: string[] };
/** The subset of @clan/core's Chat the host needs (structural, so the server does not depend on @clan/core). */
export type ChatStore = {
  thread(id: string): Thread | null;
  groupThread(clanId: string): Thread;
  directThread(clanId: string, a: string, b: string): Thread;
  canRead(t: Thread, handle: string): boolean;
  setName(clanId: string, handle: string, name: string): void;
  threads(clanId: string, handle: string): ChatThreadView[];
  threadView(t: Thread, handle: string): ChatThreadView;
  post(o: { id: string; threadId: string; author: string; authorName: string; body: string; replyTo?: string | null; attachment?: ChatAttachment | null }): { message: ChatMessageView; created: boolean };
  get(id: string): ChatMessageView | null;
  page(threadId: string, o?: { before?: number; after?: number; limit?: number }): ChatMessageView[];
  edit(id: string, author: string, body: string): ChatMessageView;
  remove(id: string, by: { handle: string; moderator: boolean }): ChatMessageView;
  react(id: string, handle: string, reaction: string, on: boolean): { message: ChatMessageView; changed: boolean };
  cursor(threadId: string, handle: string, c: { delivered?: number; read?: number }): ChatCursors;
  cursors(threadId: string): ChatCursors;
};

/** CLAN-scoped pseudonym: stable for one device in one CLAN (across sessions), unlinkable across CLANs, not a key. */
export const chatHandle = (clanKey: string, deviceFingerprint: string) =>
  b64u.encode(new Uint8Array(createHash('sha256').update(`clan-chat/v1|${clanKey}|${deviceFingerprint}`).digest())).slice(0, 22);

export const TYPING_MS = 6000;

export class ChatRelay {
  readonly clanKey: string;
  readonly hostHandle: string;
  private store: ChatStore; private classroom: Classroom; private resources: Resources; private hostName: string;
  private sendRate = new RateLimit(30, 10_000);
  private typingRate = new RateLimit(1, 2000);

  constructor(o: { store: ChatStore; classroom: Classroom; resources: Resources; teacherPublicKey: string; hostName: string | null }) {
    this.store = o.store; this.classroom = o.classroom; this.resources = o.resources; this.hostName = o.hostName ?? 'Host';
    this.clanKey = o.classroom.clan.id ?? o.classroom.id;
    this.hostHandle = chatHandle(this.clanKey, keyFingerprint(o.teacherPublicKey));
    this.store.setName(this.clanKey, this.hostHandle, this.hostName);
  }

  handleOf(p: Principal): string {
    if (p.role === 'teacher') return this.hostHandle;
    const m = this.classroom.member(p.memberId);
    if (!m) throw new ApiError(403, 'forbidden', 'Not a member.');
    return chatHandle(this.clanKey, m.deviceId);
  }
  nameOf(p: Principal) { return p.role === 'teacher' ? this.hostName : this.classroom.member(p.memberId)?.fullName ?? 'Someone'; }
  /** Handle → approved principal in this session (host included). */
  principalOf(handle: string): Principal | null {
    if (handle === this.hostHandle) return { role: 'teacher' };
    const m = this.classroom.roster().find((x) => x.status === 'approved' && chatHandle(this.clanKey, x.deviceFingerprint) === handle);
    return m ? { role: 'student', memberId: m.id } : null;
  }
  handles(): Map<string, string> { return new Map(this.classroom.roster().map((m) => [m.id, chatHandle(this.clanKey, m.deviceFingerprint)])); }

  /** Approved member or host, still in this CLAN session. Every read and write goes through here. */
  private active(p: Principal) {
    if (p.role === 'student' && this.classroom.status(p.memberId) !== 'approved') throw new ApiError(403, 'forbidden', 'You are not an active member of this CLAN.');
    if (this.classroom.info().ended) throw new ApiError(410, 'ended', 'This CLAN session has ended.');
    return this.handleOf(p);
  }
  /** A thread of this CLAN that `p` may read. Other CLANs' threads look exactly like missing ones. */
  readable(p: Principal, threadId: string): Thread {
    const me = this.active(p);
    const t = this.store.thread(threadId);
    if (!t || t.clanId !== this.clanKey || !this.store.canRead(t, me)) throw new ApiError(404, 'not_found', 'No such conversation.');
    return t;
  }
  canRead(p: Principal, t: Thread) {
    try { return this.store.canRead(t, this.active(p)); } catch { return false; }
  }

  /** Who may see a file sent by `p` to `to` ('clan' = the table: everyone). Throws if `p` may not send it there. */
  audience(p: Principal, to: string): string[] | null {
    const me = this.active(p);
    if (!this.classroom.can(p, p.role === 'teacher' ? 'SHARE_RESOURCE' : 'SEND_FILES')) throw new ApiError(403, 'forbidden', 'You cannot share files in this CLAN.');
    if (to === 'clan') return null;
    this.directPeer(p, to);
    return [me, to];
  }
  nameOfHandle(handle: string) { const p = this.principalOf(handle); return p ? this.nameOf(p) : 'Someone'; }

  /** May `p` start a direct conversation with `handle`? Host ↔ anyone; members ↔ host, or ↔ members they can see. */
  private directPeer(p: Principal, handle: string) {
    const other = this.principalOf(handle);
    if (!other || handle === this.handleOf(p)) throw new ApiError(404, 'not_found', 'That person is not in this CLAN right now.');
    if (p.role === 'student' && other.role === 'student' && !this.classroom.can(p, 'VIEW_MEMBERS')) throw new ApiError(403, 'forbidden', 'In this CLAN you can message the host only.');
    return other;
  }

  /** `host`: the host's handle — everyone may message the host, even without seeing the member list. */
  threads(p: Principal): { me: string; host: string; threads: ChatThreadView[] } {
    const me = this.active(p);
    return { me, host: this.hostHandle, threads: this.store.threads(this.clanKey, me).map((t) => this.here(t)) };
  }
  view(t: Thread, p: Principal) { return this.here(this.store.threadView(t, this.handleOf(p))); }
  private here(t: ChatThreadView): ChatThreadView { return t.with ? { ...t, with: { ...t.with, here: !!this.principalOf(t.with.handle) } } : t; }

  openDirect(p: Principal, to: string) {
    const me = this.active(p);
    this.directPeer(p, to);
    this.store.setName(this.clanKey, to, this.nameOf(this.principalOf(to)!));
    return this.here(this.store.threadView(this.store.directThread(this.clanKey, me, to), me));
  }

  page(p: Principal, threadId: string, o: { before?: number; after?: number; limit?: number }) {
    const t = this.readable(p, threadId);
    return { messages: this.store.page(t.id, o), cursors: this.store.cursors(t.id) };
  }

  /** Validates and stores. Retries with the same id return the stored message (`created: false`). */
  send(p: Principal, m: { id: string; thread: { kind: 'group' } | { kind: 'direct'; to: string } | { id: string }; body: string; replyTo?: string; attachment?: AttachmentInput }) {
    const me = this.active(p);
    if (!this.classroom.can(p, 'SEND_MESSAGE')) throw new ApiError(403, 'forbidden', 'You cannot send messages in this CLAN.');
    const prior = this.store.get(m.id);
    if (prior) { // a retry: answer with what was stored, without re-checking rate limits
      if (prior.author !== me) throw new ApiError(409, 'conflict', 'That message id is already used.');
      return { message: prior, created: false, thread: this.store.thread(prior.threadId)! };
    }
    if (!this.sendRate.take(me)) throw new ApiError(429, 'rate_limited', 'You are sending messages too quickly.');
    let t: Thread;
    if ('id' in m.thread) t = this.readable(p, m.thread.id);
    else if (m.thread.kind === 'group') t = this.store.groupThread(this.clanKey);
    else { this.directPeer(p, m.thread.to); t = this.store.directThread(this.clanKey, me, m.thread.to); this.store.setName(this.clanKey, m.thread.to, this.nameOf(this.principalOf(m.thread.to)!)); }
    const attachment = m.attachment ? this.attachment(p, t, m.attachment) : null;
    return { ...this.store.post({ id: m.id, threadId: t.id, author: me, authorName: this.nameOf(p), body: m.body, replyTo: m.replyTo ?? null, attachment }), thread: t };
  }

  /** Files must already be CLAN resources the sender can reach, with an audience that fits the conversation. */
  private attachment(p: Principal, t: Thread, a: AttachmentInput): ChatAttachment {
    if (a.kind === 'link') { const u = new URL(a.url); return { kind: 'link', url: u.href, title: a.title?.trim() || u.hostname.replace(/^www\./, ''), source: u.hostname.replace(/^www\./, ''), ...(a.savedItemId ? { savedItemId: a.savedItemId } : {}) }; }
    const r = this.resources.forChat(p, a.resourceId);
    const fits = r.audience === null || (t.kind === 'direct' && [...r.audience].sort().join('|') === [...t.pair].sort().join('|'));
    if (!fits) throw new ApiError(403, 'forbidden', t.kind === 'group' ? 'Files sent to one person can’t be posted to the whole CLAN.' : 'That file was sent to someone else.');
    return { kind: 'file', resourceId: r.id, name: r.name, size: r.size, mime: r.mime, sha256: r.sha256 };
  }

  edit(p: Principal, id: string, body: string) { return this.withThread(p, id, (me) => this.store.edit(id, me, body)); }
  remove(p: Principal, id: string) { return this.withThread(p, id, (me) => this.store.remove(id, { handle: me, moderator: this.classroom.can(p, 'MANAGE_CLAN') })); }
  react(p: Principal, id: string, reaction: string, on: boolean) { return this.withThread(p, id, (me) => this.store.react(id, me, reaction, on).message); }
  private withThread(p: Principal, id: string, f: (me: string) => ChatMessageView) {
    const m = this.store.get(id);
    if (!m) throw new ApiError(404, 'not_found', 'No such message.');
    const t = this.readable(p, m.threadId);
    return { message: f(this.handleOf(p)), thread: t };
  }

  cursor(p: Principal, threadId: string, c: { delivered?: number; read?: number }) {
    const t = this.readable(p, threadId);
    return { thread: t, cursors: this.store.cursor(t.id, this.handleOf(p), c) };
  }

  /** Ephemeral typing signal: rate-limited, never stored; receivers expire it themselves (`until`). */
  typing(p: Principal, threadId: string) {
    const t = this.readable(p, threadId), me = this.handleOf(p);
    if (!this.typingRate.take(`${me}:${t.id}`)) return null;
    return { thread: t, handle: me, name: this.nameOf(p), until: Date.now() + TYPING_MS };
  }
}

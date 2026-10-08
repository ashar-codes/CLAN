// CLAN chat on the wire. Messages travel over the existing pinned WSS control channel and are stored by the host
// (it relays and persists them, so it can read them: never call these conversations private or end-to-end encrypted).
// People are addressed by a CLAN-scoped handle: stable across sessions of one CLAN, unlinkable across CLANs, and not a
// device key. Message ids are client-generated UUIDs so retries are idempotent; the host assigns per-thread order (seq).
import { z } from 'zod';

export const REACTIONS = ['👍', '❤️', '😂', '🎉', '🤔', '👀'] as const;
export const MAX_MESSAGE_CHARS = 4000;
/** Own messages can be edited for this long; removal is always possible and leaves a "removed" placeholder. */
export const EDIT_WINDOW_MS = 15 * 60_000;

export const ChatHandle = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const body = z.string().max(MAX_MESSAGE_CHARS).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), 'Control characters are not allowed');
const HttpUrl = z.string().trim().max(2048).refine((u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } }, 'Only http(s) links can be shared.');

/** What a sender attaches: a resource already in this CLAN (by id) or a link. The host fills in file metadata. */
export const AttachmentInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), resourceId: z.uuid() }),
  z.object({ kind: z.literal('link'), url: HttpUrl, title: z.string().trim().max(300).optional(), savedItemId: z.uuid().optional() }),
]);
export type AttachmentInput = z.infer<typeof AttachmentInput>;
/** Metadata only: file bytes stay in the host's resource store and are fetched (and verified) like any CLAN file. */
export type ChatAttachment =
  | { kind: 'file'; resourceId: string; name: string; size: number; mime: string; sha256: string }
  | { kind: 'link'; url: string; title: string; source: string; savedItemId?: string };

export const ThreadTarget = z.union([
  z.object({ kind: z.literal('group') }),
  z.object({ kind: z.literal('direct'), to: ChatHandle }),
  z.object({ id: z.uuid() }),
]);

export const ChatClientMessage = [
  z.object({ t: z.literal('chat.send'), id: z.uuid(), thread: ThreadTarget, body, replyTo: z.uuid().optional(), attachment: AttachmentInput.optional() })
    .refine((m) => m.body.trim().length > 0 || !!m.attachment, 'Empty message'),
  z.object({ t: z.literal('chat.edit'), id: z.uuid(), body: body.refine((s) => s.trim().length > 0, 'Empty message') }),
  z.object({ t: z.literal('chat.remove'), id: z.uuid() }),
  z.object({ t: z.literal('chat.react'), id: z.uuid(), reaction: z.enum(REACTIONS), on: z.boolean() }),
  /** Cursors: the highest seq this device has received (delivered) or shown to the person (read). */
  z.object({ t: z.literal('chat.cursor'), threadId: z.uuid(), delivered: z.number().int().nonnegative().optional(), read: z.number().int().nonnegative().optional() }),
  /** Ephemeral: never stored, rate-limited, expires on its own. */
  z.object({ t: z.literal('chat.typing'), threadId: z.uuid() }),
] as const;

export type ChatMessageView = {
  id: string; threadId: string; seq: number; author: string; authorName: string; body: string;
  replyTo: string | null; attachment: ChatAttachment | null; createdAt: number; editedAt: number | null;
  /** Removed messages keep their place (and who removed them); body and attachment are gone. */
  removed: null | { by: 'author' | 'host'; at: number };
  reactions: { reaction: string; by: string[] }[];
};
export type ChatThreadView = {
  id: string; kind: 'group' | 'direct'; clanId: string;
  /** Direct: the other participant (name as last known to the host; `here` = in the current session). */
  with: { handle: string; name: string; here: boolean } | null;
  lastSeq: number; readSeq: number; unread: number; updatedAt: number;
};
/** Per-participant cursors so a sender can show SENT / DELIVERED / READ truthfully. */
export type ChatCursors = Record<string, { delivered: number; read: number }>;

export type ChatServerMessage =
  | { t: 'chat.message'; message: ChatMessageView; thread: ChatThreadView }
  /** The sender's message was stored (or already had been: retries are idempotent). */
  | { t: 'chat.ack'; id: string; threadId: string; seq: number; createdAt: number }
  /** Refused for good (not a transient failure): the sender marks it FAILED. */
  | { t: 'chat.nack'; id: string; code: string; message: string }
  | { t: 'chat.cursors'; threadId: string; cursors: ChatCursors }
  | { t: 'chat.typing'; threadId: string; handle: string; name: string; until: number };

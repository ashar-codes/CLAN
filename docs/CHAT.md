# Chat, direct sends and Capture

```
 member / host app ──WSS (existing pinned channel)── chat.send {id: uuid, thread, body, replyTo?, attachment?}
                    ◀── chat.ack {id, seq} · chat.message {message, thread} · chat.cursors · chat.typing
 history: GET /api/chat/threads · GET /api/chat/threads/:id/messages?before|after&limit≤200 · POST /api/chat/direct {to}
 member file share: POST/PUT/GET /api/shares (same resumable protocol as submissions) → a resource with an audience
```

**Where it lives.** `@clan/core` `modules/chat` owns `chat_*` tables. On the **host** device they are the authority, keyed
by the **CLAN id** (not the session), so conversations survive host restarts, ending the CLAN and **Host again**. The host
assigns `seq` (gap-free order per thread). **Member** devices keep a cache of what the host delivered, for reading offline
(CLAN › Chat tab) and for notifications, plus the durable **Outbox**. `@classroom/server` `ChatRelay` authorizes every
action against the live session and decides who receives what. The server talks to the store through a structural
interface, so it does not depend on `@clan/core`.

**People are CLAN-scoped handles.** `sha256("clan-chat/v1|clanId|deviceKeyFingerprint")`, 22 chars. A handle is the same
for one device across a CLAN's sessions, unlinkable across CLANs, and not a key. The author of a message is always derived
on the host from the authenticated session; anything a client claims is ignored.

| Rule | Enforced by |
|---|---|
| Send / fetch / receive need an approved member (or the host) of the current session | `ChatRelay.active`, socket filter, HTTP auth |
| Removed or blocked: socket closed, token refused, no further deliveries | session status (tested) |
| Other CLANs' threads look like missing ones (`404`), even on the same host database | thread `clanId` check |
| Direct: only its two participants can read it. Without `VIEW_MEMBERS` (Classroom), members may message the host only | `canRead`, `directPeer` |
| Reusing someone else's message id → `conflict`; your own id again → the stored message (idempotent retry) | `post()` |
| Reply must reference a message in the same thread; it stores the id, never a copy of the text | `post()` |
| Reactions: (message, person, reaction) at most once; toggles are idempotent | primary key |
| Edit own message for 15 min (shows "edited"). Remove own, or the host removes group messages: the row stays as "removed (by …)" | `edit`, `remove` |
| 30 sends / 10 s per person; typing ≤ 1 / 2 s, never stored, expires on the receiver | `RateLimit` |

**Delivery states** (only what is known): SENDING (in the Outbox) → SENT (`chat.ack`, stored by the host) → DELIVERED /
READ. The last two come from the recipient's own `chat.cursor` reports. Direct messages show *Read*; groups show *Seen by N*.
FAILED is a refusal (`chat.nack`). Rate limiting is transient and stays in the Outbox.

**Outbox and replay.** A message is written to `chat_outbox` before it is sent and removed only on `chat.ack`. After every
reconnect (`hello`) all Outbox entries are re-sent with the same ids. Entries stuck for 8 s are re-sent too. The host answers
repeats with the stored message, so there are no duplicates.

**Files.** Attachments reference resources by id, with name, size, MIME and SHA-256 as metadata. Bytes never enter chat
tables. The same transfer system serves both cases:
* **Table** (drop on the table, or a group attachment): audience = the whole CLAN.
* **Person** (CLANmate › Send, drop on a CLANmate, or a direct attachment): audience = sender + recipient. The file appears
  only in their lists, manifests and downloads; it never goes on the table or the host's CLAN file list, and can't be posted
  into the group.

The host imports directly; members upload over `/api/shares` (resumable, idempotent). Person files and chat attachments
always download from the host (never from peers), then are verified by SHA-256 as usual. Identical bytes are hard-linked on
the host (stored once).

**Saved links in chat** carry `{url, title, source, savedItemId}`. The conversation keeps the link even if the sender later
reorganises or unshares their Saved item. Personal organisation and shared history are separate.

**Not private, not end-to-end encrypted.** The host relays and stores every message (it can read them). The UI says
"relayed and kept by the host" and never "private" or "encrypted". To add E2EE later: handles stay, and the per-device keys
already exist (the host knows each member's device key). The `body` column would carry ciphertext without changing ids,
threads or the UI.

## Capture Inbox

Quick Capture (Note, Link, Text/idea, File) and `clan://capture?url=…|text=…` land in Personal Space › Inbox
(`capture_items`). Each item points at a canonical note, saved link or file ref; nothing is copied. Filing moves a link to a
collection, or shares the canonical item into a CLAN or course (a reference). Sending to a person happens in a live room.

**Links.** A saved link is kept immediately (title = domain). Its title / `og:title` and preview URL are filled in later when
the network allows (only `text/html`, ≤ 256 KB, 5 s timeout). Video and other media are never read. `parseIntake` accepts
only an http(s) URL or text and refuses paths, `file:`, `javascript:`, `data:`, credentials in URLs, bidi and control
characters, and unknown or duplicate keys.

**OS integration.** On desktop, `clan://` is handled through Electron `open-url` (E2E-tested via the event). It is declared in
`electron-builder.yml`; OS-level registration of a packaged build is not verified. Files dropped on the Quick Capture button go to
the Inbox (the Dock-icon / "Open with" path is wired but not tested). On mobile, the `clan://` scheme is handled with RN `Linking` into a phone-only Inbox
(typechecked, not run on a device). iOS Share Extension and Android `SEND` intents are **not implemented**.

## Notifications

`modules/notifications` consumes `MessageCreated`. It only ever notifies a participant: a host device stores direct
conversations between others but never notifies about them, nor indexes them for search. It is silent for your own messages
and for the conversation you are looking at. Focus mode keeps the notice but doesn't alert. A busy group alerts at most once
a minute. Preferences (Me): direct, files, groups, and message text in notifications (off by default).

## Mobile

Same contracts. The app supports the group and direct conversations, sending text and links (durable Outbox file), and
downloading attachments from the host (verified). Sending files from a phone is not built. Its Inbox lives on the phone. Not run on a device.

# Personal chat and file sharing (final phase)

## Conversation UI

Phone (`apps/mobile/src/people/ChatView.tsx`) and computer (`apps/desktop/src/renderer/world/people/Chats.tsx`):
fixed header (real name, device name, connection, voice call, video call, ⋮ options), date separators, grouped
bubbles, real states (🕓 pending · ✓ sending · ✓✓ delivered · blue ✓✓ read · ⚠ failed), reply previews, reactions,
“Edited”, deleted placeholders, chat search, unread badges, attachment picker (photos/videos, camera, documents),
voice notes. Actions open by **long-press** or the small **⌄** chevron on phones, and by **right-click** or ⌄ on desktop:
React · Reply · Copy · Forward · Edit · Message info · Delete for me · Delete for everyone (only those that apply).

## Protocol (signed envelopes, `packages/protocol/src/people.ts`)

| Kind | Who | Rules |
|---|---|---|
| `msg.text` + optional `replyTo` | either participant | active conversation |
| `msg.edit` {msgId, text} | **author only** | text messages, ≤ 1 h after sending (`PEOPLE_EDIT_WINDOW_MS`); newest envelope time wins; ignored after deletion |
| `msg.delete` {msgId} | **author only** | text/file/voice, ≤ 48 h (`PEOPLE_DELETE_WINDOW_MS`); durable tombstone; received file bytes are freed |
| `msg.react` {msgId, emoji\|null} | either participant | one reaction per person |

- Authorisation is checked by the **recipient** (`m.author === envelope.from`, same conversation), on top of the
  envelope signature, recipient binding and replay table. Forged or replayed edits/deletes are refused.
- **Tombstones**: a deletion (or edit) that arrives before its message is stored in `people_msg_ops` and applied when
  the message arrives, so a deleted message never appears; re-delivery of the original cannot resurrect it.
- **Offline**: edits/deletions queue like messages; the sender sees “edit/deletion not delivered yet” until the
  recipient's authenticated receipt; if the recipient runs an older CLAN that refuses the new kinds, the sender sees
  “could not apply this change” (`op_failed`) — never a false success.
- A message that has not left the sender yet is withdrawn/replaced locally instead of sending a deletion/edit.
- **Delete for me** hides the local copy only (row kept as a hidden tombstone so retries cannot re-add it).
- CLAN cannot erase screenshots, exports, or copies saved outside CLAN; the confirmation says so.
- CLAN group chats keep their existing host-relayed edit/remove permissions (unchanged).

## Files

- Sending: native pickers (photos/videos multi-select, camera, documents), progress bar, cancel, retry, SHA-256 and
  size verification on arrival (unchanged transport limits: 2 GiB, resumable ranges).
- **Automatic downloads** (People › Automatic downloads; off by default): only from **friends**, only chosen kinds
  (photos, videos, audio, documents), only up to the chosen size (10/25/100 MB). Anything that could run code
  (apk, exe, scripts, html…) and files from non-friends always ask. Nothing is ever opened automatically.
- Storage locations are always labelled:
  - *Downloaded to CLAN · verified* — CLAN's private storage.
  - **Save to Gallery** (Android, MediaStore → Pictures/CLAN or Movies/CLAN, verified copy, never overwrites;
    Android 10+) / **Save to Photos** (iOS, add-only permission).
  - **Save to Files** — Android Storage Access Framework into a folder the user picks (verified byte-for-byte after
    writing); iOS system share sheet → Save to Files.
  - **Open** (Android chooser for safe types only; iOS share sheet) and **Share**.
- Free space is checked before accepting (file + 64 MB margin).

## Tests

`packages/clan/test/people-final.test.ts` (authorship, ordering, tombstones, replay, restart, old-peer refusal,
auto-download policy), `apps/desktop/e2e/people.test.ts` (two real app instances: reply, react, author-only menu,
edit, delete-for-everyone over the real transport). Phone UI: see FINAL_CROSS_PLATFORM_VERIFICATION.md.

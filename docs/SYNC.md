# Personal Device Sync

One student's own devices (MacBook, Windows laptop, later the phone) keep one personal account in step, over the LAN,
with no cloud. Code: `modules/sync` (engine), each module's `syncProviders()`, `core/syncrows.ts` (row helper),
`protocol/sync.ts` (shared contracts), `server/sync-server.ts` + `client/sync.ts` (LAN transport), desktop `main/sync.ts`
and `renderer/world/devices/Devices.tsx` (Me › My Devices).

## Account and linking
* The first device creates an account (random id + discovery secret) and a signed registry entry for itself. Each
  device has its own Ed25519 sync key and a long-lived TLS certificate, both in the OS keystore.
* **Link a new device** shows `CLAN-XXXX-XXXX-XXXX`: 60 random bits, one use, 2 minutes, 3 wrong tries close it, and
  10 failures per IP per minute lock the endpoint. It is never the six-digit CLAN join code.
* The new device connects without a pin (it has nothing to pin yet). It notes the server's TLS SPKI and sends
  `HMAC(code, transcript)`. The transcript covers the session, that SPKI, its device key and both nonces. It also signs
  the transcript with its device key, which proves it holds that key.
* A relay with its own certificate can't reuse the proof, because the SPKI differs. It can't guess the code offline
  within 2 minutes either.
* The trusted device shows "<name> wants to sync" and adds nothing until the student taps **Approve**. It then signs a
  registry entry for the new device and returns its own proof. The new device checks that proof and checks the
  approver's SPKI against the one it saw before it accepts the grant.
* Matching display names mean nothing. Only a signed registry entry makes two devices part of the same account.
* Linking grants personal sync only: no CLAN membership, host authority, OPAQUE material, TLS session keys, AI provider
  keys, or other people's messages or files. Each device keeps its own local user id, and owner columns never travel.

## Transport and authentication
* HTTPS (TLS 1.3) to the peer's registered certificate: the only CA it trusts is that device's CA, and the leaf SPKI
  is pinned.
* Each `/sync` request is also signed by the caller's device key over method, path, time, nonce and body SHA-256.
  Requests are refused for clock skew over 2 minutes, a repeated nonce, an unknown device or a revoked device (403
  `revoked`).
* DNS-SD `_clansync._tcp` carries only an account tag that rotates hourly (and, while a code is open, a short tag derived
  from it). It carries no names or ids. The device behind an address is identified by its TLS pin. A manual address
  works when multicast is blocked.
* `SyncTransport` (`pull`, `push`, `object`) is the only boundary the engine knows. An internet relay would implement the
  same interface. It is not built.

## Change records
* `SyncRecord = {kind, id, version, hash, history≤16, deleted, payload}`. `version` is a hybrid logical clock. `hash` is
  a content hash (`contentHash`, shared with the phone), and `history` lists the hashes this version descends from.
* **Change detection:** each provider's rows are hashed. The scan runs only when SQLite's `total_changes()` moved, and
  sync's own bookkeeping doesn't count. A new or changed entity gets a new version and a local sequence number; a
  vanished one gets a tombstone.
* **Exchange:** the client pulls from the peer, then pushes, so one side reaching the other is enough. Cursors are kept
  per peer and saved after every page, so a restart resumes from the last page.
* **Applying:** the owning module's provider applies each record in its own transaction. Every incoming field is checked
  against the table's real columns. Ownership is forced to the local user, and a row owned by someone else is refused.
* **Ordering:**
  * Same hash: no-op (idempotent).
  * Our hash is in their history: fast-forward.
  * Their hash is in our history: stale, ignored. This is what stops a deleted item coming back.
  * Otherwise: concurrent edits, handled by policy (below).
* **Retries:** a record whose parent hasn't arrived (a review before its card) is deferred and retried. Any other
  failure rolls back and is shown as a conflict, never half-applied.

## What syncs, and conflict policy
| Kind | Policy |
|---|---|
| Profile name, notification preferences | newest wins |
| Courses (topics, lectures, references) | newest wins; the CLAN link stays per device |
| Notes | **preserve**: both kept, compare, then keep mine / theirs / both (a copy) |
| Diary (opt-in, default off; one record per day) | **preserve**; "keep both" puts both texts in that day |
| Saved items + custom collections | newest wins; built-in Inbox / Watch Later map to each device's own |
| Capture Inbox, tasks (+ checklist), reminders, exams | newest wins (the losing version stays viewable) |
| Flashcard decks + cards | newest wins for content; the schedule is never copied |
| Flashcard reviews | append-only union; each card's schedule is recomputed from all its reviews |
| Study sessions | one record each (never merged); a running session syncs once it ends |
| Personal and course boards | union of ops by op id (the reducer converges) |
| Study Tape metadata + timeline | newest wins; a tape still recording stays on its device |
| Own personal files | by SHA-256, see below |

"Newest wins" compares versions, which are stamped when the change is detected (within about 20 s on desktop). The
losing version is stored and listed under My Devices. Never synced: CLANs and memberships, chats, Classroom data,
whiteboards of CLANs, AI settings, keys and history, and other people's files.

## Files
* A file reference keeps its id on every device. The bytes move only if this device lacks that SHA-256, so nothing is
  duplicated.
* Downloads go to a `.part` file and resume with an HTTP Range. The SHA-256 is checked before the file enters the
  Resource Store; on a mismatch it is discarded and retried.
* Free space must exceed what's left to download by 256 MB, otherwise the transfer waits ("Not enough free space").
* File setting: up to 50 MB each (default), **All** (large files and recordings), or **Off**. Skipped bytes are shown.
* A device only serves bytes of the account owner's own personal files.

## Revocation and recovery
* **Unlink** signs a revocation. The device is refused from then on. The revocation reaches the other devices on their
  next sync and can't be undone by a forged "un-revoke".
* The unlinked device learns of it on its next request, pauses and says so. Its local data stays: CLAN can't erase a
  device remotely.
* **Lost device:** unlink it from any other device, then use the OS lock or erase. With every device lost there is no
  copy to recover from: start a new account.

## Limits
* LAN only. The phone has the record contract (`apps/mobile/src/sync/records.ts`, tested against a desktop database) but
  no transport or linking yet: linking needs an unpinned first TLS contact that its native module doesn't do.
* History is 16 hashes deep: a copy unseen for more than 16 versions counts as concurrent, not stale.
* "Newest" means detection time, not keystroke time.
* Diary is protected in transit and at rest the same way as other local data. It is not end-to-end encrypted separately.

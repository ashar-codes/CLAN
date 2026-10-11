# Phase 14.3 A+B — Nearby People, Friends, Personal Chats, Files, Voice Notes, Calls

Local-network only. No server, no account, no internet dependency. Progress and test record: `PHASE_14_3_PROGRESS.md`.
Hardware checks still owed: `PHASE_14_3_HARDWARE_TESTS.md`.

## Identity and trust
* A person is their device's **Ed25519 identity key** (`device-ed25519` in the desktop keystore; the Keychain/Keystore
  device seed on phones) — the same key that proves identity when joining a CLAN. Names, addresses and ports are
  never identity. Friendships, blocks, conversations and transfers are keyed by that key.
* Each computer has a long-lived **people TLS certificate** (keystore `people-tls`). A `PeerTlsBinding` signed by the
  identity key vouches for the certificate's SPKI, so “this TLS endpoint is that person” is verifiable end to end.
* **Safety number**: derived from both keys, shown on both sides; comparing it in person (or connecting by QR) marks
  the contact verified.

## Discovery and visibility
| Mode | Advertised (DNS-SD `_clanpeer._tcp`) | Who can open a connection | Profile shown |
|---|---|---|---|
| Everyone Nearby (opt-in, 1 h in the UI, ≤ 8 h, reverts to Friends Only) | random id, rotated hourly and on change | anyone on the LAN | fields marked Everyone |
| Friends Only (default) | random id | friends, requests and conversation partners; holders of the QR invite secret; strangers may only *ask* (friend request / chat invite), rate-limited | per field |
| Invisible | nothing | only people you already have a friendship, request or conversation with; strangers and QR holders refused | per field, to those people |

Adverts carry only `{v, r}` (random). The identity key is released only to callers allowed by the table, via a
signed `/peer/hello`. Phones are never advertised and accept no connections.

## Static QR
`clan://p/<key>?h=<endpoints>&s=<SPKI sha256>&i=<invite secret>&n=<name>`. Connecting requires the device at that
address to present the certificate in `s` *and* a valid binding from `<key>`; otherwise refused. “Make a new code”
rotates the invite secret so older copies stop working. Desktop scans by camera (jsQR) or a picture; phones paste the
code text in this build.

## Transport
* TLS 1.3 people endpoint (`packages/server/src/people-server.ts`). Every request carries `x-clan-peer` (key, time,
  nonce, body SHA-256) and `x-clan-peer-sig` over `method | path | ts | nonce | bodySha | key | recipient`. The
  recipient is the callee's key (or, at first contact, the SPKI the caller saw), so a captured request cannot be
  replayed to someone else; nonces are remembered; skew limit 120 s.
* **Envelopes** (`PeerEnvelope`): signed end to end, `from` must equal the authenticated connection's key, `to` must be
  this device, replay window 14 days with a seen-id table. Kinds: friend.*, chat.*, msg.text/read, file.offer/accept/
  decline/cancel/done, call.invite/answer/ice/reject/end.
* **Introductions** ride on inbox POSTs (signed binding + endpoints + the profile the recipient may see) so the
  recipient can reply; validated before a route is stored.
* **Phones**: one authenticated WebSocket per known computer (`/peer/ws`, signed first message) while the app is in
  the foreground; the computer pushes queued envelopes and live signals there and the phone acknowledges. Phones fetch
  files with signed GET + Range and push their own with signed PUT chunks (4 MiB).
* Outbox: persistent, backoff + retry, survives restarts; the computer keeps the same people port across restarts so
  saved routes stay valid; discovery refreshes routes when addresses change.

## Conversations
Conversation id = deterministic UUID of the two keys. A chat needs mutual acceptance of identical terms: **saved** or
**temporary** (1 h / 24 h / 7 d). A peer cannot change terms by accepting; changing terms is a new invitation. Temporary
messages and files are deleted on both devices when they expire (sweep runs at start and every minute — works across
restarts). Clear / remove are local and the UI says the other person keeps their copy.

## Files and voice notes
Offer (name, size, SHA-256, retention) → explicit accept (free-space check first) → only the conversation peer can
fetch the accepted transfer → Range-resumable → SHA-256 + size verified before it enters the Resource Store
(module `people`, entity `transfer`) → signed `file.done` receipt to the sender. Every preview/save/Open With re-hashes
the stored bytes first. Limits: files 2 GiB, voice notes 10 MiB in webm/ogg/mp4/aac; voice notes inside an accepted
chat download by themselves.

## Calls (desktop)
WebRTC audio in the renderer, `iceServers: []` (LAN host candidates only), non-trickle: the full SDP — including the
DTLS fingerprint that keys SRTP — travels inside a signed envelope, so media is bound to the authenticated person.
Call signals are never queued, refused if older than 60 s, and accepted only between friends or in an active chat.
Microphone access is granted by the main process only for 15 s after the user starts a call or a voice note.

## Sync
Friend/block relations sync to the user's own linked devices (`people-relation` sync provider). The other person's
devices do not learn about it automatically (they recognise each device key separately).

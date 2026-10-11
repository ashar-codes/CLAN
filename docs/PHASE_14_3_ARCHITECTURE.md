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

---

# Phase 14.3 C+D — router-free connectivity, QR everywhere, optical transfer

## One communication layer, many carriers
Every personal message, receipt, file, voice note, profile picture and call signal is the same signed `PeerEnvelope`
applied by the same `People` core. Two carriers deliver them:
* **HTTPS people endpoint** (A+B): computers only (TLS 1.3, pinned, signed requests).
* **clan-link/1** (C): any reliable byte stream — LAN or hotspot TCP, Wi-Fi Direct group, Wi-Fi Aware data path, Apple
  peer-to-peer Wi-Fi — between any two devices, phones included. `ConnectionManager` keeps one session per person,
  redials remembered addresses with backoff while there is work, survives a change of carrier (the outbox and transfer
  state live in the core, not the session), and reports Connecting / Connected / Reconnecting / Offline / Failed. A
  message counts as delivered only when the other device's authenticated per-envelope result says it was applied.

### clan-link/1 handshake (packages/protocol/src/link.ts)
SIGMA-I with standard primitives (shape of Noise XX, responder identity last): X25519 ephemerals → HKDF-SHA256 over the
transcript → ChaCha20-Poly1305. The initiator proves its Ed25519 identity first (and may present a QR invite); the
responder applies its People policy (friend / request / conversation / invite / Everyone Nearby, never if blocked)
**before** revealing who it is; its signature also covers the initiator's key (no identity misbinding). Data frames use
per-direction keys and 64-bit counter nonces; a failed or replayed frame ends the session. Frame ≤ 1 MiB, handshake 10 s.

### Discovery privacy (applies to computers and phones)
Adverts (DNS-SD `_clanpeer._tcp` / `_clanlink._tcp`, Android NSD, P2P DNS-SD, Wi-Fi Aware service info, Bonjour) carry
only a random id `r` (rotated hourly / on visibility change) and `t = HMAC(presenceKey, r)`. The presence key is a
per-device secret given only to friends (rotated when a friendship ends). A device connects as itself only to adverts
whose tag matches a friend; any other advert is looked at under a **throwaway identity**, so only people who chose
Everyone Nearby answer and nobody learns who is looking. (This also fixed an A+B leak where desktops probed every
advert with their real key.)

## Transport capability matrix (what the code supports — hardware status in PHASE_14_3_HARDWARE_TESTS.md)
| Path | Android | iPhone | Mac / Windows app | Needs a router? | Data | Discovery | Notes |
|---|---|---|---|---|---|---|---|
| Same Wi-Fi / Ethernet (LAN) | ✅ link (NSD) + HTTPS to computers | ✅ link (Bonjour) + HTTPS to computers | ✅ HTTPS + link (DNS-SD) | yes (no internet needed) | full | automatic | |
| Phone hotspot (local-only) | ✅ creates (Android 8+, `startLocalOnlyHotspot`) and joins (Android 10+ `WifiNetworkSpecifier`) | joins only (`NEHotspotConfiguration`, entitlement) — creating needs Settings › Personal Hotspot | joins via OS Wi-Fi | no | full | automatic once joined | Wi-Fi QR (`WIFI:`) shown by the host phone |
| Wi-Fi Direct | ✅ P2P DNS-SD + group (other person accepts the OS prompt); client dials group owner | ✗ (not available on iOS) | ✗ in this app (Windows Direct is the separate CLAN Direct hosting mode) | no | full | automatic (friends by tag) | |
| Wi-Fi Aware (NAN) | ✅ Android 10+ with the hardware feature; secured NDP carries the port; IPv6 | ✗ not used (iOS 26 Wi-Fi Aware evaluated: new framework + entitlement, no SDK here — not implemented) | ✗ | no | full | automatic | Android ↔ iPhone over Aware not supported in this build |
| Apple peer-to-peer Wi-Fi (AWDL) | ✗ | ✅ Network.framework `includePeerToPeer` listener + browser | ✗ (Electron/Node cannot) | no | full | automatic | iPhone ↔ iPhone only |
| CLAN Direct network (A+B era) | joins | joins | Windows/macOS host | no | classroom | BLE bootstrap | unchanged; people links also work on it |
| Optical QR (clan-qrx/1) | ✅ camera + picture import | ✅ | ✅ (webcam) | no network at all | ≤ 2 MiB, best ≤ 256 KiB | n/a | private mode encrypts to a receive code |
| Bluetooth LE | existing Direct bootstrap only | existing Direct bootstrap only | Direct host bootstrap | — | small frames | — | **not used for people** in this build: Wi-Fi Direct/Aware/AWDL give discovery and full bandwidth; BLE GATT would add little except Android ↔ iPhone presence, left for later |
Cross-platform without a router: iPhone ↔ Android uses a phone hotspot (Android creates, iPhone joins by QR) or the
optical QR transfer. Phone ↔ computer uses a hotspot (either creates) or a computer's CLAN Direct network.

## Mobile availability (no hidden listeners)
Settings › Nearby on the phone: **Off** (nothing listens/advertises; scanning a code still connects on purpose),
**While using CLAN** (default; stops when the app leaves the foreground), **Stay available during an active session**
(Android: a `connectedDevice` foreground service with a visible notification and a Stop action, started only while a
chat/call/transfer session is open and stopped when it ends, never at boot; iOS: the short background time iOS grants,
plus the `audio` background mode during a call). No indefinite background discovery, ringing or availability is claimed.

## QR codes
| Code | Format | Authority / replay |
|---|---|---|
| Person (profile / friend request / chat invitation) | `clan://p/<key>?h=…&s=<pin>&l=<link addr>&i=<invite>&n=…&x=friend\|chat` | whoever answers must prove `<key>` (and the TLS pin); invite is revocable ("Make a new code") |
| Device link | `clan://link?c=<code>&a=<addr>` | the existing one-time 2-minute code, still approved on the existing device |
| CLAN Direct join | `clan://direct#…` (A+B era) | network only; the six-digit code still decides membership |
| Hotspot | standard `WIFI:T:WPA;S:…;P:…;;` | network access only; people links still authenticate |
| Optical transfer frame | `CLQ1<base64url>` | CRC per frame, SHA-256 per transfer; private mode encrypted |
| Receive code / receipt | `clan://qrx/key?k=<x25519>` / `clan://qrx/ack?t&h&k&s` | one-time key / Ed25519-signed by the receiver |
Host-transfer pairing (14.2 hand-over) runs between the owner's linked devices, so the device-link QR covers it.

## Optical transfer (packages/protocol/src/qrstream.ts)
Systematic LT fountain code (robust soliton, degree ≤ 40) over the blob; CRC-32 per frame; META frame every 8 frames;
receiver keeps nothing before Accept, ignores other streams afterwards, bounds stored symbols (3·K) and block count
(≤ 20 000), and checks blob length + SHA-256, then file size + SHA-256 (after decryption in private mode). Private mode:
receiver shows a one-time X25519 receive code; file and its name are XChaCha20-Poly1305 encrypted under HKDF of the
ECDH secret; the sender may sign the description with its CLAN identity. Receipt = receiver-signed `ack` QR the sender
scans. Public mode says plainly that anyone filming the screen can read the file.

## Calls, voice notes, pictures, linked devices
* Calls: `@classroom/client/call` state machine shared by desktop (Chromium WebRTC) and phone (react-native-webrtc).
* Voice notes: phone records AAC/MP4 (expo-audio); desktop prefers AAC/MP4 where the OS has an encoder, else WebM/Opus.
* Profile pictures: served only to viewers whose profile view includes one; accepted only if PNG/JPEG ≤ 512 KB and
  exactly the SHA-256/size in the signed profile; LRU cache (300).
* A friend's other devices: each device self-signs `clan-device/1|account|key`; statements sync between the account's
  own devices (rejected without a valid self-signature) and are offered to friends, who must explicitly trust each
  device after seeing its safety number.

## Security decisions (C+D)
1. No new cryptographic constructions beyond composition of standard primitives; the link handshake is tested against
   wrong peer, active MITM, tampering, replay, refusal-without-disclosure, malformed and silent peers.
2. Discovery never reveals identity to strangers (presence tags + throwaway-key probes).
3. Wi-Fi Aware data paths use a passphrase derived from the public advert id only because Android exposes the port only
   on secured NDPs; it is not relied on for security (the link handshake is).
4. A device's people identity is never asserted by another device; friends must opt in per device.
5. All network input (adverts, QR text, frames, envelopes, chunks, pictures) is size-bounded and schema-checked; file
   writes go only to app-owned part files named by transfer id; names from peers are sanitised.

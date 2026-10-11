# Phase 14.3 A+B progress (Nearby People & Friends; Personal Messaging & Calls)

Branch `claude/phase-14.3-ab` from Phase 14.2 head `80d431c`. Status values: PASS (executed), FAIL, NOT TESTED.

### Stage 1 — protocol and core (cloud)
`packages/protocol/src/people.ts`: signed profiles (identity = the device's keystore-held Ed25519 key, the same key
that proves identity when joining a CLAN), TLS-to-identity binding, rotating discovery adverts without personal data,
signed request statements, end-to-end signed envelopes (friend, chat, message, read, file, call signaling), a shared
conversation id, static profile QR, safety numbers. `packages/clan/src/modules/people`: profile with per-field visibility
(Everyone / Friends / Nobody) and discoverability (Everyone Nearby — opt-in, expires after at most 8 h —, Friends Only
(default), Invisible); contacts by key; friend request/accept/reject/cancel/remove; local silent blocking; per-sender
and overall rate limits for unsolicited contact; conversations needing mutual acceptance of identical terms (permanent
or temporary 1 h / 24 h / 7 d; a peer cannot change terms when accepting); text, delivery/read receipts, unread counts,
pagination; persistent outbox with backoff and retry; clear / remove locally; temporary expiry swept on both sides
(works across restarts); files with explicit consent, peer-only access, SHA-256 + size verification, temporary/permanent
retention; voice notes (format/size limited, pre-accepted inside an active chat); call signaling only for friends or
active chats, never replayed (60 s), call log; replay protection; friends/blocks synced to linked devices.
PASS: 9 core tests (`packages/clan/test/people.test.ts`) + clan suite.

### Stage 2 — people transport and discovery (cloud)
`packages/server/src/people-server.ts`: TLS 1.3 people endpoint (certificate SPKI vouched for by the identity key);
every request signed by the caller's identity key over method, path, time, nonce, body hash and recipient (its key, or
at first contact the SPKI the caller saw, so a relay cannot reuse it); nonce replay protection; strangers are refused
(and throttled per address) unless this device is visible to Everyone Nearby, they hold our QR secret, or they only ask
(friend request / chat invitation) while we are not Invisible; profiles released per visibility; envelopes applied by
the core; Range-resumable file serving only of accepted transfers to the conversation peer; chunk upload for phones;
phones keep an authenticated WebSocket (signed first message) and receive/acknowledge their queue there. DNS-SD
`_clanpeer._tcp` with only a random id, rotated hourly and on visibility change; nothing advertised while Invisible.
`packages/client/src/people.ts`: first contact binds the TLS key seen on the wire to the signed identity; pinned +
signed client; resumable downloads. `apps/desktop/src/main/people-runtime.ts` (Electron-free): outbox delivery with
introductions (signed binding + endpoints + permitted profile), downloads, live call signaling (never queued), phone
sockets, discovery/probing, QR connect (key and pin must match the code; QR carries a revocable invite secret).
PASS (Linux, real TLS on loopback and the container LAN): QR verified first contact; forged QR pin refused; stranger
refused in Friends Only; friends, messages, delivered/read receipts; offline queue delivered after the peer restarts;
Everyone/Invisible/block; forged request signature (401); consent-gated, Range-resumed, SHA-verified 3 MB transfer;
live call signal; phone socket auth, queue delivery + ack, forged socket closed; automatic mDNS discovery (Everyone
appears, Friends Only hidden, Invisible disappears).

### Stage 3 — desktop app (cloud, Linux Electron under Xvfb)
Navigation: My Space · My CLANs · Nearby (People + CLANs) · Chats · Friends · Study · Saved · Me. Main process
`apps/desktop/src/main/people.ts` (identity = keystore `device-ed25519`; TLS key in the keystore; same port across
restarts), renderer `world/people/*`. Nearby: visibility (Everyone Nearby for 1 h with a public-network warning /
Friends only / Invisible), people found by discovery, QR card (show code, scan by camera via jsQR, scan a picture,
paste, make a new code), connected-by-code card. Friends: profile editor with per-field visibility and picture,
requests in/out, friends, blocked, person card with safety number + “The numbers match”, chat, call, remove, block.
Chats: invitation with terms (saved / temporary 1 h · 24 h · 7 d), change terms, accept/decline, pagination, auto-scroll
with “Jump to latest”, delivery states + retry, temporary countdown, clear/remove/end (stating the other person keeps
their copy), files (consent, progress, cancel, retry, preview, save, Open With, re-hashed before every use, free-space
check before receiving, signed `file.done` receipt to the sender), voice notes (record → listen → send; play/pause/
seek). Calls: WebRTC audio, no STUN/TURN, offer/answer inside signed envelopes (binds DTLS fingerprints to identity);
calling/ringing/connecting/connected/reconnecting/ended, busy, mic denied, 45 s ring timeout, connect timeout, network
loss, mute, call log line in the chat, live “receiving audio” from WebRTC stats. Microphone/camera are granted by the
main process only for 15 s after the user’s action (voice note, call, QR scan); audio-only / video-only respectively.
PASS: `apps/desktop/e2e/people.test.ts` 5/5, two real app instances (Chromium fake capture devices, real permission
gate): QR picture scan → verified contact; friend request/accept; safety numbers equal; chat delivery + read receipt;
file consent → verified → preview → save (byte-identical) → sender sees Verified; voice note record/preview/send/play;
audio call ring/answer with RTP bytes flowing both ways, hang-up logged; temporary terms accepted; message queued
while the peer app is closed and delivered after restart; history kept across restart; clear history local only;
Everyone Nearby discovered by mDNS, Invisible disappears; blocked sender’s message shows Not sent.

### Stage 4 — phone (cloud: source + Node; no device run)
`apps/mobile/src/people/runtime.ts` (platform-agnostic) + `native.ts` (pinned-transport module, expo-file-system,
Keychain/Keystore device key). A phone runs no server: connects to a computer by its code (first contact reports the
SPKI seen, must equal the code and the signed binding), pinned + signed requests, one authenticated socket per known
computer while the app is in the foreground (stopped in background), GET downloads with Range, chunked signed PUT
uploads (4 MiB), free-space check. Screen `People` (tab): Nearby (connect with pasted code), Friends, Chats (terms,
accept/decline, text, receipts, retry, files with consent/progress/cancel/retry, Share/Open after re-hash, clear/remove/end).
PASS: `packages/clan/test/people-phone.test.ts` — the phone runtime against a real computer runtime (Node stand-ins for
the native transport): wrong pin refused, verified connect, friendship over the socket, chat both ways, 1.5 MB
computer→phone and 9 MB phone→computer files verified with receipts. Mobile typecheck PASS.
NOT IN THIS BUILD (needs native modules / device validation): phone-to-phone contact (no listener on phones), camera QR
scanning (expo-camera), voice-note recording/playback (expo-audio), calls on phones (@livekit/react-native-webrtc is
present but the call UI is unvalidated, so not shipped).

### Stage 5 — verification (cloud, Linux)
| Check | Result |
|---|---|
| `pnpm typecheck` (root, desktop, mobile, visual-lab) | PASS |
| `pnpm test` unit + integration | PASS — 392 passed, 14 skipped (hardware/LAN-gated), 0 failed |
| People core / transport / phone runtime | PASS — 9 + 5 + 1 |
| Desktop E2E `people.test.ts` | PASS — 5/5 |
| Desktop E2E full suite (Phase 14.2 regression: hosting, classroom, join, chat, sync, lifecycle, sharing…) | 30 passed, 2 skipped, 6 failed — the same 6 as the untouched Phase 14.2 baseline: screen sharing ×3 (no capture in Xvfb), Astra canvas/world ×2 (WebGL blocklisted), board-tape (pre-existing `Leave` vs `Leave membership` selector clash). None in code this phase touched. |
| Mobile: Metro Android bundle (`expo export`) | PASS (People screen included) |
| macOS / Windows / Android / iOS hardware | NOT TESTED — `PHASE_14_3_HARDWARE_TESTS.md` |

---

## Phase 14.3 C+D (branch `claude/phase-14.3-cd`, draft PR #3 → `claude/phase-14.3-ab`)
Stages (each committed with tests): C1 clan-link/1 · C2 link sessions + connection manager + TCP transport + desktop ·
presence keys + anonymous probing · C3 phone native peer transport (Kotlin/Swift) + nearby service · D1 clan-qrx/1 ·
D2 phone QR/optical UI, desktop optical UI, device-link/Wi-Fi codes · A+B gaps: shared call engine, phone calls and
voice notes, profile pictures, a friend's other devices · hostile-peer tests · docs. Design: PHASE_14_3_ARCHITECTURE.md.

### Verification (cloud, Linux) — final run
| Check | Result |
|---|---|
| `pnpm typecheck` (root, desktop, mobile, visual-lab) | PASS |
| `pnpm test` (unit + integration) | PASS — 417 passed, 14 skipped (LAN/hardware-gated), 0 failed (56 files) |
| Link protocol / people link sessions / presence / LAN discovery privacy | PASS (part of the above: link 6, people-link 6, people 12, transport 6, phone runtime 1) |
| Animated QR round trips through real QR images (drops, dupes, reorder, damage, forged, private, receipts) | PASS — 4 |
| QR formats, call engine | PASS — 3 + 3 |
| Desktop E2E full suite | 32 passed, 2 skipped, 6 failed — the same 6 pre-existing Linux failures (screen sharing ×3, WebGL ×2, board-tape `Leave` selector). People 5/5 and optical 2/2 (fake-camera Y4M receive; on-screen frames decode to the exact file) PASS |
| Android Kotlin (pinned-transport, direct-join, share-intake, peer-link) | type-check PASS against Android 16 API surface — NOT a Gradle build |
| iOS Swift | NOT COMPILED (no Xcode in the cloud) |
| Metro bundles (`expo export` Android + iOS) | PASS |
| Any phone, Mac, Windows, radio, camera or microphone on hardware | NOT TESTED |


## Local native QA — 2026-10-12

See [the native QA/security and artifact record](LOCAL_QA_PHASE_14_3.md) and [draft PR #4](https://github.com/ashar-codes/CLAN/pull/4). Application repairs were built from `fa5bfc7d25b9b1ef56ef1e1b2749fc76e2c288c9`; **release remains BLOCKED**. Internal TEST/UNVERIFIED DMG/APK and an unsigned simulator app exist; Windows, physical-device and release-signing gates remain open. Full test failures and skips are retained in the record.

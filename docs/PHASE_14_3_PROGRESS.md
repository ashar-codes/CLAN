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

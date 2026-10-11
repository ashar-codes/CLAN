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

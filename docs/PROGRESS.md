# Progress

| Milestone | Status |
|---|---|
| 0 — repo, shells, tests, local server | ✅ done |
| 1 — LAN Mode, classroom creation, discovery, 6-digit pairing, identity, approval | ✅ done (desktop verified E2E; mobile code-complete, not device-tested) |
| 2 — file repository, resumable transfer, assignments | ✅ done (desktop verified E2E dev + packaged; mobile code-complete, not device-tested) |
| 2.5 — secure pairing (OPAQUE), TLS bound to the PAKE, Ed25519 device + teacher identity, signed receipts | ✅ done for desktop (dev + packaged macOS E2E); mobile blocked on a compatible OPAQUE binding (documented) |
| 3 — Windows Direct Mode, auto Wi-Fi join | not started |
| 4 — LiveKit, screen/window sharing, student presenting | not started |
| 5 — PDF sync presentation, notes, bookmarks | not started |
| 6 — chat, Q&A, raise hand, snippets, announcements | not started |
| 7 — polls, quizzes, attendance, groups | not started |
| 8 — whiteboard, exam mode, recording | not started |
| 9 — archive, timeline UI, search, diagnostics, sync outbox | not started (timeline events are already recorded) |
| 10 — hardening, load, packaging, E2E | partial: packaging config + verified unpacked macOS build |

## Milestone 1 delivered
* Teacher: create class (title, join rule), LAN adapter selection, big join code, approve/reject/approve-all,
  remove/block, lock joining, change join rule, end class, live roster with connection state, timeline, network card.
* Student (desktop + mobile): profile (name, roll no, device name, persistent random device id), join by code with
  automatic discovery, waiting-for-approval, in-class view with Excellent/Good/Poor/Reconnecting indicator,
  automatic reconnect, clear messages for rejected/removed/blocked/ended/expired.
* Server: join throttling, hashed sliding-expiry tokens, server-side authorization, presence log, append-only events,
  migrations.
* Tests: 25 unit/integration/security + 1 two-app Electron E2E (also against packaged app). Benchmarks recorded.

## Milestone 2 delivered
* Teacher: add files (hash + progress), list with size/type/time/SHA, per-file Completed/Downloading/Queued/Paused/Failed/Not
  started counts and per-student states, Send to Everyone, Hide/Make available, Remove, live transfer stats; assignments
  (title, instructions, due, allowed types, max size) with Submitted/Late/Missing/Uploading/Failed per student, "Show file",
  close; previous classes list.
* Student desktop: file list with Download/Pause/Resume/Retry/Open (safe types)/Show in folder, queued/verifying/resumed states,
  auto-download on Send to Everyone, assignments with submit / new version, upload progress, receipts on disk.
* Protocol: streamed Range downloads with ETag/If-Range/Repr-Digest, resumable idempotent uploads, server-side hash checks,
  atomic finalization, configurable limits, idle watchdogs.
* Tools: file benchmark (server in its own process), browser-based real-network benchmark.
* Mobile: same flows on Expo (unverified on device).

## Milestone 2.5 delivered
* OPAQUE pairing with the 6-digit code (code never sent or stored); attempt limiting that counts unfinished guesses.
* Per-class session CA + leaf (TLS 1.3, ECDSA P-256, 24 h); PAKE-authenticated binding (HKDF/HMAC over JCS) carrying CA, leaf pin,
  port, session id, teacher key, challenge, expiry; all classroom traffic HTTPS/WSS; plaintext listener serves only OPAQUE.
* Ed25519 device identity in `safeStorage` (desktop) / `expo-secure-store` (mobile); join proof = OPAQUE-derived MAC + device
  signature; trust by key fingerprint; "Known device ✓" / "New device for this roll number"; device-key reconnect and app-restart rejoin.
* Teacher Ed25519 identity; remembered teacher keys with a change warning; signed receipts with offline verifier (library + CLI).
* Tokens: 30 min idle + 8 h absolute; redacted logging; no CORS; WS origin policy; strict content types.
* Desktop: pinning enforced in Node (undici/ws) and Chromium (verify proc); safe-open policy excludes macro/legacy Office.
* Tests 68 → 110; extended secure E2E (dev + packaged); TLS benchmarks recorded next to the plaintext baseline.

## Next
Milestone 3 (Windows Direct Mode) — or first, if phones matter for the pilot: a mobile OPAQUE binding compatible with
`@serenity-kit/opaque` 1.x plus the pinned native transport (see ANDROID_NETWORKING.md / APPLE_PERMISSIONS.md).

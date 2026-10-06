# Progress

| Milestone | Status |
|---|---|
| 0 — repo, shells, tests, local server | ✅ done |
| 1 — LAN Mode, classroom creation, discovery, 6-digit pairing, identity, approval | ✅ done (desktop verified E2E; mobile code-complete, not device-tested) |
| 2 — file repository, resumable transfer, assignments | not started |
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

## Next
Milestone 2: file repository (teacher-local storage, streamed Range downloads, resume, SHA-256, per-student transfer
state, assignment submission with server-time receipts, idempotent uploads) + transfer benchmarks.

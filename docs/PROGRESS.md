# Progress

| Milestone | Status |
|---|---|
| 0 — repo, shells, tests, local server | ✅ done |
| 1 — LAN Mode, classroom creation, discovery, 6-digit pairing, identity, approval | ✅ done (desktop verified E2E; mobile code-complete, not device-tested) |
| 2 — file repository, resumable transfer, assignments | ✅ done (desktop verified E2E dev + packaged; mobile code-complete, not device-tested) |
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

## Next
Before Milestone 3: transport security + trusted device identity (see SECURITY.md known gaps). Then Milestone 3.

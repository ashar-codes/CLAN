# Progress

| Milestone | Status |
|---|---|
| 0 — repo, shells, tests, local server | ✅ done |
| 1 — LAN Mode, classroom creation, discovery, 6-digit pairing, identity, approval | ✅ done (desktop verified E2E; mobile code-complete, not device-tested) |
| 2 — file repository, resumable transfer, assignments | ✅ done (desktop verified E2E dev + packaged; mobile code-complete, not device-tested) |
| 2.5 — secure pairing (OPAQUE), TLS bound to the PAKE, Ed25519 device + teacher identity, signed receipts | ✅ done for desktop (dev + packaged macOS E2E); mobile blocked on a compatible OPAQUE binding (documented) |
| 2.6 — secure mobile join (official OPAQUE WASM in isolated WebView, native pinned TLS) | ✅ implemented; bridge verified in Chromium, iOS trust code verified on Apple Security; **no device run** |
| 2.75 — multi-mode architecture, peer-assisted distribution (control vs data plane) | ✅ done: manifests, endorsements, capabilities, swarm, Teacher-only ↔ Peer-assisted switching; 3-app desktop E2E (dev + packaged); 60/100-client benchmarks; real-Wi-Fi not yet measured |
| CLAN rename | ✅ product-facing name CLAN; legacy identifiers kept and listed in MODULES.md |
| CLAN Phase 1 — visual exploration | ✅ Visual Lab, 8 screens, design system, lazy 3D, screenshots, perf (design/VISUAL-LAB.md) |
| CLAN Phase 2 — modular foundation | ✅ @clan/core: core services, 6 product modules + contracts, classroom→CLAN migration, privacy/AI context, shell (Home/CLANs/Study/Saved/Me) |
| CLAN universal join | ✅ all five types hosted/joined with the same secure pairing; capabilities; generic policies; Study Group 3-app E2E (dev); mobile wording/contracts updated, not device-tested |
| Production world UI | ✅ My Space, Commons, CLAN places + rooms (live + offline), Knowledge Campus on real courses, Saved shelves, calm Diary, Quick Capture, Full/Reduced/Minimal, new palette (night mode), phone layout; native mobile restyled + room header (not run on a device) |
| Network validation | ✅ mDNS discovery root cause fixed (20/20 E2E); BLE throttle metrics; Windows helper artifact + validation script/sparse package; **no Windows/phone/real-Wi-Fi hardware available → all physical rows UNVERIFIED** |
| 3 — CLAN Direct Network (Windows), BLE/QR bootstrap, auto Wi-Fi join | ✅ implemented + mock-verified (BLE bootstrap, sealed credential, re-host, host name, topology probe, Direct E2E); Windows helper compiles; **real Windows/devices UNVERIFIED**, no real-Wi-Fi benchmarks |
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

## Chat & Capture delivered (tag `clan-chat-capture`)
* Real `chat` module: CLAN group + direct conversations, replies, reactions, edit/remove (kept as "removed"), unread, truthful
  SENT/DELIVERED/READ, typing (ephemeral), durable Outbox with idempotent replay; history per CLAN survives re-hosting.
* Send to one CLANmate (wheel › Send, drop on a person) vs the table, same resource system with an audience; members share via
  the resumable upload protocol; person files downloaded from the host only; host-side byte dedupe.
* Capture Inbox (note/link/text/file), link enrichment later, `clan://capture` intake (strict parser), notifications consumer
  (participants only, focus, previews off by default), offline chat history; mobile chat + phone Inbox (typecheck only).
* Tests 227 → 240; E2E +3 (chat Study Group / Classroom / intake). See CHAT.md.

## Screen Sharing delivered (tag `clan-screen-sharing`)
* Local LiveKit SFU (bundled, lazy, crash/stale/port/end handled) behind `MediaTransport`; signaling through pinned TLS.
* Presenting with PRESENT / REQUEST_TO_PRESENT / MANAGE_PRESENTERS, Classroom approval, one presenter + takeover, desktop
  source picker, source switching, Text/Motion/Auto profiles, VP8 simulcast; wall = media surface; presenter bar; wheel Present.
* Short-lived scoped tokens, SFU-enforced publish rights, immediate revocation on stop/removal. Tests 215 → 227; E2E +3.
* Not done: phone viewing (pinned binary WebSocket needed), mobile presenting, real-Wi-Fi measurement. See MEDIA.md.

## Milestones 2.6 and 2.75 delivered
* 2.6: mobile joins with the same OPAQUE 1.1 (official WASM in an isolated WebView, narrow bridge), native pinned TLS modules
  (iOS SecTrust, Android OkHttp), device-key reconnect, peer-assisted downloads on mobile (no seeding). No device run yet.
* 2.75: teacher-signed manifests with chunk hashes; peer endorsements/capabilities/proofs; peer servers on every desktop student;
  scheduler with flash-crowd control and local health; teacher-offline resilience for published resources; revocation; mode
  axes + transport boundaries (Direct/Mesh/Media interfaces only); teacher Network panel with Peer Assistance toggle and
  experimental recommendation; student sharing toggle and source details; swarm benchmark and classroom-mode real-Wi-Fi tool.

## Next
Run `tools/sim/lan-bench.ts --mode classroom` on real Wi-Fi (single AP and multi-AP) and real phones; then Milestone 3.

## Study Engine delivered (tag `clan-study-engine`)
* Real modules: courses (topics with own marks, lectures, references to notes/files/saved incl. past papers), tasks,
  exams (+ Exam Command Center: "N of M topics marked Confident", nothing estimated), reminders (recurrence, snooze,
  dismiss, ReminderDue), flashcards (SM-2 + review history), study sessions (Focus), assignments (projection), agenda
  (Today, Semester Board, AI-ready contexts). Every Classroom gets one linked Course; nothing copied. See STUDY.md, FLASHCARDS.md.
* Desktop: Campus on real courses (floors = topics), course interior (9 sections), Semester Board (Agenda/Week/Month),
  Tasks, Exams, Flashcard review (keyboard/touch/screen reader), session bar + Focus, History, My Space Today/Desk/Board,
  Quick Capture Task/Reminder + direct filing into a course/topic, study notices (conservative defaults).
* Mobile: phone-local Study screen on the same algorithms (typecheck + model test; device runtime UNVERIFIED).
* Tests 240 → 250; E2E 11 → 13 (full study flow with restart; Classroom assignment in Course/Today, not a Task).
* Renderer main chunk 329.0 → 372.5 kB (98.7 → 107.7 kB gzip); CSS +6 kB; Campus 3D chunk unchanged (lazy).

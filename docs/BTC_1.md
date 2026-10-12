# BTC-1 — internal TEST candidate

2026-10-12. Branch `qa/phase-14.3-local`. **TEST / UNVERIFIED; not a public release.**
Application revision is recorded with the delivered installers. No BTC-2/Campus work, relay deployment, draft PR merge or release-key replacement.

## Root causes and repairs

- Android AppState previously stopped the authenticated People socket when backgrounded even when availability was requested; direct-link availability depended on current connections and JS intervals. Explicit **Keep CLAN Available** now retains both transport paths, uses a visible connected-device foreground service, native retry pulses/network-change callbacks and a partial wake lock. Default remains foreground-only. Notification permission is required; Stop disables retention. No boot receiver, sticky restart or battery-policy bypass. Active, user-authorized calls add microphone service type only after microphone permission.
- Reconnection retained retry backoff and stale socket callbacks could overwrite newer connections. New authenticated connections wake pending items; socket generations and stop guards prevent stale callbacks. Existing resource-store attachment copies are reused; sender cache URIs are not the durable source.
- Recipient WebSocket rejection was acknowledged as success; acknowledgments were not checked against the intended recipient. Negative receipts now fail the matching item, and only that item's authenticated recipient can mark it delivered. Transport/relay acceptance is not recipient delivery.
- Expired temporary envelopes could remain queued after local deletion. Queue pruning precedes replay and expiry cleanup. Outbox is capped at 2,000 entries. Sending is transient; restart restores Pending, and authenticated acceptance produces Delivered/Read.
- People events did not present native system notifications. Authorized, committed, deduplicated alerts now feed Electron and Expo notification APIs. Android has an explicit high-importance private channel and permission action. Preferences cover direct/file alerts and optional previews; verified-friend nearby alerts default off and are persistently rate limited. Notification taps open People, including an overlay while a CLAN is active.
- Calls had no durable offline attempt record. Signed, bounded 24-hour call intents contain no SDP/ICE; they produce distinct later-arrived history rather than stale ringing. Real unanswered incoming calls generate missed-call alerts. Ring tones and call handlers remain active across CLAN navigation. No push/TURN credentials are invented.
- Mobile standalone ownership was obscured behind computer linking. A visible Create CLAN flow creates classroom/study/friends/project ownership offline with permanent/day/week lifetime. Existing archive/restore/leave/local-remove/owner-delete rules are retained. Phones do **not** advertise an active embedded desktop server: computer handover is still required for live classroom hosting/configuration/invites.
- Radar views render actual discovery results in People/CLAN modes with actionable existing authenticated flows, QR/address fallback and reduced-motion/background animation controls. Positions are decorative, not physical distances.
- Preserve the previous Mac entitlement repair: Hardened Runtime stays enabled; main and helpers inherit Electron JIT/security exceptions plus `device.audio-input` and `device.camera`. Non-sandboxed Electron uses Audio Input; adding the sandbox `device.microphone` entitlement is unnecessary.

## Verification to date

| Check | Result |
| --- | --- |
| Four-project typecheck | PASS |
| Full controlled unit/integration suite | 459 PASS, 61 files |
| Initial parallel full unit repeat | 454 PASS / 4 timeout FAIL; retained, not hidden |
| Isolated retry including all four timed-out tests | 88 PASS, 7 files |
| Focused People/phone/link/call/availability regression | 34 PASS, 6 files |
| Actual Electron E2E candidate | 38 PASS / 2 optional SKIPPED; separate PERF run 2 PASS |
| Native Android candidate Gradle QA arm64 build | PASS; standalone JS bundle + native modules |
| Physical Redmi update | PASS; in-place install, existing QA signing certificate continuity |
| Signed Mac candidate secure Keychain startup | PASS following local user approval |
| Candidate native iOS simulator/device-SDK compilation | PASS; device build unsigned |
| iOS simulator profile/note/restart XCTest | 1 PASS |
| Quiet complete desktop E2E, PERF enabled | 40 PASS, 23 files |
| Final full unit/integration repeat | 459 PASS, 61 files |
| Native Mac close-window with opt-in availability | PASS; OS window hidden, renderer and People listener retained |
| Physical Redmi Keep mode | PASS foreground service, notification 4401 and wake lock; message reception NOT TESTED |
| Final package rebuild after Windows toast identity fix | Pending; append delivery evidence before completion |

Physical foreground/background/locked message and call tests require the user to enable Keep mode and operate Xiaomi's locked phone; automated input is denied by the OS. They are NOT TESTED until observed. The user's earlier Mac↔Android audio/voice-note success predates this candidate and is not a new PASS. Windows/iPhone physical tests remain NOT TESTED.

## Security review and restrictions

Regression coverage includes envelope forgery/replay/blocking/consent, intended-recipient receipts, bounded call intent, temporary expiry, durable attachments and duplicate suppression. Existing identity/OPAQUE/pinning, handover fencing and QR/file resource-limit repairs remain intact. No security control or OS-protected identity storage was disabled. Raw private logs/invitations and signing secrets are excluded from Git.

Dependency audit remains **0 critical / 2 high / 2 moderate** (node-forge, braces, uuid, sprintf-js in observed build tooling); this is not a clean audit. Desktop databases/files remain plaintext at rest; OS-protected identity keys and encrypted transport do not imply database encryption. Expiration is not forensic erasure of backups/remote copies.

Android foreground service improves availability while its process and network are allowed to run; Doze/OEM restrictions, force-stop and power loss still defeat LAN reception. Notification permission or channel/user OS settings can suppress alerts. Background microphone activation is constrained by modern Android; user action and foreground consent are required.

Desktop tray/menu-bar retention is opt-in; Quit terminates networking. iOS reconnects when foregrounded; suspended apps cannot continuously listen on LAN. No APNs/FCM push path, relay device registration, relay E2EE key protocol or TURN integration has been implemented. Future opt-in relay must preserve LAN-first routing, recipient-authenticated receipts, bounded signed call intent and end-to-end payload encryption; TLS alone is insufficient.

Primary OS references: [Android service types](https://developer.android.com/develop/background-work/services/fgs/service-types), [Doze](https://developer.android.com/training/monitoring-device-state/doze-standby), [Expo notifications](https://docs.expo.dev/versions/latest/sdk/notifications/), [iOS background limits](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time).

## Personal-device checks

Enable notifications and (Android only) Keep CLAN Available. Test open/background/locked receiving, tray-hidden Mac receiving, disconnect/reconnect text/voice/files without duplicates, file acceptance, ringing/missed/later-arrived attempts, opt-in verified-friend alerts, offline mobile Create CLAN/archive/delete, real radar actions and restart persistence. Record PASS/FAIL separately. Router-free radios, hotspot/no-internet, Windows interoperability and two physical iPhones remain hardware gates. Do not treat internal package delivery as public-release approval.

### Final checkpoint details

The previous E2E expected the old Not sent label. It now checks the requested Failed label inside message metadata **and** data-state=failed; all five People E2Es and the complete quiet 40-test suite passed. Earlier runs retained 39 PASS/1 stale-label FAIL and 38 PASS/2 FAIL (selector and recording performance under concurrent native builds). No performance assertion was relaxed; quiet complete rerun passed both PERF tests. Gitleaks scanned 118 commits and staged repairs: zero findings.

Windows toast registration explicitly matches the NSIS shortcut's QA/production AppUserModelID. Physical Windows notification presentation remains NOT TESTED. Source: [Electron platform notifications](https://www.electronjs.org/docs/latest/tutorial/notifications).

The user elected to perform the remaining real-device cross-platform message/audio/notification scenarios manually. Do not claim them passed. Android service startup is observed evidence, not proof of locked message reception. The Android emulator initially refused startup because disposable native build caches left insufficient disk space; original installers and profiles were not removed.

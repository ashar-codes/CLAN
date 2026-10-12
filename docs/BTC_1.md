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
| Final e73cd17 package rebuilds | PASS Android Gradle, macOS DMG, iOS simulator compilation and native Windows CI |

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

## BTC-1 test-build delivery

All four delivered packages use application source **e73cd174f70716c8e914c8e8452030b7550f7f37**, version 0.1.0, branch qa/phase-14.3-local. Later Git documentation checkpoints do not change the application runtime tree. No public release is approved. PRs #1–#4 remain open drafts; none merged or force-pushed.

Final four-project typecheck passed. Complete controlled unit/integration repeat: **459 PASS, 61 files**; complete quiet Electron suite with performance tests enabled: **40 PASS, 23 files**. Final Android Gradle QA build includes bundled JavaScript and native modules. Native Windows CI [38282213989](https://github.com/ashar-codes/CLAN/actions/runs/38282213989) built, installed and started the final NSIS package, passed packaged-profile lock/capture tests, and uninstalled without removing beta firewall rules. Download verified GitHub artifact digest, ZIP CRC, exact commit and installer checksum.

Final iOS arm64 simulator compilation and Xcode-project archive integrity passed. Native device-SDK unsigned compilation and 1 passing simulator profile/note/restart XCTest used the immediately preceding BTC-1 candidate; its mobile, packages, manifests and lockfile are byte-identical to the final application source. No Apple Team or provisioning is supplied: physical entitlements and iPhone installation remain NOT TESTED; no IPA exists.

Final macOS DMG mounted and passed strict deep signature verification. Main app and all four Electron helpers have Audio Input and Camera entitlements, with Hardened Runtime preserved. Updated /Applications/CLAN TEST.app without changing user data; previous bundles preserved. The preceding BTC-1 installed candidate passed secure Keychain startup, actual live microphone capture (23,409 recorded bytes), camera capture (45 changing frames), exact-note restart persistence, and native opt-in window-close retaining the renderer and People listener. Final e73cd17 installed app also passed after local Keychain approval: secure startup, live/unmuted microphone capture (23,409 bytes), 640-wide camera capture (45 frames), exact-note restart persistence, native window-close retaining renderer/listener, and tray Quit stopping the listener. Initial OS-approval block is retained in logs; no Keychain bypass was used.

Final APK v2 signature verifies against unchanged QA debug certificate fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c. Final e73cd17 in-place Redmi update returned Success. Physical Android native Keep service and private persistent notification 4401 were re-observed after the final e73cd17 update; a partial wake lock was observed on the preceding BTC-1 candidate. User elected manual cross-platform tests; open/background/locked message delivery, notification presentation, calls, friend alerts, mobile lifecycle, real radio networking and final-device restart data checks are NOT TESTED. Earlier user-reported successful calls/voice notes are not substituted for these results.

Gitleaks final application history: **119 commits, zero findings**. Audit remains 0 critical / 2 high / 2 moderate dependencies in observed build-tooling paths. Review does not claim encrypted desktop databases, continuous suspended-iOS LAN availability, implemented internet relay/push/TURN, phone live hosting, or complete hardware security approval.

Delivered folder: /Users/ashar/Desktop/CLAN - Installers. Prior Desktop installers and guide copied with checksum verification to Installable Files/BTC-1-pre-e73cd17-backup; earlier backups remain intact. Copies verified nonempty and checksum-identical to original source artifacts.

| Delivered file | Bytes | SHA-256 |
| --- | ---: | --- |
| Windows/CLAN-Windows.exe | 166236080 | `ec0c3b3fcb6a0bc5a6f4374e41d0c05520a89240f548f9af8b64f98973888dc4` |
| macOS/CLAN-macOS.dmg | 163388667 | `2d8ec0fd8345f079a58f395941eb12e93932d489aa659e8a8f41cac0f9fe2942` |
| Android/CLAN-Android.apk | 65874733 | `beecadf6bfd4fa023e7d6f4aaf4108d143229415fd08b55cc9508aa04a5da372` |
| iOS/CLAN-iOS-Xcode.zip | 1122119035 | `2d56c1391b6197795a280c412221d36a9c1dd4c4d441fd7143a6762d37edd522` |

Read Desktop INSTALLATION-GUIDE.md and docs/BTC_1_DEVICE_TESTING_GUIDE.md for install/update, signing restrictions and manual PASS/FAIL/NOT TESTED scenarios. Windows unsigned; macOS ad-hoc, not notarized; Android debug-signed QA, incompatible with another beta certificate; iOS Xcode project requires supported Apple signing. All packages are TEST / UNVERIFIED. No existing signing key, profile or identity was replaced. BTC-2/Campus and internet relay deployment remain out of scope.

### Final Android emulator completion

After removing only confirmed completed native-build caches, disposable clan_143_qa emulator booted successfully. Final e73cd17 APK passed the complete existing native integration scenario: profile/core opening, approved authenticated linking, two-way personal sync, offline conflict and Keep Both convergence, revoked-device refusal, Share-to-Inbox, OPAQUE/pinned-TLS CLAN joining, two-way chat with history/scroll preservation, two-way whiteboard operations and SHA-256-verified file download. Native offline Create CLAN smoke also passed explicit owner/non-hosted state, restart persistence, confirmed archive/restore, delete cancellation and confirmed owner deletion while retaining a personal note. This exercised a Study Group; all four types and temporary options still require the manual checklist on physical hardware. These are emulator PASS results, not physical-device background/message/call claims.

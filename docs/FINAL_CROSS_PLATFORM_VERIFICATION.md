# Final cross-platform verification

Source: `final-clan-polish` @ **08801de** (packages are built from this SHA). Legend: **PASS** verified here ·
**FAIL** · **SKIPPED** deliberately not run · **NOT TESTED** needs hardware/infrastructure not available ·
**BLOCKED** cannot be done without external credentials/devices.

## Automated

| Suite | Platform | Result |
|---|---|---|
| Unit/integration (vitest, 78 files) | macOS | PASS 550/551 in the final run; the 1 failure (`join-discovery` bounded-window timing) passes 3/3 in isolation, passed in the previous full run and on Linux/Windows CI — pre-existing timing sensitivity under full parallel load, file unchanged |
| Unit/integration | Linux CI, Windows CI | PASS (previous push; final SHA run: see table at end) |
| New-feature tests `people-final.test.ts` | all | PASS 8/8 (onboarding gate, persistent Everyone, edit/delete authorship/ordering/tombstones/replay/restart, old-peer refusal, auto-download policy, push relay end-to-end incl. forged MAC/registration, rate limit, revocation) |
| Electron E2E (29 files) | macOS | PASS 28 files / 46 tests, 1 file / 2 tests skipped (pre-existing conditional skips) |
| Electron E2E | Windows CI | PASS on 08801de (see end) |
| Onboarding E2E (fresh profile) | macOS | PASS |
| People E2E (two app instances: QR, friends, chat, receipts, files, voice, audio/video calls, reply/react/edit/delete-for-everyone, visibility, block) | macOS | PASS 7/7 |
| Packaged app smoke (duplicate-profile refusal, capture link, separate profiles) | macOS DMG app | PASS |
| Windows installer build, silent install, launch, packaged regression, uninstall, firewall preservation | Windows CI | PASS (previous push; final SHA: see end) |
| Typecheck (root, desktop, mobile) | — | PASS |

## Native / device

| Check | Platform | Result |
|---|---|---|
| Gradle release-mode QA build (all Kotlin incl. FCM service, MediaStore) | Android | PASS |
| Fresh install → onboarding (validation, name, device, visibility) → home shows real name | Android emulator (API 36) | PASS |
| People › Friends shows real name + device name | Android emulator | PASS |
| Phone ↔ desktop: code (picture scan) connection, identity verified, friend request shows “Zara Android / Zara Pixel” on desktop | emulator + macOS app | PASS |
| Desktop → phone messages; desktop edit and delete-for-everyone shown on phone (“Edited”, “This message was deleted”) | emulator + macOS | PASS |
| Phone long-press sheet (react/reply/copy/forward/edit/info/delete) and edit of own message | emulator | PASS |
| Edit queued while the link was down shows “Edit waiting to reach …”, delivered after reconnection | emulator + macOS (real network change on the Mac) | PASS |
| Reaction + reply with quoted preview, desktop → phone | emulator + macOS | PASS |
| Photo offer with consent → download (SHA-256 verified) → Save to Gallery: MediaStore `Pictures/CLAN/…`, byte-identical | emulator | PASS |
| Native wake-up self-test: genuine shown, forged rejected, repeat deduplicated | Android emulator | PASS |
| CallStyle incoming-call notification (Answer/Decline, category call) and automatic expiry (no stale ringing) | Android emulator | PASS |
| Keyboard no longer covers chat composer; data kept across in-place QA upgrade | Android emulator | PASS |
| In-app upgrade of `.finalqa` keeps data | Android emulator | PASS |
| Real FCM delivery (background/locked/Doze/killed), real push-woken call | Android | BLOCKED (no Firebase project/relay) |
| Physical Android phone | Android | NOT TESTED (no phone attached) |
| Full device compile (`iphoneos`, Release, all Swift incl. PushKit/CallKit/Photos) | iOS | PASS |
| Signed IPA + install on iPhone | iOS | BLOCKED — free team needs the iPhone registered; the paired iPhone became unavailable after the Mac changed networks (see blockers) |
| iOS simulator/device UI run | iOS | NOT TESTED |
| APNs / PushKit / CallKit delivery | iOS | BLOCKED (no paid team, no Push capability, no relay) |
| Hosted CLAN discovery on real LAN between phone and computer | all | NOT TESTED (emulator has no multicast to the LAN) |
| Different routers / bridged APs / routed subnets | all | NOT TESTED |
| Windows ↔ Mac/phone physical tests | Windows | NOT TESTED |

## Regression areas (covered by the suites above)

CLAN membership, assignments, host hand-over, files, personal sync, study modules, timetable, Diary, audio/video
calls, group meetings, screen sharing, remote control with consent and emergency stop: covered by the existing unit
and Electron E2E suites, all passing on macOS (and on Windows/Linux CI per the final-SHA table).

## Final-SHA CI (08801de)

| Workflow | Run | Result |
|---|---|---|
| CLAN final regression (Linux + Windows): typecheck, unit suite, Windows recovery diagnostic, **complete Windows Electron E2E** | 38697983765 | **PASS** |
| CLAN final Windows TEST installer: helpers, NSIS build, silent install, launch, packaged regression, uninstall, firewall preservation | 38697983768 | **PASS** |

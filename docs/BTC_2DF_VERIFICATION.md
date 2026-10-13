# BTC-2D/F verification

Baseline `5226456b382cad2048297eab2ebfd5ed49d08438`; branch `btc-2df-control-timetable`. Separate feature evidence: [RemoteControl](BTC_2D_RESULTS.md), [Timetable](BTC_2F_RESULTS.md). BTC-1 installers and installed personal profiles remain unchanged; no distribution build, merge or release.

## Checkpoints

- `37879e2`: independent RemoteControl protocol/policy, authenticated meeting adapter, desktop native adapters and four-platform controller UI.
- `7bd604e`: active media-proxy lease revocation, explicit participant removal before SFU room deletion, reproducible Mac native-input smoke.
- `9439243`: independent private Timetable domain, native adapters, four-platform interface and tests.
- `32667a00e9320ba7270ed6900cb0e695f323cd9a`: exact capture-ticket/track/renderer binding, native monotonic deadlines and stricter Android UI evidence. This is the final implementation revision; later documentation commits do not change application behavior.

## Available evidence

| Verification | Result | Scope |
| --- | --- | --- |
| Shared/desktop/mobile/lab typecheck | PASS | Four TypeScript projects; does not prove native behavior |
| Remote policy/sender/coordinates | PASS | Eight tests, consent/replay/lease/expiry/disconnect/switch/queue/rate/order |
| Actual local SFU control authorization | PASS | Actual published screen SID, authentication, consent, input/receipt queue, removal |
| Pinned signaling revocation | PASS | Actual pinned WSS client closes on meeting end; current lease checked independently of JWT expiry |
| Mac native input | PASS | Actual OS guard and typing in disposable Electron target; stop rejects subsequent input |
| Windows native adapter compile | PASS | Windows 2025 CI .NET self-contained build; not physical UIPI/input evidence |
| Timetable domain | PASS | Eight fixed-clock/privacy/persistence/sync-validation/notification/image tests |
| Personal-device sync | PASS | Real encrypted authenticated transport, original image bytes/SHA, deletion, conflicts and Keep Both |
| Timetable + hosting/sync regressions | PASS | 35 tests; timetable classified private, selection/alerts device-local |
| Desktop Timetable UI/OCR | PASS | Actual Electron manual CRUD, private image import, actual Mac Vision, reviewed correction, restart |
| Android native Gradle build | PASS | Standalone bundled QA APK with all existing native modules; debug signed, internal only |
| Android emulator Timetable | PASS | Native manual creation/selection/restart/archive/restore; camera/physical notifications not tested |
| iOS simulator native build | PASS | Actual Xcode build including native Vision OCR module and existing SecureStore signing |
| iOS simulator Timetable | PASS | One native XCTest actually executed: manual period/selection/restart; physical provisioning not tested |
| Initial full Mac unit/integration | FAIL | 500 passed, 1 failed: timetable handover-table classification; repaired and affected 35 tests passed |
| Initial full Mac Electron | FAIL | 42 passed, 1 failed, 2 skipped: peer-assisted large transfer stalled during concurrent native build load |
| Isolated peer-transfer repeat | PASS | Original assertions retained; 160 MB transfer/fallback and SHA passed |
| Initial Windows CI | FAIL | Native compile/typecheck/build and Electron regressions passed; one meeting-termination test failed after rejoin; repaired, final rerun pending |
| Initial Linux CI | PASS | RemoteControl checkpoint full software suite; no Linux native controlled-host support advertised |

Frozen-source Mac full unit/integration rerun: **505 PASS, 0 FAIL, 0 SKIPPED**, 68 files, 377.13 seconds. Four-project typecheck and desktop production bundle build PASS. Actual Mac native typing/stop fixture PASS after monotonic deadline changes. Android final native UI repeat asserts exact newly typed version/subject values before restart/archive/restore: PASS. iOS native XCTest repeat after modal editor changes: PASS (one test actually executed).

Intermediate reruns also recorded a screen-E2E pairing failure during concurrent simulator UI tests and an rtc-node worker crash in Linux CI at `9439243` (500 passed, one existing skipped, one unhandled SIGSEGV). Both remain part of the history. CI at `7bd604e` passed Linux and Windows; Windows CI at `9439243` passed native compilation, typecheck, unit and selected Electron regressions. Final implementation [CI run 38356195256](https://github.com/ashar-codes/CLAN/actions/runs/38356195256): **Linux PASS** (504 passed, one pre-existing native platform test skipped); **Windows PASS** (504 passed, same existing skip), self-contained native input adapter compile, four-project typecheck and desktop production build PASS. Windows selected Electron regressions: **15 PASS, 0 FAIL, 0 SKIPPED** across People, meeting, screen, LAN directory, Study and Timetable. These are hosted-runner software/media fixtures, not physical Windows verification.

A subsequent Mac full Electron run ended without a final summary, leaving one recorded chat-scroll failure; the exact original test passed on isolated repeat (one selected PASS, five unselected tests). Its incomplete run is not counted as a full PASS. Complete sleep-protected serialized Mac Electron rerun at `32667a0`: **42 PASS, 1 FAIL, 2 existing SKIPPED**, 26 files, 458.77 seconds. Failure: `chat.test.ts:59` second-member join never produced the host approval button within 25 seconds. The exact complete group chat/file/rehost test passed unchanged on isolated repeat (16.62 seconds). The earlier scroll test also passed unchanged. No assertion was weakened. **Intermittent Mac multicast discovery/join remains unresolved**: isolated passes do not establish that the full-suite failure is fixed. The entire affected chat/file/rehost test file subsequently passed unchanged: **6 PASS**, 64.06 seconds. Actual screen/meeting/Timetable tests passed within the full run. Optional `PERF=1` long benchmarks account for the two skips.

The independent implementation/software checkpoints are delivered, but the combined regression gate is **BLOCKED** by this intermittent join failure and the physical RemoteControl gates. A complete all-green Mac Electron run and physical safety/media/notification checks are required before packaging/release. BTC-2E may be planned against this checkpoint; do not treat it as release-ready.

## SKIPPED and NOT TESTED

Existing Electron suite has two explicitly skipped tests; their exact reasons remain in the tests and final run report. Windows suite retains its existing platform-specific skip. No new acceptance test was skipped to make results pass.

NOT TESTED: physical Mac/Windows multi-display/DPI mapping and protected surfaces, permission revocation, physical Android/iPhone remote control, physical camera/photo/OCR diversity and local alarm lock/force-stop behavior, cross-device media on actual cameras/microphones, physical multi-router LANs and iPhone signing/provisioning. iOS/Android are controller-only; safe whole-display hosts are Mac/Windows. Window-scoped native input is unavailable. Windows/Android local OCR is unavailable; manual entry and original images remain supported. Desktop alerts require a running app/tray; mobile alarms require permissions, bounded future schedule refresh and OS allowance.

Two high/two moderate dependency findings and desktop database at-rest encryption limitations remain open. Control traffic is trusted-host-mediated inside pinned TLS, not host-blind E2EE; LiveKit media has transport encryption, not claimed group E2EE.

## Next verification

First reproduce the Mac three-client discovery/join intermittency with disposable profiles and bounded diagnostic traces. Distinguish multicast discovery from actual authenticated join failure; use manual/QR fallback for diagnosis, not to bypass the failing automatic-discovery assertion. Do not log tokens or private keys. Then repeat the full Electron suite.

## Next physical verification

Use a disposable Mac/Windows target with normal Accessibility/Input Monitoring/Screen Recording/UIPI boundaries. Share a whole display; request control from each desktop/phone, deny first, then explicitly approve. Verify verified identity, visible indicator, typing/click/drag/scroll, emergency stop, local input priority, source resize, screen stop, disconnect, blocking/removal and host transfer. Confirm protected prompts and locked desktops cannot be controlled.

On each device, create a timetable, import a real readable image, correct it, select active, verify current/next at boundaries, add a holiday/reschedule, restart, link personal devices and test concurrent edits/deletion/image integrity. Enable reminders explicitly; verify quiet hours and duplicate alerts, background/locked delivery and denied permissions. Verify unavailable OCR accurately exposes manual entry. Physical Apple signing/team provisioning must be validated separately.

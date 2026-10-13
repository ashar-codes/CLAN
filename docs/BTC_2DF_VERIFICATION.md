# BTC-2D/F verification

Baseline `5226456b382cad2048297eab2ebfd5ed49d08438`; branch `btc-2df-control-timetable`. Separate feature evidence: [RemoteControl](BTC_2D_RESULTS.md), [Timetable](BTC_2F_RESULTS.md). BTC-1 installers and installed personal profiles remain unchanged; no distribution build, merge or release.

## Checkpoints

- `37879e2`: independent RemoteControl protocol/policy, authenticated meeting adapter, desktop native adapters and four-platform controller UI.
- `7bd604e`: active media-proxy lease revocation, explicit participant removal before SFU room deletion, reproducible Mac native-input smoke.
- Timetable is the next independent feature checkpoint; final Git revision is supplied by the commit containing this document and the completion report.

## Available evidence

| Verification | Result | Scope |
| --- | --- | --- |
| Shared/desktop/mobile/lab typecheck | PASS | Four TypeScript projects; does not prove native behavior |
| Remote policy/sender/coordinates | PASS | Seven tests, consent/replay/lease/expiry/disconnect/switch/queue/rate/order |
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

Final combined rerun counts are appended after all checks finish. Initial failures are retained above, not hidden.

## SKIPPED and NOT TESTED

Existing Electron suite has two explicitly skipped tests; their exact reasons remain in the tests and final run report. Windows suite retains its existing platform-specific skip. No new acceptance test was skipped to make results pass.

NOT TESTED: physical Mac/Windows multi-display/DPI mapping and protected surfaces, permission revocation, physical Android/iPhone remote control, physical camera/photo/OCR diversity and local alarm lock/force-stop behavior, cross-device media on actual cameras/microphones, physical multi-router LANs and iPhone signing/provisioning. iOS/Android are controller-only; safe whole-display hosts are Mac/Windows. Window-scoped native input is unavailable. Windows/Android local OCR is unavailable; manual entry and original images remain supported. Desktop alerts require a running app/tray; mobile alarms require permissions, bounded future schedule refresh and OS allowance.

Two high/two moderate dependency findings and desktop database at-rest encryption limitations remain open. Control traffic is trusted-host-mediated inside pinned TLS, not host-blind E2EE; LiveKit media has transport encryption, not claimed group E2EE.

## Next physical verification

Use a disposable Mac/Windows target with normal Accessibility/Input Monitoring/Screen Recording/UIPI boundaries. Share a whole display; request control from each desktop/phone, deny first, then explicitly approve. Verify verified identity, visible indicator, typing/click/drag/scroll, emergency stop, local input priority, source resize, screen stop, disconnect, blocking/removal and host transfer. Confirm protected prompts and locked desktops cannot be controlled.

On each device, create a timetable, import a real readable image, correct it, select active, verify current/next at boundaries, add a holiday/reschedule, restart, link personal devices and test concurrent edits/deletion/image integrity. Enable reminders explicitly; verify quiet hours and duplicate alerts, background/locked delivery and denied permissions. Verify unavailable OCR accurately exposes manual entry. Physical Apple signing/team provisioning must be validated separately.

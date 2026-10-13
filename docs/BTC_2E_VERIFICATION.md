# BTC-2E verification

Branch `btc-2e-ux-completeness`, baseline `843edef7602a9fd0a4a28cd2a214052d092601fc`. No installers rebuilt/replaced, no installed app/profile/key reset, no draft PR merged. Final application checkpoint: `4bb9b70a399ca412ac920bc45d5b3fa89fd1228c`; subsequent documentation does not change application code. Historical failures and checkpoint-specific results are retained below. Broad acceptance: **BLOCKED** until all required coverage/remaining gaps are resolved.

## Reliability evidence

- Unchanged baseline isolated chat file: **6 PASS** (65.24 s).
- Controlled baseline full Mac Electron: **43 PASS, 0 FAIL, 2 existing SKIPPED** (400.31 s; 26 files). Old second-member approval timeout not reproduced.
- Deterministic newly identified race: one-time candidate snapshots keep stale addresses while the real host arrives later. Repaired shared bounded candidate updates, Bonjour endpoint/TXT refresh and expiry; no assertion timeout increased. Real OPAQUE/pinned-TLS fixtures verify late host, wrong host, deduplication and isolation; update fixture verifies TTL/down cleanup.
- Targeted security/discovery: **46 PASS**; follow-up discovery fixtures **3 PASS**. This does not prove the exact historical intermittent full-suite cause resolved. Bounded diagnosis remains in disposable local traces outside Git.

## Final available checks (`4bb9b70`)

| Check | Status | Evidence |
| --- | --- | --- |
| Four-project typecheck | PASS | Root, desktop, mobile, visual-lab |
| Lifecycle + authenticated sync | PASS | Final targeted lifecycle/recordings/Study/sync: 47 PASS; explicit recovery, reference protection, collision rejection and search deletion |
| Lifecycle + Study/Timetable/module boundaries (earlier checkpoint) | PASS | 51 tests |
| New Electron lifecycle UI | PASS | Included in final 44 PASS; standalone expanded fixture 1 PASS (9.70 s): editor failures/cancel/delete, Course/lecture/board/Diary and restart |
| Existing Study + Timetable Electron targeted | PASS | 3 tests |
| First new UI-test run | FAIL | Wrong new test navigation selector `Diary`; corrected to actual existing `Me` navigation; original assertions retained |
| Full unit/integration | PASS | 520 PASS, 71 files, 418.44 s |
| Complete Mac Electron | PASS | 44 PASS, 0 FAIL, 2 existing performance SKIPPED; 27 files, 424.05 s |
| Repeat affected join/chat file | PASS | 6 PASS at 67.58 s; second run 6 PASS at 60.39 s; no timeout/assertion increase |
| Android Gradle + emulator UI | PASS | Final standalone QA build (14 s); actual Course edit/archive/restore/cancel/confirmed deletion and Notes/restart; disposable AVD only |
| iOS Xcode + simulator XCTest | PASS | Final actual native build; 3 XCTest PASS (171.593 s); disposable simulator, no physical provisioning |
| Windows/Linux CI | PASS | Final CI: each 519 unit/integration PASS, 1 Mac-only SKIPPED; Windows 22 selected Electron PASS |
| Physical Windows/Android/iPhone | NOT TESTED | No physical test inferred |
| Physical multi-router / capture permission/revocation | NOT TESTED | Carry-forward hardware gate |

## Security and limitations

`pnpm audit`: **0 critical, 2 high, 2 moderate**. Carried-forward node-forge RSA verification and braces stack-exhaustion findings (high), uuid buffer bounds and sprintf-js precision exhaustion (moderate); dependency upgrades not silently applied. Desktop data-at-rest encryption limitation remains. New lifecycle security repairs: explicit owner/user writes, aggregate child-parent binding, deletion conflict recovery, safe custom collection migration, referenced-file protection and fresh authorization/host gate on removal.

Remote-control consent/native capture binding, meeting leases/epoch fencing, OPAQUE/TLS pinning, recipient receipt authentication and Android opt-in foreground behavior are retained; regressions must pass before their preservation is declared verified. iOS suspension still cannot promise continuous LAN listening. No internet relay/push/TURN changes.

## Acceptance gaps

Every discoverable workflow is not yet demonstrated complete on four native platforms. Mobile tapes, rich reference/attachment editing, complete legacy editing-race handling, complete landscape/back-navigation draft protection and physical OS permission/router/media tests remain unresolved. This phase is not public-release or BTC-2G packaging approval. See [matrix](BTC_2E_FEATURE_MATRIX.md), [audit](BTC_2E_AUDIT.md), [lifecycle](BTC_2E_CONTENT_LIFECYCLE.md).

## Next hardware verification

Use disposable test accounts: repeated second-member approvals during hosting/teardown and Wi-Fi roaming; every repaired management action/cancel/error/restart on Mac/Windows/Android/iPhone; link personal devices, edit offline/delete concurrently, reconnect and explicitly recover once; verify no spontaneous resurrection or unrelated-file loss. Test current/next class at a boundary/clock change; phone keyboards/safe areas/landscape; real camera/microphone/screens, grant/revoke/emergency stop and permissions; background/locked message and notification delivery. Physical iPhone provisioning remains a separate Apple signing gate.

Source implementation checkpoint: `e9517f78dc698c64bd9f8e6b1c969f0123fe5e6e`. Intermediate full Mac Electron: **42 PASS, 2 FAIL, 2 existing SKIPPED** (455.70 s); wrong-code feedback exceeded its existing 10s expectation and a hidden management title preceded the visible Campus title. Both were repaired without changing test limits/assertions. Targeted rerun: **8 PASS** (join, Astra/GPU/layout, six chat tests); new expanded content fixture first failed because Electron prompt renaming did not work. Real modal replacement then passed the complete lifecycle test (**1 PASS**, 9.70 s), including owned board/lecture controls. Final complete regressions remain pending below.

Native intermediate results: Android standalone QA Gradle build PASS (1037 tasks, 56 s then 28 s incremental); emulator update installed with `-r`, no profile clearing. First Android UI fixture failed on `Cancel` vs actual Android `CANCEL`; live accessibility dump confirmed the named confirmation. Driver corrected, same cancel/delete assertions retained. iOS actual Xcode simulator build PASS; **3 XCTest executed: 2 PASS, 1 FAIL** (116.06 s). Course creation failed the unchanged Add Course hittability assertion while the keyboard obscured the button; Notes/restart and Timetable/restart passed. Shared native ScrollView keyboard insets/drag dismissal were repaired; repeat native results follow.

Follow-up evidence: four-project typecheck PASS; final lifecycle/sync/boundaries/Study/recordings targeted **50 PASS**. iOS keyboard-fix repeat **3 PASS, 0 FAIL** (99.725 s): Course edit/archive/restore/cancel/confirmed delete/restart, Notes/restart, Timetable/restart. Subsequent final native builds: Android Gradle PASS (1037 tasks, 27 s); Xcode build-for-testing PASS. Simulator/emulator evidence never means physical hardware PASS.

Initial Windows/Linux CI run [38383888710](https://github.com/ashar-codes/CLAN/actions/runs/38383888710), application checkpoint `e9517f7`: each platform **517 unit/integration PASS, 1 SKIPPED** (Mac-only native input check); typecheck/build PASS. Windows Electron **20 PASS, 2 FAIL**: direct-message visibility and pagination anchor shift. Those are retained failures, with follow-up fixes and rerun recorded below. Linux did not run Electron.

Follow-up application checkpoint: `3aae5b927f6d116d0976769f373852dd839c63bd`. Local full unit/integration immediately before the recording-cleanup follow-up: **518 PASS** (71 files, 393.00 s); post-follow-up lifecycle/cleanup/authenticated sync: **42 PASS** (6.21 s). Six unchanged chat tests after renderer fixes: **6 PASS** (67.58 s). Earlier iOS final-layout repeat: **3 PASS** (112.175 s). Final checkpoint native compilation: Gradle QA **PASS** (1037 tasks, 39 s), Xcode simulator build-for-testing **PASS**. New checkpoint CI [38387121093](https://github.com/ashar-codes/CLAN/actions/runs/38387121093) and frozen-source full regressions pending exact outcomes below.

Recording cleanup now also preserves referenced timeline/media files when a CLAN copy is removed; actual stored-byte verification and reopened cleanup journal are asserted. One extended fixture initially expected the old two-object journal despite adding a third protected file; corrected to assert all three objects and preserved bytes. Android remains pending until the complete unchanged lifecycle assertions pass; intermediate driver failures are not counted as successes.

Android checkpoint `3aae5b9` actual emulator UI: **PASS** (`/tmp/clan-btc2e-android-source3aae-ui.log`). The driver exercised exact typed fields, Course edit/archive/restore, canceled/confirmed named deletion, Note editor/restart/persistence and canceled/confirmed deletion. No emulator profile clearing; physical **NOT TESTED**. Prior native-driver failures are retained in `/tmp/clan-btc2e-android-*.log`: Android alert capitalization, clipped fixed navigation, edge-gesture scrolling and the buried new-course form. Corrected scroll bounds/gesture location and actual Course search/top creation UI; no deletion/cancel/persistence assertions removed.

iOS checkpoint `3aae5b9`: native Xcode simulator compilation **PASS**, **3 XCTest PASS, 0 FAIL** (119.191 s): Course lifecycle/cancel/delete/restart, Note creation/restart, Timetable creation/active selection/restart. Evidence `/tmp/clan-btc2e-ios-source3aae-ui.log`; simulator xcresult in cached derived data. Physical iPhone **NOT TESTED**, no signed IPA/provisioning claim. Earlier keyboard failure remains documented above; three complete simulator runs passed after repair.

Frozen application source `3aae5b9`: **518 unit/integration PASS**, 71 files (384.90 s); **44 Mac Electron PASS, 0 FAIL, 2 existing SKIPPED**, 27 files (415.23 s). Existing skips are PERF-gated world-performance tests, not hidden functional failures. Two isolated chat repeats: **6 PASS** (67.58 s) and **6 PASS** (60.39 s). Full suite and repeats use unchanged approval/position assertions. Historical second-member approval failure still has no proven reproduction/root cause; discovery race repaired independently.

Checkpoint `3aae5b9` CI: Linux **517 PASS, 1 Mac-native SKIPPED**; Windows also **517 test PASS, 1 SKIPPED**, but suite teardown **FAIL** because restarted `member.db` remained open and Windows refused temporary-directory removal (EPERM). Windows Electron **21 PASS, 1 FAIL**: pagination moves anchor 415.5 px; direct-message failure no longer reproduced. Test-only follow-up `f18bbfca905235f6777136cc92c3a4e75c53f573` registers the restarted DB for existing afterEach close and prints bounded non-content geometry only on pagination failure. Actual application source is unchanged from `3aae5b9`. Local chat domain **13 PASS** (13.20 s), four-project typecheck PASS; follow-up CI [38388997520](https://github.com/ashar-codes/CLAN/actions/runs/38388997520) pending final outcome.

Controlled small-viewport reproduction: Mac 1024×768 pagination fixture **1 PASS**, 5 tests outside the targeted selection not run (9.67 s), exact same <3 px position assertion. This does not reproduce the Windows failure; viewport size alone is not a proven cause. A temporary test-only viewport override was used and then removed; the committed assertion is unchanged. Failure diagnostics contain bounded scroll geometry, never message content or keys.

Follow-up CI `f18bbfc` [38388997520](https://github.com/ashar-codes/CLAN/actions/runs/38388997520): Linux and Windows each **517 unit/integration PASS, 1 Mac-only SKIPPED**, no teardown failure. Windows native helper/typecheck/desktop build PASS. Windows Electron again **21 PASS, 1 FAIL**; bounded failure geometry: beforeY 781.90625, shift -415.5, log top 310.15625, scrollTop 640, clientHeight 231, total 4313, 59 messages, fonts loaded. The old fixture measured before Playwright brought the page-level control into view.

Test checkpoint `32ecd35aa674069e0bb4163f7c9a94ac4c97fde5`: bring Load Earlier into view before measuring, then additionally assert the anchor is within the viewport. Original same-message, count, identity and <3 px position assertions are unchanged. Mac six-test chat repeat **6 PASS** (60.99 s). No timeout increase. Application source remains exactly `3aae5b9`; only test setup changed. CI [38391018817](https://github.com/ashar-codes/CLAN/actions/runs/38391018817) verifies this stronger precondition on Windows; final outcome below.

Final application follow-up checkpoint `4bb9b70a399ca412ac920bc45d5b3fa89fd1228c`: fixed card/tape local search retention and tape timeline indexing after signed personal sync. Four-project typecheck PASS; lifecycle/recordings/Study/sync **47 PASS** (6.43 s), including new local and authenticated two-device search-deletion regressions. Final native/full checks and CI [38392002091](https://github.com/ashar-codes/CLAN/actions/runs/38392002091) recorded below when complete.

Viewport-precondition follow-up CI `32ecd35` [38391018817](https://github.com/ashar-codes/CLAN/actions/runs/38391018817): **Windows/Linux SUCCESS**, each **517 unit/integration PASS, 1 Mac-only SKIPPED**; Windows **22 Electron PASS** across eight selected files. The added visibility checks and original <3 px assertion passed. The prior 415.5 px shift came from measuring before the page was brought into view; it is not claimed as a proven production pagination bug. Teardown EPERM is also resolved on Windows. All prior failures remain above.

Final checkpoint `4bb9b70` Android native Gradle compilation **PASS** (1037 tasks, 14 s), emulator lifecycle UI **PASS** (`/tmp/clan-btc2e-source4bb-android-ui.log`). Xcode native simulator compilation **PASS**; current final simulator/full software outcomes follow.

Final `4bb9b70` local unit/integration: **520 PASS**, 71 files (418.44 s). Final iOS simulator: **3 XCTest PASS, 0 FAIL** (171.593 s), actual native compiled bundle and unchanged Course/Note/Timetable persistence assertions; `/tmp/clan-btc2e-source4bb-ios-ui.log`. No physical permission/camera/phone/signing result inferred.

## Final checkpoint outcome

Application `4bb9b70a399ca412ac920bc45d5b3fa89fd1228c`, final CI [38392002091](https://github.com/ashar-codes/CLAN/actions/runs/38392002091): both jobs SUCCESS. Windows/Linux each **519 unit/integration PASS, 1 Mac-native SKIPPED** (520 total); Windows **22 Electron PASS** across eight files. Windows native input helper, desktop build and four-project typecheck PASS. Linux Electron **NOT TESTED**. Full Windows physical hardware and exhaustive 27-file Windows Electron coverage are **NOT TESTED**.

Local final Mac: **520 unit/integration PASS** and **44 Electron PASS, 0 FAIL, 2 existing PERF SKIPPED** (424.05 s). Android standalone QA build + emulator lifecycle UI **PASS**; iOS native simulator build + **3 XCTest PASS**. Full unit/integration includes networking, host fencing/handover, authenticated messaging/files, media, remote-control policy, timetable, privacy and signed sync regressions. Electron media fixtures use virtual camera/audio and real local SFU/frame transport; hardware capture/revocation is **NOT TESTED**.

No current software check remains failing. Feature-completeness acceptance and BTC-2G packaging readiness remain **BLOCKED**: mobile study tapes, complete rich-reference/configuration management, all legacy online editing races, exhaustive native small-screen/landscape/back/draft coverage and hardware/signing/security gates remain unfinished. The exact historical Mac approval timeout was not reproduced; separate late-discovery/stale-hint defects were fixed and tested without asserting that historical causality is proven.

Protected BTC-1 Desktop packages remain present (Windows 166236080 B, macOS 163388667 B, Android 65874733 B, iOS Xcode 1122119035 B); `/Applications/CLAN TEST.app` remains intact. Native QA installs were limited to disposable emulator/simulator apps; protected packages and the Applications app were not replaced. PRs #1–#4 remain OPEN/DRAFT/unmerged. Redacted implementation-history and staged-document scans are recorded outside Git; no sensitive logs or binaries are committed.

Free disk after final verification: **10.48 GiB** (2026-10-13). Native caches and BTC-1 installer backups retained; no unrelated cleanup performed.

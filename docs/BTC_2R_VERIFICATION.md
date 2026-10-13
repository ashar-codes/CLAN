# BTC-2R verification

Branch `btc-2r-always-reachable`, baseline `7db61c7`. Software/physical completion remains **BLOCKED** pending recorded final results and unavailable cross-device acceptance. No BTC-1 package, active installed app, user profile/key or draft PR replaced.

Initial focused real TCP idle-friend/privacy/blocking and Bonjour update regressions: **10 PASS**, repeated **10 PASS** (12.16 s). Initial four-project typecheck exposed missing diagnostic import; repaired, subsequent typechecks PASS. Initial full unit/integration **522 PASS**, 72 files (396.01 s); source changed during execution, so final frozen-source repetition is required.

Android native Gradle standalone QA builds PASS (49 s, 44 s). First new emulator background driver **FAIL** before pairing: emulator disappeared during UI navigation; no background success inferred. Disposable AVD restarted without wiping its data. Final source/native/background verification pending. Emulator reduced-motion setting is used for deterministic UI automation; hardware animations and OEM policies remain separately unverified.

Final native iOS cached simulator build-for-testing PASS; source was mirrored during the initial build after a relative-path invocation failed. A clean incremental build after mirror completion is required before final-source claims. No physical provisioning/IPA.

Inherited advisories: two high/two moderate, desktop data-at-rest encryption limitation. No new internet push/relay/TURN infrastructure. Real physical Windows↔Mac, Xiaomi background/locked calls, multi-router and Apple provisioning remain NOT TESTED. SFU media/remote consent regressions must pass; synthetic SDP invitation fixture tests notification/ringing only, never real audio/video media.

## Intermediate expanded regressions

- Frozen initial application repeat: **522 unit/integration PASS**, 72 files, 386.64 s. Subsequent native lifecycle tests **2 PASS**, expanded auth/discovery/lifecycle target **12 PASS** (20.52 s).
- Complete Mac Electron: **45 PASS, 0 FAIL, 2 existing PERF SKIPPED**, 28 files, 549.22 s. This precedes the final automatic-dial consent fence; final frozen repetition is required.
- Initial Windows full Electron CI [38397398189](https://github.com/ashar-codes/CLAN/actions/runs/38397398189): **42 PASS, 3 FAIL, 2 existing SKIPPED**, 639.05 s. Failures: canvas removal snapshots, crash-test EPERM releasing WAL, first meeting join approval timeout (25 s). Linux passed. Do not replace these failures with the prior selected-suite passes. Rendering completion and Windows handle-release preconditions repaired in fixtures without weakening pixel/data assertions. Bounded join failure diagnostics added; historical causality remains unresolved. Three affected Mac Electron fixtures **3 PASS** (33.78 s).
- iOS simulator native XCTest: **3 PASS, 1 FAIL** (183.073 s test time): new foreground/resume limitation display, Note/restart, Timetable/restart passed. Course Add button was not hittable under keyboard; driver now explicitly dismisses the keyboard through the real New Course title before checking the same hittability assertion. Native repeat required.
- Android driver failures before authenticated pairing are retained in local logs. Causes observed: emulator shutdown, animation/accessibility idle, scroll edge/extent, shell-truncated QR query, input capitalization, controlled-field rapid typing and keyboard-dependent positioning. Exact code content assertion remains. User-facing secure manual connection is now near the top of Nearby. No failed driver is counted as a successful background test.

Follow-up security: automatic idle dials recheck opt-in/Invisible after handshake, before session adoption. An in-flight consent withdrawal regression passes; explicit QR/manual intent is separate. Native Wi-Fi callback detects local network changes even when Android selects cellular as its default route. Notifications' explicit Enable action now also enables the direct-alert preference after OS consent; previously it could report enabled while that preference remained off.

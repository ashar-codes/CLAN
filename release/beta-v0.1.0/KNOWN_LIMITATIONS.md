# CLAN v0.1.0 beta — known limitations

**What has actually been run** (details: `docs/BETA_READINESS.md`, `design/beta/`):

| Artifact | Status |
|---|---|
| macOS arm64 DMG | BUILT · INSTALLED and TESTED on one Mac (packaged install → update → rollback → uninstall, disposable profiles; the 22 desktop E2E tests run against the same build in development Electron, not the packaged app) · not tested on another Mac, a clean macOS user, or after a real download (Gatekeeper quarantine) |
| Windows x64 installer | BUILT on macOS · **UNVERIFIED**: never installed or run on Windows |
| Android arm64 APK | BUILT · INSTALLED and TESTED on the Android 16 emulator only · no physical phone. Final APK: install → upgrade PASS, reliability PASS, cross-device 2 clean passes in 10 runs (3 test-harness port collisions — fixed; 1 run during host overload with system-wide ANRs; 3 runs where the phone's whiteboard text did not reach the host in time — **cause not found**; 1 automation scroll miss). See `design/beta/v0.1.0/` |
| iOS | NOT BUILT (no Xcode / Apple Developer team on the build machine) |

## Platform
* No physical phone, no Windows PC and no real classroom Wi-Fi has run this build. Expect first-device fixes.
* macOS: unsigned/ad-hoc → manual "Open Anyway"; after an update macOS may ask about keychain access (deny = new device
  identity, re-approval by teachers and linked devices). A Developer ID build removes both.
* Windows: unsigned → SmartScreen warning; CLAN.exe shows the default Electron icon/version details (resource editing
  needs Windows). Firewall rules, DPAPI keys, mDNS discovery, Direct Network helper and screen sharing are untested there.
* Android: emulator-only; Direct Network (Wi-Fi Direct / BLE), camera, notifications and low-memory behaviour unverified
  on hardware. Uninstall deletes phone data (no OS backup, by design).
* iOS: no build in this beta.
* Default app icon on all platforms.

## Product
* Networks with client isolation (many guest/public Wi-Fi networks) can't run CLAN.
* A desktop rollback after a database migration needs a manual restore of the pre-update backup (Me › Your data).
* A changed laptop IP during a class needs the class to be hosted again.
* Classroom certificates last 24 h; a longer class ends automatically.
* Opening Study in Full mode spends ~0.8 s on the 3D campus; Reduced/Minimal never load it.
* Phone uploads restart from byte 0 on retry (still never duplicated).
* Screen sharing from phones is not supported (phones can view).

## Privacy
* No telemetry, no accounts, no cloud. Feedback and diagnostics are files you save and send yourself; diagnostics are
  opt-in and contain versions, counts and error kinds only.
* The desktop database is not encrypted on disk (it relies on your OS account); keys are protected by the OS keychain/DPAPI.

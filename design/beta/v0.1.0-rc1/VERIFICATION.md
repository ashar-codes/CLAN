# RC1 software verification (2026-10-10)

Candidate: `clan-beta-v0.1.0-rc1` worktree, Android 16 arm64 Pixel emulator, macOS arm64 build host. Commands were run serially; no physical phone, Windows machine, classroom Wi-Fi or iOS device was used. The host was often busy: recorded 1-minute load averages were 7.15→13.87 for desktop E2E, 13.24→5.52 for the earlier full unit run, and 2.75–33.15 across nine logged Android cross-device starts/ends. No test timeout was raised to obtain a pass.

| Gate | Result | Evidence and limits |
|---|---|---|
| Typecheck | PASS | All four TypeScript projects, final tree |
| Full unit | PASS | 35 files, 324 tests, final serial run 235 s; two earlier all-passing runs also completed after file-handle cleanup |
| Desktop E2E | PASS | 22 active cases in 271 s; two opt-in performance cases skipped |
| Android cross-device | PASS | 10 consecutive full final-APK runs, each local whiteboard text, host persisted operation and transferred file hash; runs 2–10 in `/tmp/clan-rc1-xd2.log` … `xd10.log`. The first passing run's terminal result was captured during execution (text suffix `128be484`, hashed op marker `c7b3c8c0d66d`); its log filename was reused by run 2. |
| Android reliability | PASS | Crash recovery, offline notes, host freeze, network interruption, leave/rejoin, camera denial and unreadable database recovery; `/tmp/clan-rc1-reliability.log` |
| Android beta→RC update | PASS | versionCode 1→2; profile, notes, encrypted Diary, device identity and signed pinned-certificate sync survived; `/tmp/clan-rc1-upgrade.log`. Different-signing-key rejection was not run because no disposable alternate-key APK was available. |
| macOS packaged update/rollback | PASS | Previous beta→RC→previous beta; note and three identity keys preserved; `/tmp/clan-rc1-install-mac.log` |
| Artifact integrity | PASS | All three SHA-256 manifest entries match; `hdiutil verify` confirms DMG checksum |
| Windows installer runtime, physical Android, classroom LAN, Direct Mode, iOS | NOT TESTED | Hardware and credentials unavailable; follow [RC1 hardware gates](../../../docs/RC1_HARDWARE_GATES.md) |

The first instrumented run on the earlier candidate **failed** local whiteboard text input because the keyboard covered the Add button; the [screenshot](whiteboard-input-failure.png) and [investigation](../../../docs/WHITEBOARD_RELIABILITY_RC1.md) show the cause and fix. An initial desktop E2E had a recovery-window race, and an initial full unit run exited nonzero on unclosed file handles after 324 passing assertions. Both causes were fixed and their full gates rerun successfully. A preliminary reliability invocation failed setup before testing because `adbd` was not running as root; `adb root` corrected that prerequisite. These failures are retained as investigation evidence rather than counted as passing runs.

Android signing continuity and bundle audits passed, but the upload-key backup has not been completed. The Windows cross-build is unsigned and unexecuted on Windows; the Mac DMG is ad-hoc signed and unnotarized. **Distribution recommendation: HOLD** until the relevant hardware, installer trust and signing backup gates are recorded as passed. Candidate artifacts remain local and git-ignored.

# CLAN 0.1.0 RC1 candidate — internal only

Built from the isolated `clan-astra-phase12` worktree after beta tag `clan-beta-v0.1.0`. Installers are local,
git-ignored files; `SHA256SUMS` is relative to this directory. Do **not** distribute this RC automatically.

| Candidate | SHA-256 | Packaging status |
|---|---|---|
| `CLAN-0.1.0-rc1-arm64.dmg` | `974ae68f1cf18d235517391bff6cc81f718296220851aee290f814e870dc781f` | Built on macOS arm64, ad-hoc signed, unnotarized |
| `CLAN Setup 0.1.0-rc1.exe` | `1adcc0fac96af9bbe191dcb7c070bd51865144c8977c9b8ae37ba9fff42678d8` | Cross-built on macOS x64, unsigned |
| `CLAN-0.1.0-rc1-android-arm64.apk` | `b9632cb72ad804fb8f7326a6954a70886246e962abbdd2f2e251bccdec438e2b` | versionCode 2, same beta upload certificate |

## Verification status

| Gate | Result | Evidence |
|---|---|---|
| Typecheck | PASS | All four TypeScript projects |
| Full unit | PASS | 324/324, 35 files, serial; final run 268 s |
| Desktop E2E | PASS | 22/22 active; two opt-in performance cases skipped; final run 271 s |
| macOS packaged install/update/rollback | PASS | Previous beta → RC (both report 0.1.0); note and three identity keys kept; uninstall kept profile |
| macOS and Windows bundle audit | PASS | No keys, env files, source maps, test suites or dev URL; platform Skia modules only |
| Android signing/version audit | PASS | cert SHA-256 `9803dcd4a46b8f23768e27232f47ce0630d20bd09472131cc179606fbfc9a60b`, versionCode 2 |
| Android cross-device, ten consecutive | PASS | Ten consecutive full runs on the final RC APK; each verified local text commit, host persistence and file hash. Earlier instrumented run on the prior APK reproduced a keyboard-covered Add button and is documented separately. |
| Android reliability | PASS | Crash/relaunch, offline notes, host freeze, network loss, rejoin, camera denial and unreadable database recovery on Android emulator |
| Android old → RC update | PASS | versionCode 1 → 2; profile, notes, encrypted Diary, device identity, pinned-certificate signed sync and bidirectional data survived |
| Windows 10/11, physical Android, DMG on another Mac, two-device Wi-Fi, Direct Mode, iOS | NOT TESTED | See [hardware gates](../../docs/RC1_HARDWARE_GATES.md) |

The first Android failure is documented in [whiteboard reliability](../../docs/WHITEBOARD_RELIABILITY_RC1.md).
The [RC1 verification record](../../design/beta/v0.1.0-rc1/VERIFICATION.md) records actual runs, initial failures,
skips and machine load.
The **blocking** items for student distribution are physical Android/classroom Wi-Fi,
Windows installer execution/signing plan, and offline backup of the Android upload key. macOS Gatekeeper/notarization,
iOS prerequisites and unverified Direct Mode remain platform-specific blockers where those platforms are offered.
The undecided CLAN icon is a **non-blocking visual limitation** for this stabilization RC.

**Recommendation: HOLD distribution** until the relevant hardware/signing gates are complete.
Use the existing [student](../beta-v0.1.0/STUDENT_CHECKLIST.md) and [teacher](../beta-v0.1.0/TEACHER_CHECKLIST.md)
instructions with [RC hardware steps](../../docs/RC1_HARDWARE_GATES.md). Android key backup requires the owner's
approved offline destination and restore check; see [backup procedure](../../docs/ANDROID_SIGNING_BACKUP.md).

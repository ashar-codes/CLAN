# BTC-2 Stage 0 — disk cleanup record

Date: 2026-10-12. Branch qa/phase-14.3-local; commit fd33b95e3793c26de49c05ec8b0b835356e52fa6. Initial Git index/worktree clean. Current BTC-1 packages use application e73cd174f70716c8e914c8e8452030b7550f7f37. No features implemented, packages rebuilt, commits made, draft PRs merged, tools uninstalled or security settings changed.

## Disk measurements

Initial audit: 4,451,796 KiB free (4.559 GB). macOS/APFS reported additional free space during read-only auditing, before deletion; this is not attributed to cleanup. Immediately before deletion: 6,284,013,568 bytes (6.284 GB). After cleanup: 9,251,831,808 bytes (9.252 GB). **Measured increase during cleanup: 2.968 GB (2.764 GiB).**

Sizes below are pre-removal du estimates or file sizes. APFS shared extents make summed directory sizes exceed the actual space reclaimed; do not add overlapping inventory totals.

## Size-ranked removed inventory

All paths are under /Users/ashar/clan-143-local-qa/Installable Files. Every target was checked for active use, tracked content and symlink roots before targeted deletion; no broad cleanup command was used.

| Path relative to Installable Files | Pre-cleanup GB | Verification/reason |
| --- | ---: | --- |
| `iOS/Xcode-3cf53ad` | 2.662 | Redundant older extracted Xcode project; all 72682 files/symlinks byte-verified against retained ZIP; final Xcode-e73cd17 preserved |
| `iOS/Xcode-6f7d946` | 2.662 | Redundant older extracted Xcode project; all 72672 files/symlinks byte-verified against retained ZIP; final Xcode-e73cd17 preserved |
| `iOS/Xcode-f8cc8f7` | 2.662 | Redundant older extracted Xcode project; all 72671 files/symlinks byte-verified against retained ZIP; final Xcode-e73cd17 preserved |
| `iOS/CLAN-0.1.0-TEST-UNVERIFIED-3cf53ad-Xcode.zip` | 1.122 | Byte-identical redundant pre-final installer; most recent known-good installer backup preserved |
| `Windows/.download-e73cd17` | 0.333 | Completed CI ZIP and numbered download chunks; all archive contents match retained extracted CI evidence |
| `Windows/.download-3cf53ad` | 0.333 | Completed CI ZIP and numbered download chunks; all archive contents match retained extracted CI evidence |
| `Windows/.download-6f7d946` | 0.333 | Completed CI ZIP and numbered download chunks; all archive contents match retained extracted CI evidence |
| `Windows/.download-f8cc8f7` | 0.333 | Completed CI ZIP and numbered download chunks; all archive contents match retained extracted CI evidence |
| `Windows/3cf53ad-ci-evidence/CLAN-0.1.0-TEST-UNVERIFIED-3cf53ad-x64.exe` | 0.166 | Byte-identical redundant pre-final installer; most recent known-good installer backup preserved |
| `macOS/CLAN-0.1.0-TEST-UNVERIFIED-3cf53ad-BTC1-arm64.dmg` | 0.163 | Byte-identical redundant pre-final installer; most recent known-good installer backup preserved |
| `Android/CLAN-0.1.0-TEST-UNVERIFIED-3cf53ad-BTC1-arm64.apk` | 0.066 | Byte-identical redundant pre-final installer; most recent known-good installer backup preserved |

Older extracted Xcode copies had 72,682 / 72,672 / 72,671 files or symlinks byte-compared with their retained archives. Embedded Xcode XCBuildData/build.db was identified as compiler metadata, not personal data. No signing keys, certificates, provisioning files or personal database paths were selected. Final Xcode-e73cd17 has no symlink or checked project-configuration dependencies on the obsolete extraction paths.

Each obsolete 3cf53ad installer was SHA-256-identical to its protected copy in BTC-1-pre-e73cd17-backup. Mapping:

- `iOS/CLAN-0.1.0-TEST-UNVERIFIED-3cf53ad-Xcode.zip` → `BTC-1-pre-e73cd17-backup/iOS/CLAN-iOS-Xcode.zip`; SHA-256 `14fe46172f66ea7757681a8ff1371f8a9e8b11c017f6aa40a9bff7f1dcee4ac6`.
- `Windows/3cf53ad-ci-evidence/CLAN-0.1.0-TEST-UNVERIFIED-3cf53ad-x64.exe` → `BTC-1-pre-e73cd17-backup/Windows/CLAN-Windows.exe`; SHA-256 `038ddee797d7b46e9c70345d68e107bde177eb1beb3606e846b48e665e2b6678`.
- `macOS/CLAN-0.1.0-TEST-UNVERIFIED-3cf53ad-BTC1-arm64.dmg` → `BTC-1-pre-e73cd17-backup/macOS/CLAN-macOS.dmg`; SHA-256 `90a771224fa8cb313ddaf68460912db079846b05e9702ef7206397452689656b`.
- `Android/CLAN-0.1.0-TEST-UNVERIFIED-3cf53ad-BTC1-arm64.apk` → `BTC-1-pre-e73cd17-backup/Android/CLAN-Android.apk`; SHA-256 `e46f98894533d5adebd2b2b4f51d70e565da590633a40bf51fc85fcc839810f2`.

## Retained inventory and protections

| Item | Approximate pre-cleanup GB | Decision |
| --- | ---: | --- |
| QA worktree, 28.234 GB including outputs | 28.234 | All tracked source, Git metadata and branches retained; only listed ignored artifact paths removed |
| ~/.android/avd (three CLAN AVDs) | 12.834 | Retain images, snapshots and userdata; profiles/identities may exist and emulators are useful for BTC-2 |
| ~/clan-143-ios-qa | 9.043 | Retain native project, dependencies, simulator/device build products and expensive reusable caches |
| ~/.gradle | 6.006 | Retain dependency downloads, transforms, wrapper and caches; Gradle daemons exist |
| ~/clan-build | 3.951 | Separate source/Git checkout retained |
| ~/clan-astra-phase12 | 3.537 | Original worktree retained |
| ~/clan-ios-build | 3.259 | Native/source folder retained; ownership/use uncertain |
| QA node_modules | 3.002 | Retain dependencies |
| Installable Files/iOS/Xcode-e73cd17 | 2.662 | Retain ready-to-use final iPhone Xcode project/Pods/dependencies |
| BTC-1-backups-20261012-212628 | 1.961 | Retain earlier known-good installers and app backup |
| BTC-1-pre-e73cd17-backup | 1.518 | Retain most recent known-good four installer backups and guide |
| CocoaPods cache | 1.165 | Retain to avoid downloads/rebuild overhead |
| Android app build | 0.903 | Retain Gradle incremental outputs and current standalone APK |
| Desktop release | 0.571 | Retain final packaged app/DMG and packaging evidence |
| ~/clan-143-ios-derived | 0.474 | Retain native products/test evidence; previously removed intermediates not recreated |
| CLAN temporary logs | 0.085 | Retain inexpensive test/audit evidence; active/uncertain logs not deleted |

All three original Git worktrees remain. All four Desktop installers, their final source originals, installation guide, current installed /Applications/CLAN TEST.app, previous Applications app backups, Media-entitlement-backup, profiles/chats/files/keys, disposable QA profiles and signing/Keychain/Keystore material remain untouched. Android SDK, Xcode, Java, pnpm and native helper binaries retained.

Uncertain items retained for later review/approval: /private/tmp/clan-beta-old.app (~0.407 GB; may be an app backup), Installable Files/macOS/QA-Electron-Runtime (~0.301 GB; may support future runtime tests), unique older installer/simulator ZIPs, and completed native caches in ~/clan-143-ios-qa whose BTC-2 reuse is uncertain. No approval was inferred for these. Source checkouts and emulator userdata are protected, not proposed deletion targets.

## Verification

- Four current Desktop installers and all four final source originals are nonempty and retain their recorded SHA-256 hashes.
- Most recent known-good installer backup hashes match all four removed redundant packages.
- Installed app executable/app.asar hashes unchanged; strict deep codesign verification passes.
- Git HEAD/branch unchanged; tracked files and index unchanged. Only the requested BTC_2_PLAN.md and this cleanup record are newly untracked documentation.
- Four-project TypeScript typecheck passes before and after cleanup. No installer build or functional feature test was run or claimed.

See [BTC_2_PLAN.md](BTC_2_PLAN.md) for the five planned BTC-2 stages. Stage 0 stops here.

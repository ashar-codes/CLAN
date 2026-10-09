# Closed-beta readiness (Phase 13, tag `clan-beta-hardening`)

What has been **run**, what has **not**, and what blocks a closed beta per platform. Evidence is in
[`design/beta/`](../design/beta). Nothing below is claimed for hardware or platforms it was not run on.

## Platform status

| Platform | Built here | Run here | Automated evidence | Not verified |
|---|---|---|---|---|
| macOS arm64 (desktop) | yes (`dist:dir`, unsigned, ad-hoc) | yes | 321 unit, 22 desktop E2E ×3, packaged install → update → rollback → uninstall | Developer ID signing, notarization, dmg install, Intel Macs, BLE helper (not built in this checkout) |
| Windows (desktop) | no | no | none on Windows (Direct helper is mocked) | everything: build, install, firewall, Wi-Fi Direct helper, SmartScreen |
| Linux (desktop) | no | no | none | everything |
| Android | yes (release APK, arm64) | emulator only (Android 16, Pixel profile) | cross-device suite ×3, reliability suite ×3, board/startup benchmarks | any physical phone, other Android versions/vendors, battery, real Wi-Fi/BLE, Play signing |
| iOS | no (no Xcode / Apple team) | no | trust code on macOS only | everything |

## Release blockers (highest first)

**All platforms**
1. No physical-device testing on any phone or on a classroom Wi-Fi network. This blocks claiming anything about real-world joining, media, or performance.
2. No signing identity for any platform (see Signing). Unsigned builds can't be updated safely by end users.

**macOS**
3. Developer ID signing + notarization not configured. Unsigned (ad-hoc) builds are blocked by Gatekeeper on download, and the Keychain/safeStorage identity changes with every re-sign. That means re-approval as a new device, and AI keys can't be decrypted.
4. `native/macos-ble/clan-ble` must be built before packaging (`electron-builder` skips it silently when absent → no Direct over BLE).

**Windows**
5. Never built or run on Windows: NSIS installer, `CLAN.DirectHelper.exe`, LiveKit `win32` binary, firewall rules, `safeStorage` (DPAPI), mDNS and paths are all untested.

**Android**
6. Release APK is signed with the **debug keystore** (Expo prebuild default). Needs an upload key + Play App Signing. A
   key change makes updates impossible (users would have to uninstall → phone data is lost, see Data below).
7. `versionCode` is not set (defaults to 1). Every update must increase it.
8. Only the emulator: real Wi-Fi Direct / BLE / camera / notifications / low-memory behaviour unverified.

**iOS**
9. Not built. Share extension, Local Network permission, Keychain, SQLCipher, LiveKit and the OPAQUE WebView are all
   unverified on iOS.

## Reproducible builds

```sh
pnpm install --frozen-lockfile          # Node 24, pnpm 11 (packageManager pinned)
pnpm typecheck && pnpm test             # 321 unit tests
pnpm test:e2e                           # builds desktop, 22 E2E (+2 PERF-only, skipped unless PERF=1)
pnpm --filter @classroom/desktop dist:dir   # unpacked app, ad-hoc signed on macOS (release/mac-arm64/CLAN.app)
pnpm dist:desktop                       # installers; needs signing configured (below)
apps/mobile/scripts/android-dev.sh --prebuild --release   # Android release APK, installs on the running emulator
```

`native/livekit/fetch.sh` (LiveKit SFU) and `native/macos-ble` must be built first; both are git-ignored binaries.

## Versioning

One version for the beta across apps: `apps/desktop/package.json`, `apps/mobile/package.json` and `apps/mobile/app.json`
(`expo.version`), semver `0.MINOR.PATCH`. Android additionally needs `expo.android.versionCode` (integer, +1 per build) and
iOS `expo.ios.buildNumber`. Database changes are forward-only migrations (`packages/server/src/db.ts` `MIGRATIONS`).
`clan-beta-feedback/v1` and `clan-personal-export/v1` are versioned formats.

## Signing (instructions; none configured here)

* **macOS:** a Developer ID Application certificate in the keychain → `pnpm dist:desktop` signs automatically (hardened
  runtime). Notarize with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` set (electron-builder `notarize`).
  Electron fuses are flipped **before** signing (`electronFuses` in `electron-builder.yml`); an unsigned build must be
  at least ad-hoc signed (`-c.mac.identity=-`) or Apple Silicon kills it at launch.
* **Windows:** an Authenticode certificate (`CSC_LINK`/`CSC_KEY_PASSWORD`, or a cloud HSM signer); build on Windows.
* **Android:** create an upload keystore, reference it from `android/app/build.gradle` `signingConfigs.release` via
  `~/.gradle/gradle.properties` (never commit it), enrol in Play App Signing. Keep the key backed up offline.
* **iOS:** Apple team + provisioning in Xcode (`expo prebuild -p ios`, archive).

## Install, update, rollback, uninstall

| Step | macOS (run: `node apps/desktop/scripts/install-check.ts old.app new.app`) | Android (emulator, `adb`) |
|---|---|---|
| Install | ✓ 0.1.0 packaged, fused, ad-hoc signed | ✓ `adb install` |
| Update in place | ✓ 0.1.0 → 0.1.1, data kept | ✓ `adb install -r` kept the profile (every rebuild in this phase) |
| Rollback | ✓ 0.1.1 → 0.1.0, data kept, **same schema only** | not run (Android refuses lower versionCode without uninstall) |
| Uninstall | ✓ app removed, profile kept in `~/Library/Application Support/CLAN` | uninstall deletes app data; `allowBackup=false`, so it can only come back via device sync from a computer |

**Update strategy:** in-place updates only (same signing identity). When an update is about to migrate the desktop
database, it first copies the old one into `backups/` (tested); besides that, backups run at start and daily (newest 3,
`VACUUM INTO`, skipped when they would leave < 1 GB free). A damaged database is moved aside and the newest healthy backup
restored. **Rollback strategy:** reinstall the previous build; if the newer build migrated the database, restore the
pre-update backup (Me › Your data › Show backups) or import an export. Older builds do not open newer schemas safely and
the restore is manual — not automated.

## Privacy and feedback

Me › Beta feedback writes a JSON file the student chooses and sends themselves. Diagnostics are opt-in, previewable
("Show exactly what's attached") and contain versions, platform, counts and error kinds only — never notes, Diary, chats,
files, names, ids, credentials or log text (tested). Nothing is uploaded automatically; CLAN has no telemetry.

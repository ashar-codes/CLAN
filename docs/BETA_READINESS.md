# Closed-beta readiness

> **Phase 14.1 RC1:** see the [candidate manifest and gate matrix](../release/beta-v0.1.0-rc1/README.md),
> [whiteboard investigation](WHITEBOARD_RELIABILITY_RC1.md) and [hardware procedures](RC1_HARDWARE_GATES.md).
> This RC passes the available software gates; hardware and signing backup gates still block distribution.
> The historical Phase 13/14 assessment below is retained as a record of the previous candidate.

> **v0.1.0 closed beta (Phase 14, tag `clan-beta-v0.1.0`):** artifacts, checksums, setup guide and tester checklists are
> in `release/beta-v0.1.0/` (installers are git-ignored; text files are committed). Per-artifact status
> (BUILT / INSTALLED / TESTED / UNVERIFIED) is in `release/beta-v0.1.0/KNOWN_LIMITATIONS.md`. Resolved since Phase 13:
> Android upload-key signing + versionCode, macOS BLE helper bundled (missing helpers now fail the build), Windows
> installer built (unverified), DMG built. The sections below are the Phase 13 analysis, updated where marked.

## v0.1.0 release blockers (Phase 14, in order)
1. **Verification on an idle machine:** the final unit/E2E/cross-device runs were done while the build Mac was overloaded
   and thermally throttled; timing-bound tests timed out (the Phase 13 tag failed the same way in an A/B run). Before
   handing out installers: `pnpm test && pnpm test:e2e` and `python3 apps/mobile/e2e/android_cross_device.py` ×3 on an
   idle machine (`design/beta/v0.1.0/README.md`).
2. **Phone whiteboard text intermittently not reaching the host** in 3 emulator runs — cause not found.
3. **Physical devices:** no phone, Windows PC or classroom Wi-Fi has run v0.1.0.
4. **Windows installer unverified** (built on macOS; unsigned; firewall rules/DPAPI/Direct helper untested).
5. **macOS unsigned/ad-hoc:** Gatekeeper "Open Anyway"; possible keychain consent after updates (deny → new identity).
6. **iOS not built** (Xcode + Apple team required; handoff below).
7. Back up `~/.clan-signing/clan-beta-upload.p12` and the "CLAN Android upload key" keychain password offline.

## Phase 13 analysis (tag `clan-beta-hardening`)

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
4. ~~`clan-ble` silently omitted~~ — **resolved:** built and bundled; a missing helper now fails packaging.

**Windows**
5. Never built or run on Windows: NSIS installer, `CLAN.DirectHelper.exe`, LiveKit `win32` binary, firewall rules, `safeStorage` (DPAPI), mDNS and paths are all untested.

**Android**
6. ~~Release APK signed with the debug keystore~~ — **resolved (Phase 14):** beta upload key outside the repo, builds fail
   without it. Still open: Play App Signing if the app goes to Google Play; back up the key offline.
7. ~~`versionCode` not set~~ — **resolved:** `expo.android.versionCode` = 1 for v0.1.0, +1 per build.
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

## iOS handoff (Phase 14 audit; not built)

Blocker on this machine: only Command Line Tools (`xcode-select -p` → `/Library/Developer/CommandLineTools`), no Xcode,
no CocoaPods run, no Apple Developer team. `expo prebuild -p ios` succeeds and was audited; nothing has been compiled
for iOS (only `PinnedTrust.swift` / `DirectBle.swift` type-check against the macOS SDK), so iOS compatibility is **not**
claimed.

Generated project (audited): targets `CLAN` (`app.classroomlan.student`, iOS 16.4) and `CLANShare` (share extension,
`app.classroomlan.student.share`, iOS 15.1); both use App Group `group.app.classroomlan.student`; the app also has
`com.apple.developer.networking.HotspotConfiguration`. Version 0.1.0 / build 1 on both (the extension follows the app).
Fixed in Phase 14: vague camera/photo/microphone texts, remote-push entitlement removed, hard-coded extension version.

Prerequisites (the person with the Apple account):
1. Xcode (version required by Expo SDK 57 / RN 0.86) + `sudo xcode-select -s /Applications/Xcode.app`, CocoaPods.
2. Apple Developer Program team. In Certificates, Identifiers & Profiles: App IDs `app.classroomlan.student`
   (capabilities: App Groups, Hotspot Configuration) and `app.classroomlan.student.share` (App Groups); App Group
   `group.app.classroomlan.student`.
3. Set `expo.ios.appleTeamId` in `apps/mobile/app.json` (the share-extension plugin passes it to both targets).

Build: `cd apps/mobile && npx expo prebuild -p ios && cd ios && pod install && open CLAN.xcworkspace` → Product ›
Archive → Distribute → TestFlight. Then run the student checklist on a physical iPhone (Local Network prompt, share
extension, SQLCipher, OPAQUE WebView join, screen-share viewing). Bump `expo.ios.buildNumber` for every upload.

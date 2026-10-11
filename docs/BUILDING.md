# Building

Requirements: Node ≥ 24, pnpm 11. Runtime needs no internet; installing dependencies does.

## Desktop
* `pnpm build:desktop` — Vite builds main, preload (CJS, sandboxed) and renderer into `apps/desktop/dist`.
* `pnpm --filter @classroom/desktop dist:dir` — unpacked app (verified on macOS arm64: `release/mac-arm64/CLAN.app`, E2E passes against it).
* `pnpm dist:desktop` — installers: macOS dmg/zip, Windows NSIS, Linux AppImage (`electron-builder.yml`).
  Windows installers must be built on Windows (or CI `windows-latest`); not built on this machine. macOS builds are
  unsigned until a Developer ID is configured.
* Everything is bundled by Vite; no `node_modules` or native modules ship.

## Mobile (Expo development build — not Expo Go, react-native-zeroconf is native)
* Android: Android SDK + JDK 17, then `pnpm --filter @classroom/mobile android` (or `build:android`).
* iOS: Xcode on macOS, then `pnpm --filter @classroom/mobile ios`.
* On the current build machine the Android SDK + JDK 17 are installed (Android builds run); Xcode 26.6 and CocoaPods 1.17.0 are installed. iOS 26.5 platform support/runtime is still missing; native compilation is blocked.

## Beta release builds (v0.1.0, all from macOS arm64)
Prerequisites built once (git-ignored binaries; packaging **fails** if one is missing — `apps/desktop/build/require-helpers.cjs`):

```sh
swiftc -O -target arm64-apple-macos13 native/macos-ble/main.swift -o native/macos-ble/clan-ble   # macOS BLE helper
sh native/livekit/fetch.sh                  # darwin-arm64 SFU (Go build) — or copy the existing binary
sh native/livekit/fetch.sh win32-x64        # official Windows release, SHA-256 pinned
bash dotnet-install.sh --channel 8.0 --install-dir ~/.dotnet   # .NET 8 SDK, user-local (https://dot.net/v1/dotnet-install.sh)
~/.dotnet/dotnet publish native/windows-direct -c Release -o native/windows-direct/bin/publish
pnpm install --frozen-lockfile              # pnpm-workspace.yaml also installs win32-x64 native optional deps
```

Artifacts:

```sh
cd apps/desktop && pnpm build
npx electron-builder --mac dmg --arm64 -c.mac.identity=-                    # release/CLAN-0.1.0-arm64.dmg (ad-hoc)
npx electron-builder --win nsis --x64 -c.win.signAndEditExecutable=false    # release/CLAN Setup 0.1.0.exe (unsigned)
cd ../.. && apps/mobile/scripts/android-dev.sh --prebuild --release          # signed APK (below); NO_INSTALL=1 to skip adb
```

* **macOS signing:** with a Developer ID certificate drop `-c.mac.identity=-`; set `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization. A stable Developer ID keeps the keychain item that
  protects CLAN's keys readable across updates; ad-hoc builds get a new code identity every build.
* **Windows:** `signAndEditExecutable=false` because resource editing/signing needs Windows (or Wine). On Windows, build
  without it and with `CSC_LINK`/`CSC_KEY_PASSWORD` (Authenticode).
* **Android upload key:** `~/.clan-signing/clan-beta-upload.p12` (alias `clan-beta`, PKCS#12, RSA 4096, never in git);
  its password is in the login keychain item "CLAN Android upload key", which `android-dev.sh --release` exports to
  Gradle. `apps/mobile/plugins/withReleaseSigning.js` makes release builds use it and **fail** without it. Back the
  keystore and its password up offline: losing them means users can't update without uninstalling (and losing phone data).
  CI/other machines: set `ORG_GRADLE_PROJECT_CLAN_UPLOAD_STORE_FILE`, `…_STORE_PASSWORD`, `…_KEY_ALIAS`, `…_KEY_PASSWORD`.
* **Android versions:** `expo.version` + `expo.android.versionCode` in `apps/mobile/app.json`; +1 versionCode for every
  APK given to testers. Upgrade tests build a higher one without editing the repo: `CLAN_TEST_VERSION=0.1.1:2`.
* **iOS:** needs Xcode + CocoaPods + an Apple Developer team (see `docs/BETA_READINESS.md`).


### Isolated iOS compile (Phase 14.2)

Run `apps/mobile/scripts/ios-build.sh` on the Mac after Xcode first launch and platform-component installation.
Sources and installed dependencies are mirrored into `~/clan-ios-build`; generated iOS files/Pods stay there.
The script compiles an **unsigned simulator .app**, never an IPA. `--device-compile` checks the device SDK without
signing. Neither result is a physical-device test or an installable phone release. A genuine phone installer additionally
requires an approved Apple team/signing profile and hardware verification; do not replace existing identities.

Current evidence: `/tmp/clan-142-ios-build1.log` — Expo prebuild/codegen and CocoaPods installation PASS;
`xcodebuild` FAIL because no eligible destination exists (iOS 26.5 platform missing). Recheck with
`xcodebuild -workspace ios/CLAN.xcworkspace -scheme CLAN -showdestinations` inside the isolated mobile directory.
The Oct 11 recheck confirms the same block. No simulator/runtime devices, compiled .app or IPA are available.
Install the requested iOS platform support/runtime in Xcode Settings > Components, then rerun; monitor free space.

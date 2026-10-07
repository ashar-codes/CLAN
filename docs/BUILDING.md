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
* Neither SDK is installed on the current dev machine, so neither native build has been run here.

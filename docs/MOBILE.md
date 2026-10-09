# Mobile (iOS / Android)

One Expo app (`apps/mobile`). It runs **the same `@clan/core`** as the desktop: Notes, Saved, Diary, Capture, Courses, Tasks,
Exams, Reminders, Flashcards, Study, Files, Whiteboard, AI and PersonalSync, with the same migrations. It has no
phone-only data model.

## How core runs on a phone
* **Database:** SQLCipher via expo-sqlite (`src/core/sqlite.ts`), the `DatabaseSync` subset core uses, with statements
  cached and finalized on eviction. The key is 32 random bytes held only in the Keychain / Android Keystore
  (`src/core/clan.ts`). FTS5 is enabled.
* **Node built-ins:** `node:crypto` / `fs` / `path` map to `src/node/*` through `metro.config.js`, with tsconfig `paths`
  so tsc checks core against them. Crypto uses @noble (sha256, HMAC, strict RFC 8032 Ed25519) plus expo-crypto
  randomness. `test/node-shims.test.ts` proves byte-identical results with Node. PDF.js is not bundled, so phone AI
  reports PDFs as unsupported.
* **Old data:** the phone's pre-core `study.json` / `inbox.json` move into core once (`src/core/migrate.ts`, through
  `sync.importLocal`).

## Features
* **Shell:** Home (desk, CLANmate, Today), Study (Courses with topic marks, Notes, Tasks, Exams, Reminders, Cards with
  SM-2 review, Session, Boards, Ask CLAN), Inbox (capture, photo, file, Saved), Diary, and Me (profile, My Devices,
  privacy).
* **Interaction:** native date/time pickers, touch targets of 48 dp or more, labels on every control, no animation.
* **Live CLAN:** join with code (OPAQUE in a WebView) over pinned TLS, typing an address if discovery fails. Then
  chat (group and direct, outbox, notifications), files (verified download, recipient-scoped send, "from Inbox"),
  the CLAN board (draw, highlight, erase, select, text, sticky, pan/zoom, undo, re-send after reconnect) and
  **watching presentations**.
* **Screen-share viewing:** LiveKit RN with WebRTC, subscribe only. Signaling runs over the pinned native socket,
  which now carries binary frames. The view supports fit, fullscreen (sharp layer), quality, reconnecting and Leave.
  Phones don't present.
* **Personal sync:** the same engine; the phone is a sync client. Link by code: a first-contact TLS socket pins the
  first key it sees, and the proofs bind to it. Then pinned and signed requests, conflicts, unlink, "link again" with
  a new key, Diary opt-in, file size choice. Sync runs on demand, when the app comes forward, and every 5 min while it
  is open; it never runs in the background.
* **Share to CLAN:**
  * Android: SEND / SEND_MULTIPLE intents. Only `content://` streams granted with the intent are read; up to 10
    items, 200 MB each, copied to the private cache.
  * iOS: Share Extension (`ios-extension/`, `plugins/withShareExtension.js`) writes to the App Group; CLAN picks it
    up when it comes forward.
  * Both: save to Inbox (offline) first, then optionally file to a collection, course or CLAN. Never posted
    automatically.
* **Camera:** photo → Inbox → Resource Store (expo-image-picker, permission asked each time, no EXIF). No scanning or
  OCR.

## Build
* **Android:**
  * Run `apps/mobile/scripts/android-dev.sh [--prebuild] [--release]`. It mirrors the repo to `~/clan-build` because
    react-native-zeroconf's ndk-build fails on paths with spaces, then builds arm64 and installs.
  * Toolchain: JDK 17, SDK 36, NDK 27.
  * Start the emulator via `launchctl submit …` (TESTING.md). Started from a background shell, macOS throttles it
    until it stalls.
* **iOS:** `expo prebuild -p ios` generates the project, including the share target and App Group. Building needs
  Xcode and an Apple team; neither is installed here (see Status).

## Status
| | Android | iOS |
|---|---|---|
| Native build | ✓ debug + release (debug-signed) APK | ✗ no Xcode / Apple ID |
| Runs | ✓ emulator (Android 16, arm64) | — |
| Physical device | not run | not run |

* **Verified on the emulator:** the cross-device flows in `e2e/android_cross_device.py`.
* **iOS trust:** the trust code (`PinnedTrust.swift`, including first contact) is compiled and tested with swiftc
  on macOS.
* **Not verified anywhere:** the iOS module, the iOS Share Extension, and all iOS UI.

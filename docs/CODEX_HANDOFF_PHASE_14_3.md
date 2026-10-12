# Codex handoff — Phase 14.3 (A+B+C+D) cloud implementation

**Local native QA update (2026-10-12):** See [LOCAL_QA_PHASE_14_3.md](LOCAL_QA_PHASE_14_3.md) for verified source,
native builds, security repairs, actual failures, hardware limitations and the BLOCKED release decision. The
historical cloud evidence below is not a substitute for this native record.

Nothing here has run on a phone, a Mac, a Windows PC or real radios. Status words: **source** (written),
**cloud tested** (ran on Linux/Node/Electron-under-Xvfb), **native build validated** (compiled for the platform),
**hardware verified** (ran on the device). Only the first two apply to anything in this phase, plus a Kotlin
*type-check* (not a build) for the Android modules.

## 1. Branches, PRs, commits (stacked; all draft; nothing merged)
| Phase | Branch | PR | Base |
|---|---|---|---|
| 14.2 persistent hosting | `claude/laughing-clarke-yql2cy` | ashar-codes/CLAN#1 | `phase-14.2` |
| 14.3 A+B people, chats, files, calls | `claude/phase-14.3-ab` (head `4cbe8b0`) | ashar-codes/CLAN#2 | `claude/laughing-clarke-yql2cy` |
| 14.3 C+D router-free, QR, optical | `claude/phase-14.3-cd` (see `git log -1`) | ashar-codes/CLAN#3 | `claude/phase-14.3-ab` |
Start locally from `claude/phase-14.3-cd`. Review/merge order when the owner decides: #1 → #2 → #3 (rebase each onto its
merged base). Do not squash away the progress docs.

## 2. Read first
`PHASE_14_3_ARCHITECTURE.md` (design, capability matrix, security decisions) · `PHASE_14_3_PROGRESS.md` (what ran) ·
`PHASE_14_3_HARDWARE_TESTS.md` (every device procedure, A+B and C+D) · `KNOWN_LIMITATIONS.md` › Phase 14.3 ·
`PHASE_14_2_PROGRESS.md` + `HOSTING_HARDWARE_TESTS_PHASE_14_2.md` + `CODEX_HANDOFF_PHASE_14_2.md` (14.2 obligations).

## 3. Code map (C+D additions)
| Area | Files |
|---|---|
| Secure link protocol (handshake, framing) | `packages/protocol/src/link.ts` |
| Optical transfer (fountain, private mode, receipts) | `packages/protocol/src/qrstream.ts` |
| QR formats (person intents/links, device link, Wi-Fi) | `packages/protocol/src/people.ts`, `sync.ts` |
| Sessions + connection manager + anonymous probe | `packages/clan/src/modules/people/link.ts` |
| Presence keys, pictures, device statements (core) | `packages/clan/src/modules/people/index.ts` (migrations 3–6) |
| TCP link transport + DNS-SD | `packages/server/src/link-tcp.ts` |
| Shared call engine | `packages/client/src/call-engine.ts` (`@classroom/client/call`) |
| Desktop | `apps/desktop/src/main/people-runtime.ts`, `main/people.ts`, `renderer/world/people/{Optical,Call,…}.tsx`, `world/devices/Devices.tsx` |
| Phone native module | `apps/mobile/modules/peer-link` (Kotlin: sockets, NSD, Wi-Fi Direct, Wi-Fi Aware, hotspot, foreground service; Swift: Network.framework peer-to-peer, Bonjour, NEHotspotConfiguration) |
| Phone JS | `apps/mobile/src/people/{nearby,native,runtime,Call,Voice}.ts(x)`, `src/ui/qr.tsx`, `src/screens/{People,Optical,Devices}.tsx` |
| Kotlin type-check harness | `apps/mobile/scripts/kotlin-check/` |

## 4. Environment and toolchains
* Node 24 + pnpm 11 (`pnpm install --frozen-lockfile`); lockfile changes in this phase were additions only
  (expo-camera ~57.0.6, expo-audio ~57.0.5, react-native-svg 15.15.4, qrcode 1.5.4 in the phone app).
* Desktop: `pnpm typecheck`, `pnpm test`, `cd apps/desktop && pnpm test:e2e e2e/people.test.ts e2e/optical.test.ts`.
  E2E launches Electron with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (and, for the optical
  receiver, `--use-file-for-fake-video-capture=<y4m>`); the main-process permission gate is the real one.
  `CLAN_TEST_LOOPBACK=1` is honoured only by unpackaged builds.
* Android: Android Studio / SDK 36, JDK 17, a physical device per HARDWARE_TESTS. `npx expo prebuild -p android` then
  `./gradlew :app:assembleDebug`. Expect to fix any Gradle/AGP issues in `modules/peer-link/android` first — it has only
  been type-checked (the cloud could not download the Android SDK: `dl.google.com` and `maven.google.com` artifacts are
  blocked there). The module's manifest merges NEARBY_WIFI_DEVICES (neverForLocation), FOREGROUND_SERVICE(_CONNECTED_DEVICE),
  POST_NOTIFICATIONS and the `connectedDevice` service.
* iOS: Xcode 26 + a physical iPhone. `npx expo prebuild -p ios`, open the workspace, build. `PeerLinkModule.swift` has
  never been compiled. Entitlement already present: Hotspot Configuration. Info.plist adds `_clanlink._tcp`,
  honest camera/microphone/local-network texts and `UIBackgroundModes: audio` (calls).
* Mobile JS validation done in the cloud: `npx tsc -p apps/mobile/tsconfig.json` and `npx expo export` for Android and
  iOS (Metro bundles build). That is not native build validation.

## 5. Signing keys (preserve — no secrets here)
Follow `ANDROID_SIGNING_BACKUP.md`: the `clan-beta` upload key lives outside the repo (`~/.clan-signing/…`, password in
the macOS keychain); release scripts read it from the keychain and fail closed. Do not regenerate, move, print or
commit it; do not change `plugins/withReleaseSigning.js` behaviour. Test builds use debug signing. No Apple signing
material exists in the repo; use your own development team for device builds.

## 6. Outstanding Phase 14.2 obligations (unchanged by 14.3)
Everything in `HOSTING_HARDWARE_TESTS_PHASE_14_2.md` (hand-over between real Mac/Windows computers, phone-owned CLAN
hand-off to a computer, recovery/fencing under power loss) and `WINDOWS_RETEST_PHASE_14_2.md` is NOT TESTED; the
Android signing backup is not confirmed; installers are not built. Phase 14.2 PR #1 stays draft until those pass.

## 7. Phase 14.3 gaps and next steps (priority)
1. Build both native apps; fix compile issues in `peer-link` (Kotlin/Swift) and in the expo-camera/expo-audio/
   react-native-svg integration; then run PHASE_14_3_HARDWARE_TESTS.md C1–C5, D1–D3 and the A+B list.
2. Measure optical transfer speed per device pair; tune default frames/s and block size (`OpticalScreen`, `Optical.tsx`).
3. Verify Android foreground-service rules on Android 14/15 (type `connectedDevice` prerequisites) and notification
   permission flows; verify iOS behaviour on lock/suspend.
4. Decide whether to add BLE presence for Android ↔ iPhone discovery without a hotspot, and iOS 26 Wi-Fi Aware.
5. Security audit of the whole app (see the security decisions in the architecture doc and `SECURITY.md`); fix the
   pre-existing desktop E2E selector failure (board-tape `Leave`).
6. Installers only after hardware passes (owner approval; signing per §5).

## 8. Don't repeat / don't break
* The link handshake and optical format are versioned (`clan-link/1`, `clan-qrx/1`); change them only with a new
  version and tests.
* Discovery must never use the real identity for unknown adverts (presence tags + throwaway probes).
* Keep the six pre-existing Linux E2E failures visible; they are environmental (screen capture, WebGL) or a stale
  selector, not 14.3 regressions.

## TEST BUILD DELIVERY checkpoint — 2026-10-12

Application source `6f7d946cc46f19805d6bc423e56c7d6642d87410`, branch qa/phase-14.3-local. The repository is public and the default branch is not this stacked source. PRs #1–#4 remain drafts; none were merged or force-pushed. Test packages are local under /Users/ashar/clan-143-local-qa/Installable Files and ignored by Git. Read the updated LOCAL_QA_PHASE_14_3.md and DEVICE_TESTING_GUIDE.md before interpreting results.

Fixed receipt round completion, transformed-wall screen track suspension, causal chat test ordering, premature file completion UI, GPU initialization observation, bounded discovery cleanup, authenticated manual-link endpoint loss, unreadable identity replacement, QR repair scheduling and asynchronous/corrupt rollback-fence persistence and duplicate desktop profile writers (real Mac/Windows packaged regression PASS). Android's conflict convergence, revocation, chat history, board and SHA-verified download scenario passed on the disposable emulator. Full unit regression at this revision: 452 PASS / 0 FAIL / 0 SKIP. Desktop multicast discovery remains a locally reproduced blocker; do not substitute isolated successes for a clean complete suite.

The user will perform physical Windows/Android/iPhone tests after receiving artifacts. Beta key backup is unconfirmed, so Android remains debug-signed .qa. No Apple Team/provisioning credentials are available, so no device IPA is claimed. Public release stays BLOCKED. Stop after test delivery; no CLAN Ask/Phase 15 work is authorized.


## BTC-1 handoff (2026-10-12)

See [BTC_1.md](BTC_1.md) for the root causes, opt-in foreground/tray availability, authenticated durable delivery, bounded call intent, notifications, real-discovery radar and mobile ownership. This is an internal TEST candidate; hardware and public-release gates remain open. Preserve OS-protected keys and existing profiles.

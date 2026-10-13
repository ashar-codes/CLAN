# BTC-2B+C verification

Status: local native, full unit and complete Electron verification passed; Windows CI repairs under verification. No public-release or physical-hardware completion claim.

Application branch: `btc-2bc-media`, baseline `258f657d3ec867878236b38811947cfc9ffbae97`. Application source: `f4a0b26fa97e1083463737d8518c37f5baff82e9`. Subsequent documentation-only checkpoints do not alter the tested application. Remote verification: [CI run](https://github.com/ashar-codes/CLAN/actions/runs/38333055800).

## Evidence already obtained

- Full four-project TypeScript check passed. Final isolated serial full run passed **66 files / 485 tests**, including real SFU, authorization and capture regressions (`/tmp/clan-btc2bc-final-isolated-unit.log`).
- Direct-call Electron fixture: six scenarios passed, including existing two-way audio and actual decoded video frames, camera toggles and hangup cleanup. Additional audio-to-video upgrade regression included in the final full run.
- Real Node/SFU fixture: four simultaneous audio/video publishers, three-participant group audio with late join, decoded non-silent samples, changing screen-share frames, remove/reinvite/rejoin and termination passed.
- Three actual Electron meeting clients: grid, changing remote camera frames, hand, authenticated chat, explicit changing screen-share source, stop and host termination passed.
- Focused shared lifecycle/authorization/host-fencing suite: 17 tests passed before the final additional regression run.
- Android native Gradle QA compilation passed, arm64, all native modules and bundled JavaScript. The final emulator meeting driver and its fixture both exited successfully (`/tmp/clan-btc2bc-android-final-verified-meeting.log`). A real native emulator joined two Node publishers through OPAQUE/pinned TLS and the local SFU: three participants, decoded outgoing camera frames, four distinct rendered incoming video frames, microphone mute/unmute, camera off/on, front/back switch, authorized hand and leave passed. Emulator microphone samples were silent (the emulator runs without audio); this is not physical microphone evidence. SDK API 36 system/vendor/ramdisk images restored from Google's SDK Manager into their previously missing locations; existing AVDs were preserved. A read-only disposable emulator boot passed.
- iOS Xcode 26.6 arm64 simulator compilation passed using Xcode-managed simulator signing. CLAN launched with a SecureStore device identity; the BTC-2A unsigned `-34018` startup blocker is resolved on this simulator. No Keychain bypass, credential invention or identity fallback was used. The native XCTest profile/note/restart persistence test passed twice with secure storage enabled (`/tmp/clan-btc2bc-ios-persistence-verified.log`, `/tmp/clan-btc2bc-ios-final-repeat.log`); final permission-description build and strict bundle signature verification also passed; previous wrong-input and nested-header selector failures were corrected without removing persistence assertions. Physical Apple signing/capabilities remain unverified.
- Actual Mac capture: granted OS microphone/camera permissions, 15 decoded local camera frames with 15 distinct hashes (640×480), 15,727 recorded audio bytes and stopped audio/video tracks passed in an isolated Electron runtime. No media recording was retained. This is local capture, not a physical cross-device call.
- Secrets review: all 132 baseline history commits and the final staged implementation diff passed Gitleaks with zero leaks; logs stay outside Git.
- Dependency scan: zero critical, two high and two moderate inherited transitive findings (`node-forge`, `braces`, `uuid`, `sprintf-js`). This is not a clean dependency scan.

## Earlier failures retained

The initial direct-video fixture detected an answering-side extra-transceiver bug and then streamless remote-track rendering; both were repaired and unchanged media assertions passed. Adding Video call required the existing audio selector to match Call exactly. An initial default-concurrency full run experienced memory pressure/timeouts; it was stopped. A subsequent serial full run overlapped capture-lease/test edits and is invalid as final evidence (478 pass / 1 fail on old-loaded implementation). Frozen-source runs supersede these, without weakening or skipping assertions. The first SFU reconnect fixture reused a disconnected Node Room retaining state; a fresh Room matches production rejoin behavior. Another fixture tried to read signalUrl before lazy SFU startup and was corrected to await the token first.

An initial full Electron run had 41 pass / 3 fail (44 tests). The new meeting panel displaced the whiteboard on desktop/mobile; it now follows the existing room/content layout. Isolated whiteboard/Direct/membership-leave/meeting regressions passed (six tests). Concurrent Electron runs shared teardown and interfered with each other; the final isolated complete run passed **25 files / 44 tests** (`/tmp/clan-btc2bc-final-isolated-electron.log`, 567.91 seconds). Android secure joining/chat/sync/Keep Both passed before its whiteboard layout failure; the final complete repeat passed, including Keep Both convergence, secure join, two-way chat/whiteboard, revocation, history scrolling and SHA-256-verified file download (`/tmp/clan-btc2bc-android-final-integration.log`). A native camera restart failed with device ID `default`; the native adapter now supplies enumerated camera IDs and switches only while camera capture is stopped. Its emulator controls passed after repair.

A later full run reported 482 pass / one native worker SIGBUS in the Node meeting fixture. Cleanup now stops and awaits producers/readers, disconnects rooms and only then releases native source handles. Focused real-SFU tests passed afterward; the final isolated complete repeat subsequently passed all 485 tests. A Node-native startup check also caught non-erasable TypeScript parameter-property syntax; it was replaced with ordinary field initialization and typecheck passed. These failed/invalid runs are retained as evidence, not hidden.

## Reproduction

Use Node 24.19.0 and the existing pinned SFU fetched by `native/livekit/fetch.sh`:

- `pnpm typecheck`
- `pnpm exec vitest run --maxWorkers=1`
- `pnpm build:desktop`, then in `apps/desktop`: `PERF=1 pnpm exec vitest run -c vitest.e2e.config.ts` (one Electron suite at a time)
- Android: `:app:assembleQa -PreactNativeArchitectures=arm64-v8a --max-workers=2`; install only on a disposable QA emulator, then run `apps/mobile/e2e/android_meeting.py` and `android_cross_device.py` sequentially. Set `ADB` to a wrapper restricted to that emulator. Meeting rendering checks require local `ffmpeg`.
- iOS: signed native simulator build and native XCTest; see [BUILDING](BUILDING.md). No physical Apple credentials are invented.

Local evidence is in `/tmp/clan-btc2bc-*`; native XCTest result bundles are `/private/tmp/clan-btc2bc-ios-*.xcresult`. These logs and disposable media/profiles stay outside Git. `.github/workflows/btc2bc-media.yml` checks Linux and Windows software/media on this branch; Linux CI passed; Windows results are pending below. Windows CI uses virtual media, not hardware.

## Hardware distinction and restrictions

PASS software/native/simulator tests never imply physical cameras, microphones, router topology or eight-participant load passed. Physical Mac↔Windows↔Android↔iPhone media, multi-router networking, physical camera switching/permission revocation, battery/background/locked behavior and real screen/window capture are NOT TESTED in this stage. iOS simulator media frames/audio are NOT TESTED; simulator startup and persistence are separate PASS results. No tests are deliberately skipped to make failing assertions green; hardware-unavailable scenarios remain NOT TESTED. The four BTC-1 Desktop installers and installed CLAN TEST remain unchanged. No IPA, installer rebuild or release approval is claimed. All four current installer SHA-256 hashes were rechecked unchanged. Installed CLAN TEST remains intact. Available disk space at the local verification checkpoint: approximately 28 GiB.

After software checks: verify audio/video on each pair, then 4–8 participants on an authorized LAN without internet; test late join, direct-call upgrades, mute, camera switch/deny, blocks, revocation, stale host, network loss/reconnect and OS capture permissions. Check microphone/camera indicators extinguish immediately on hangup/navigation and camera stays off in background. Recheck existing messaging, queued voice/file delivery and handover. Administrator-authorized UDP routes remain necessary for media across subnets; no firewall bypass or TURN is introduced.

## Platform and feature evidence

| Scope | Result | Evidence limit |
| --- | --- | --- |
| Shared/server unit, integration, security | PASS: 66 files, 485 tests | Real local SFU plus deterministic fixtures |
| One-to-one audio/video and audio-to-video upgrade | PASS in focused Electron/media fixtures | Virtual camera/tone; final complete Electron suite also passed |
| Group audio | PASS: three decoded simultaneous non-silent sources, late join | Local SFU; eight-participant load NOT TESTED |
| Group video | PASS: four simultaneous publishers and changing decoded frames | Local SFU; three-client Electron UI and native emulator |
| Meeting screen sharing | PASS: selected deterministic changing source, render/stop/end | Actual physical screen/window selection and permission revocation NOT TESTED |
| Android native build and complete integration | PASS | Disposable emulator; physical phone NOT TESTED |
| Android meeting camera, receive rendering and controls | PASS | Silent emulator microphone; physical audio NOT TESTED |
| iOS native build, secure startup and restart persistence | PASS | Simulator; camera/media and physical signing NOT TESTED |
| Physical Mac microphone/camera capture | PASS | Local capture only; cross-device hardware call NOT TESTED |
| Linux CI | PASS: typecheck, desktop build, 484 tests; 1 SKIPPED | Apple Security/Swift test requires macOS and passed locally |
| Windows software | CI running | Physical Windows media NOT TESTED |

No test assertion was deliberately skipped or weakened to obtain PASS. The existing platform-gated Apple Security/Swift test is SKIPPED on Linux/Windows, separately counted; it passes on macOS. Earlier failures are retained above; hardware unavailable is NOT TESTED, separate from a failed executed test.

## Changed files

The application commit changes 44 files: shared call/media lifecycle and protocol types; authenticated meeting server/media gateway; desktop/mobile calling, meeting and fixed-chat-header UI; native camera/audio adapters; platform permission descriptions; regression fixtures and CI; architecture, security, building and separate B/C results. Exact reviewable list: `git show --stat f4a0b26fa97e1083463737d8518c37f5baff82e9`.

## Cross-platform CI failures and repairs

Initial CI `38333055800`: Linux PASS (484 tests, one Apple Security/Swift platform SKIPPED). Windows typecheck/build PASS; unit/integration FAIL (468 PASS, 16 FAIL, one SKIPPED; two additional suite cleanup errors). Windows Electron was initially not run because of the unit failure. Failures included POSIX-only path assertions/source-boundary comparisons, Unix socket mock BLE transport, open fixture SQLite handles blocking Windows deletion, and the final meeting termination state timing out after otherwise successful four-publisher media.

Fixture path handling now uses native separators and normalized source-relative paths without changing containment/authorization assertions. The development-only mock BLE radio now uses Windows named pipes plus disposable advertisement markers and rejects listener errors; production cannot select the mock. Fixture database handles close before removing disposable directories. Seven affected local suites passed **105 tests**. CI runs serial units and collects Windows Electron results even after another check fails. The meeting timeout now reports its condition and states for diagnosis; no media/end assertion was removed.

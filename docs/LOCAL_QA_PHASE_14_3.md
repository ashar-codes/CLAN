# Phase 14.2 / 14.3 native QA and release record

Date: 2026-10-12. **Release decision: BLOCKED. Internal artifacts are TEST/UNVERIFIED.**

## Source and safety

Starting branch: `claude/phase-14.3-cd`; verified source: `a198430f107b29d58ed6febff0b890d182b1c083`.
Repairs are on `qa/phase-14.3-local`, in `/Users/ashar/clan-143-local-qa`.
The repository is PUBLIC. Its default branch is `clan-astra-phase12`, which is not the requested stacked source.
PR [#1](https://github.com/ashar-codes/CLAN/pull/1) → [#2](https://github.com/ashar-codes/CLAN/pull/2) →
[#3](https://github.com/ashar-codes/CLAN/pull/3) ancestry and exact heads were verified. None were merged.

Original checkouts, staged work, application profiles, databases, keys and existing release files were preserved.
Only disposable Electron profiles, Android AVD `clan_143_qa` (serial `emulator-5556`) and iOS simulator `CLAN-143-QA`
were used. No caches or existing release packages were deleted. Build dependencies were restored using matching
cached archives/binaries where network downloads failed, without changing their versions.

Gitleaks 8.30.1 scanned all 107 locally available commits after fetching every public branch into the
`refs/remotes/qa-audit/` namespace: **PASS, zero findings**. This is a bounded automated scan, not a proof that no
secret has ever existed. Raw testing logs, generated native trees, keys and installers are excluded from commits.

## Environment

Apple Silicon MacBook Pro, 8 CPUs, 16 GiB RAM; macOS 26.5.2 (25F84), Xcode 26.6 (17F113), iOS SDK/runtime 26.5,
CocoaPods 1.17.0, Android SDK 36, JDK 17, pnpm 11.20.0, Electron 44.5.1, LiveKit server 1.13.9.
Node 24.19.0 was used for the baseline and explicitly selected for final JS checks. The machine's Homebrew Node
changed during QA; later commands select Node 24 explicitly. Initial free space was about 38 GiB; native build
caches and disposable simulators consume additional space. Disk capacity remains a practical build constraint.

## Baseline evidence (before repairs)

| Check | Result | Evidence |
| --- | --- | --- |
| Frozen pnpm install / supply-chain policies | PASS | 1,040 packages installed |
| Typecheck, all four projects | PASS | `clan-143-typecheck-baseline.log` |
| Unit suite | FAIL | 430 PASS, 1 FAIL, 0 SKIP; QR image recovery exceeded its overhead bound |
| Native Electron E2E | FAIL | 34 PASS, 4 FAIL, 2 SKIP; 40 tests |
| Android Expo prebuild | PASS | Native project generated |
| Android Gradle arm64 `assembleDebug` | PASS after network retry | 598 tasks, 3m46s; real APK, all custom modules compiled |
| iOS prebuild | PASS | Isolated native project generated |
| Initial CocoaPods | FAIL | Native dependency download connection reset; matching cached archives restored |

Desktop baseline failures were the ambiguous whiteboard Leave selector, Study Tape navigation after saving,
voice-note recording and changing screen-share frames. Screen tests use a deterministic capture source with
real Electron, local SFU and WebRTC; they do not certify an actual OS screen picker or physical camera/audio path.
The first stalled Electron-install attempt is not included as a successful E2E run.

## Repairs and security review

| Finding | Severity | Repair / evidence |
| --- | --- | --- |
| Known CLAN session could omit host authority | High | Hosting rejects omission once an anchor/chain exists; regression test |
| Clients continued operating while host verification failed or was pending | High | Serialized SessionGate holds projections and outgoing writes; failure closes the connection and removes controls; six regression tests |
| Settings broadcasts omitted authority | High reliability | `class.state` carries the same current authority as hello; settings changes revalidate |
| Unauthenticated / unconsumed link queues could grow | High availability | Frame, byte and burst caps; hostile burst regressions |
| File reply offset/size checked after append | High availability/integrity | Validate complete bounded range before any disk write; four hostile-reply tests plus real TCP resume/SHA tests |
| Peer handler rejection could escape | Medium reliability | Close the offending authenticated link on handler failure |
| CRC-valid truncated QR header / malformed metadata | Medium availability | Length/type/path/size/hash validation before displaying or decoding; malformed-frame regressions |
| Fountain peeling stalls on cyclic equations | Medium reliability | Bounded Gaussian elimination for small remainders, unchanged wire format; exact-byte cycle regression |
| Android microphone removed by blockedPermissions | Functional | Retain requested microphone permission and its user action prompt |
| Permanently denied Wi-Fi permission treated as granted | Functional/privacy | Required permission must actually be GRANTED; notification permission is separate |
| iOS port narrowing could trap; socket map read on a different queue | Medium reliability | Checked port ranges, serialized writes, bounded outgoing connections; actual Swift compilation |
| Missing packaged Mac media/Bonjour descriptions | Functional | Camera/microphone descriptions and peer/link service declarations |
| People IPC registration raced initial UI loads | Functional | Register handlers before creating the first window |
| Recording toast stretched across window and intercepted navigation | Functional | Reset top for recording toast; status toasts do not intercept input |
| Study Tape stop/start failure leaked microphone tracks | Privacy | Stop every owned capture track, including original mixed-audio sources |
| Mac AAC encoder advertises support but errors immediately | Functional | Recorder handles encoder errors and tries another supported format only before any audio was captured; partial recordings remain reviewable with a warning |
| Bundled VP8 start-bitrate collision | Functional | Supported LiveKit dual publisher/subscriber connection mode; same authenticated local SFU |

Focused security regression: **46 PASS / 0 FAIL**, six files (`clan-143-security-retry.log`).
Review included existing identity/OPAQUE/pinning and signed linking, handover epochs/revocation, peer policy and
blocking, chat terms/retention, authorized file ranges, QR parsing, permission handling, migrations/backups,
keystore boundaries and untrusted-input limits. Automated coverage is evidence for the tested paths; native radio,
OS suspension and physical interoperability remain unverified.

### Remaining audit limitations

- Dependency scan: **0 critical, 2 high, 2 moderate**. Findings: node-forge RSA verification, braces nested-pattern
  exhaustion, uuid buffer bounds and sprintf-js precision exhaustion. Observed paths are Expo/Metro/Xcode/
  electron-builder tooling; no evidence of these libraries in the bundled desktop runtime. Requested patched
  versions for node-forge/braces/sprintf-js were unavailable in the registry during this run. Retain findings
  and recheck upstream; avoid untrusted build inputs. This is not a clean dependency scan.
- Desktop SQLite and local files are not application-encrypted. Identity keys use OS protection; mobile core uses
  encrypted storage. Do not represent transport encryption as encryption of the desktop database.
- Expiry removes temporary chat data from the active store. Existing database backups, WAL/free pages, saved
  copies or another participant's copies are not a forensic-erasure guarantee. Backup retention needs explicit
  product/security acceptance before claiming stronger temporary deletion.
- Actual Android locked/background microphone behavior and foreground-service policy remain NOT TESTED.
  A compiled connected-device service does not prove locked audio-call availability.
- iOS background availability remains OS-limited; simulator success cannot establish Apple peer-to-peer radio behavior.
- QR overhead failed intermittently across earlier runs even after successful exact-byte reconstruction. Preserve
  failed evidence and continue multi-seed optical/hardware validation; do not weaken the overhead assertion.

## Hardware matrix and release gate

The owner confirmed **only the Mac is available** and **Android signing backup is not confirmed**.
No beta signing key/password was loaded or used. No valid Apple signing identity was available.

| Required scenario | Status |
| --- | --- |
| Mac ↔ Windows ↔ physical Android, normal LAN | NOT TESTED — Windows/Android unavailable |
| Same devices, LAN without internet | NOT TESTED — same hardware missing |
| Android ↔ Android Wi-Fi Direct / Aware without router | NOT TESTED — two physical phones missing |
| Android hotspot ↔ Mac/Windows/iPhone | NOT TESTED — hotspot device missing |
| iPhone ↔ iPhone peer connectivity | NOT TESTED — physical iPhones missing |
| Discovery/privacy/friends/blocking/identity | Automated desktop/core coverage; physical matrix NOT TESTED |
| Permanent/temporary chat, queues/restart/receipts | Automated coverage; physical matrix NOT TESTED |
| Resume/SHA/cancel/storage failures | Automated core/transport coverage; hardware matrix NOT TESTED |
| Two-way calls and voice notes | Synthetic desktop media tests; real audio/device matrix NOT TESTED |
| Static QR and animated transfer with radios off | Software image/reconstruction tests; camera/radios-off hardware NOT TESTED |
| Android foreground/locking/battery; iOS background limits | Physical OS-policy tests NOT TESTED |
| Phone-owned host → computer and other handovers | Core/desktop automated coverage; phone/Windows cases NOT TESTED |
| Classroom/Whiteboard/Notes/Files/Tasks regressions | Desktop automated baseline plus repair retests; results below |

PASS means the named check completed. FAIL means it ran and failed. SKIPPED is an explicit test-runner skip.
NOT TESTED means the check was not executed; missing physical hardware is never relabeled PASS or SKIPPED.

## Final results and artifacts

Tested application code: `fa5bfc7d25b9b1ef56ef1e1b2749fc76e2c288c9`, version `0.1.0`.
Review: draft [PR #4](https://github.com/ashar-codes/CLAN/pull/4), against `claude/phase-14.3-cd`.
Later documentation commits do not change the application sources or lockfile. This code SHA is the common
revision for the packaged artifacts and the hardware handoff; no Windows binary exists yet.

| Final check | Status | Evidence / limits |
| --- | --- | --- |
| Four-project typecheck | PASS | `clan-143-typecheck-release-candidate.log` |
| Security regressions | PASS | 46 PASS, 0 FAIL, six files |
| Full unit suite, concurrent native-build run | FAIL | 444 PASS, 2 FAIL, 0 SKIP / 446; phone timeout and 100-peer swarm failure |
| Isolated phone/swarm retest | PASS | 21 PASS, 0 FAIL; unchanged assertions; earlier failures retained |
| Full unit suite, quiet sequential rerun | FAIL | 445 PASS, 1 FAIL, 0 SKIP / 446; sender still queued when recipient received first message; `people-transport.test.ts:51` |
| Isolated peer-transport retest | PASS | Six PASS, unchanged tests; does not override quiet full-run failure |
| Full real Electron E2E | FAIL | 37 PASS, 1 FAIL, 2 SKIPPED (optional PERF cases) / 40; Study Group changing-frame assertion received 2 distinct frames, requires 4 |
| Explicit native performance E2E (`PERF=1`) | PASS | Two PASS, 0 FAIL, 134.57s; whiteboard load/render and 720p/1080p Study Tape recording; measurement tests, not physical media certification |
| Focused desktop media suite | PASS | 8 PASS, 0 FAIL before final LAN-only ICE configuration; does not override full-suite failure |
| Whiteboard/Study Tape regression | PASS | Three related tests passed; final full suite also passed those cases |
| Final native Android Gradle QA build | PASS | 1,037 tasks, 1m34s; all custom Kotlin/native modules compiled; embedded JS; DEBUG certificate |
| Android final QA APK install/update and restart | PASS (limited) | Install `-r`, force-stop, launch; retained disposable profile showed Sara's desk; not beta signing compatibility |
| Android emulator cross-device scenario | FAIL | Initial linking format rejection. Final APK diagnostic retry verified UI input, linked, synced notes both ways and detected offline conflict; Keep both failed to converge within timeout. Revocation/chat/board/files later stages NOT TESTED |
| iOS final unsigned Release simulator compilation | PASS | Real CocoaPods/Xcode/Swift/native modules, arm64 and x86_64 |
| iOS simulator execution | NOT TESTED | New simulator boot stalled in CoreLocation migration; no successful app launch |
| Apple Silicon DMG build/install smoke | PASS (limited) | Mounted with verified CRC, app copied to disposable location, strict/deep signature check, window opened; SQLite quick_check = ok |
| Packaged Mac full interactive hardware flow | NOT TESTED | Build/install smoke and source Electron E2E do not certify OS camera/microphone/picker or physical peer paths |
| Windows native build/install/E2E | NOT TESTED | Only the Mac is available; no EXE produced |
| Gitleaks all locally fetched public refs / repair code | PASS | 107 commits; zero findings |
| Dependency audit | FAIL / findings open | 0 critical, 2 high, 2 moderate; tooling paths, details above |
| Android release-key gate | PASS (fail-closed control) | `assembleRelease --dry-run` without signing configuration rejected; existing beta key untouched |

Artifacts are local under `/Users/ashar/clan-143-local-qa/Installable Files/` and ignored by Git:

| Artifact | SHA-256 | Signing |
| --- | --- | --- |
| `macOS/CLAN-0.1.0-TEST-UNVERIFIED-fa5bfc7-arm64.dmg` | `b7e4a962d3c35a43ff96268b956678f34700f0ae4de50417a31f46d3143fff1f` | Embedded app ad-hoc signed, hardened runtime; no TeamIdentifier, Developer ID or notarization |
| `Android/CLAN-0.1.0-TEST-UNVERIFIED-fa5bfc7-arm64.apk` | `68a4ff54d946f7eecfbd166aa579130f79d3c91e96972e9d2644115e0354ed0a` | Debug-signed; certificate SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |
| `iOS/CLAN-0.1.0-TEST-UNVERIFIED-fa5bfc7-simulator.app.zip` | `7f9ef827ee3a406cc60f43b6182ad246dbf8e64fda21cc5df83d284381ae2505` | Unsigned simulator application; **not an IPA** |

`Installable Files/Documentation/SHA256SUMS` also covers the DMG blockmap. Internal installation instructions,
test matrix and audit record are in that Documentation directory. The Android QA APK cannot update an existing
beta signed with the upload identity. Do not uninstall or clear a real beta to force this APK onto it.

The final Android retry used the existing scenario with an external input-verification wrapper only, unchanged
product code and assertions. Verification confirmed the actual link code/address fields matched requested text
without logging their values. It progressed past initial linking, so the first failure is not a proven product
code-format defect. The later Keep both convergence failure is unresolved; UI-driver targeting, sync scheduling
and native behavior require investigation. Neither version is relabeled as a complete scenario PASS.

The quiet full unit failure observed the receiver's message before the sender's authenticated receipt state had
become delivered; an isolated six-test rerun passed unchanged. This may be asynchronous transport timing, but
receipt stability has not been established. The full screen-share failure likewise remains despite focused passes.

Release remains **BLOCKED** by failing mandatory suites, incomplete emulator/runtime validation, missing Windows
and physical-device evidence, unconfirmed Android signing backup/continuity/update gates, and absent Apple signing.
No distribution was performed. Ad-hoc signing may trigger macOS Gatekeeper; OS security controls were not disabled.

Raw evidence stays local under `/tmp/clan-143-*.log`; logs may contain disposable invitation/session material and
must not be uploaded without redaction. Only sanitized summaries belong in Git or a PR.

## Identical-revision hardware handoff

Use tested application revision `fa5bfc7d25b9b1ef56ef1e1b2749fc76e2c288c9` on every machine, not the repository default branch. Create a fresh worktree/profile
and verify `git rev-parse HEAD` before testing. Follow all existing checklists:
[14.3 hardware](PHASE_14_3_HARDWARE_TESTS.md), [14.2 hosting](HOSTING_HARDWARE_TESTS_PHASE_14_2.md),
[Windows retest](WINDOWS_RETEST_PHASE_14_2.md), [14.3 architecture](PHASE_14_3_ARCHITECTURE.md).

On Windows: install matching Node/pnpm and helpers per [BUILDING](BUILDING.md), run frozen install, typecheck,
unit and native Electron E2E. Build the Windows helper and LiveKit Windows binary using the documented native
commands, then make a TEST/UNVERIFIED x64 NSIS installer. Install it on a disposable Windows profile and run
firewall/discovery/permissions, calls, files, persistence, restart and handover tests. Record Windows/macOS/Android
artifact hashes and exact shared source SHA. Do not move fixes onto a Windows-only development branch.

On physical Android: build `apps/mobile/scripts/android-qa.sh`, use a separate test device/profile and debug signing,
then run the routerless/hotspot/Aware/foreground/lock/camera/microphone/call/QR/persistence checks. Record supported
capabilities rather than treating unsupported Aware as a failure or supported Aware as automatically tested.

Before Android beta signing: confirm secure backup of the existing key **and password**, perform a restore check,
verify its certificate continuity against a prior beta, then test an actual signed update without clearing app data.
Before iOS distribution: obtain valid signing/provisioning and a physical-device test; the unsigned simulator app
is not an IPA. Before any distribution: resolve failing mandatory tests/security findings and get release approval.

## Final local stabilization and TEST delivery — 2026-10-12

Application/package revision: `6f7d946cc46f19805d6bc423e56c7d6642d87410`; version 0.1.0. Final documentation is committed separately; the delivery manifest records both SHAs. All artifacts are TEST/UNVERIFIED. Physical Windows/Android/iPhone validation is explicitly deferred to the user. No public release approval, merge or force-push.

| Check | PASS | FAIL | SKIPPED | NOT TESTED / limits |
| --- | --- | --- | --- | --- |
| Full typecheck | All 4 projects | 0 | 0 | Node 24.19.0 |
| Full unit/integration | 452 / 60 files, repeated | 0 on final runs | 0 | Final repaired revision: 176.01s; earlier run 177.22s |
| Focused security | 110 / 12 files | 0 | 0 | Authority/fencing, SessionGate, peer links, file ranges, migrations, QR, keystore |
| Complete Electron E2E with PERF=1 | 30 / 40 | 10; also one screen teardown hook | 0 | Discovery/approval setup; wrong-code test receives throttling; public release blocked |
| Isolated screen/GPU/file regressions | Screen 3; GPU + CLAN 2 | 0 on successful isolated runs | 0 on these successful runs | Real Electron GPU + SFU/WebRTC, deterministic capture; OS picker NOT TESTED |
| Optical stress | 1,000 salt/drop runs with exact reconstruction | 0 on final schedule | 0 | Camera/radios-off hardware NOT TESTED |
| Android native standalone | Gradle QA 1037 tasks; all native modules + bundled JS | 0 | Gradle's normal NO-SOURCE/non-applicable tasks | arm64 .qa, debug certificate |
| Android emulator integration | Complete scenario twice after linking repair | 0 on final two scenarios | 0 scenario checks | Linking, two-way sync, Keep Both, revocation, share Inbox, OPAQUE/pinning, two-way chat/history, board, 1.5MB SHA download |
| Android final update/restart | Install -r; encrypted notes and both conflict versions preserved | 0 | 0 | Beta update/certificate continuity NOT TESTED; beta key untouched |
| iOS simulator native | Release compile; final XCTest 1 case / 0 failures, 52.423s; earlier 54.906s | Prior retry failed AX snapshots | 0 on final retry | Ad-hoc Keychain; existing profile/note/relaunch/exact content |
| iPhone SDK | Actual unsigned device SDK compile | 0 | 0 | No Team/provisioning; no IPA or capability validation with a Team |
| Mac packaged DMG | CRC, mount/install, strict deep signature, secure Keychain, exact note save and restart | 0 on final smoke | 0 | Ad-hoc, not notarized; physical media/network paths remain user tests |
| Packaged profile-lock regression | Mac and Windows: duplicate rejected, link forwarded, identity preserved, separate profile works | 0 final runs | 0 | Earlier Mac Keychain startup timeout retained |
| Windows x64 native CI | Build, NSIS install/startup/uninstall, beta firewall preservation | 0 final run | 0 workflow steps | Runner evidence, not physical Windows interoperability |
| Dependency audit | 0 critical | 2 high, 2 moderate remain | 0 | Build/development paths; not a clean scan |
| Secrets/history | 116 commits, 0 findings before final documentation commit | 0 | 0 | Public repository; bounded automated scan |
| Real devices/radios | 0 claimed | 0 claimed | 0 claimed | Windows PC, Android phones, physical iPhones, camera/mic/calls, locked/background and cross-platform handover NOT TESTED |

### Defects resolved

- People receipt state now waits for the authenticated link write round; concurrent ticks coalesce into an awaited follow-up. The transport/link/chat subset passed twice.
- Transformed 3D screen walls no longer trigger LiveKit visibility suspension. Track subscription and connection setup are explicit/serialized; capture fixtures declare a positive frame rate. Assertions still require changing frames.
- File UI does not claim completion before integrity verification/native save; GPU E2E waits for the actual context-loss listener to be installed. Chat ordering tests observe causal delivery instead of assuming a sleep orders independent sockets.
- Verified manual linking endpoints remain preferred after adoption. Android driver uses the QA namespace's real activity, validated inputs, device viewport and actual permission prompts. Existing Keep Both implementation was retained; actual convergence now passes. Phone upload is not implemented in this driver and remains NOT TESTED.
- Existing unreadable desktop identity keys are preserved; startup refuses rather than silently replacing a private identity.
- Handover/activation/replay wait for fence persistence. Corrupt/unreadable records refuse hosting; shared adapters serialize writes; actual storage failure refuses acknowledgement. Expo lacks fsync, so abrupt power-loss durability is not certified.
- QR repairs use balanced deterministic selection and bounded dense repair for small blocks without changing the wire format. The original overhead bound remains enforced: 1,000 final runs had zero failures, maximum 167 frames against a 232-frame bound.
- Discovery shutdown is bounded even if unpublish never calls back. One final screen teardown hook still exceeded 30s and remains unresolved.
- Simulator signing permits secure Keychain access; initial secure-store/native initialization errors are visible rather than leaving a blank screen. A cold, quiet retry passed unchanged XCTest assertions; the underlying intermittent SDK accessibility fault is not proven resolved.
- TEST packaging isolates computer profiles and Android package data. Windows TEST firewall rules use the correct executable/product and preserve beta rules through install/uninstall, tested natively in CI.

- Desktop startup now obtains a per-profile Electron process lock before opening identity, database or fence storage. A second launch forwards bounded validated capture links to the existing app; distinct profiles remain independent. The previous packaged build reproduced duplicate writers. Real installed Mac and Windows builds passed duplicate rejection, forwarded capture text, unchanged primary identity and distinct second-profile identity. The initial Mac retry waited on Keychain and timed out; after OS approval, the installed-app regression passed.

### Failed evidence retained

Earlier complete E2E runs: 36 PASS / 2 FAIL / 2 SKIP; then 39 PASS / 1 FAIL / 0 SKIP plus two failed teardown hooks; then 27 PASS / 13 FAIL / 0 SKIP. Final: 30 PASS / 10 FAIL / 0 SKIP plus one failed hook. Nine final cases depend on automatic discovery/approval; the wrong-code case expected No CLAN matches but got Too many attempts. Do not disable rate limiting or relabel these PASS. The complete suite used 49756cb application inputs, identical at f8cc8f7 except Windows packaging. The final 6f7d946 desktop-only profile lock is checked separately against the real packaged app; the complete failed suite was not relabeled or claimed rerun at that final revision.

A later full unit run recorded 428 PASS / 24 FAIL (mostly disk-full errors and long timeouts); the unchanged quiet repeat at 6f7d946 passed all 452 in 176.01s. Completed QA-only unsigned device-build intermediates and module cache were removed after checking that no Xcode build used them; products/logs and old packages remain. An earlier overloaded full unit run had 448 PASS / 3 timeout FAIL; quiet bounded runs passed 451 and then 452 after the added fence regression. Earlier QR failure salts, native download failures, Android activity/permission/endpoint failures and the iOS 213s accessibility-snapshot failure remain in local logs. The final iOS cold/quiet retry passed unchanged assertions. No failed run was hidden.

Final native refresh: Android Gradle 1037 tasks / 27 executed in 53s; final iOS simulator native compilation and XCTest passed (52.423s). Final APK install -r/native restart preserved the existing profile and both Keep Both note versions; the first UI dump returned null root, and a disposable-emulator wake/unlock plus unchanged retry succeeded without clearing data. No mobile/package source changed between f8cc8f7 and 6f7d946; the final change is the desktop lock/capture handler and Windows regression workflow.

Local evidence: /tmp/clan-delivery-final-{typecheck,unit,security}.log; /tmp/clan-delivery-lock-{typecheck2,unit,unit-retry,installed}.log; /tmp/clan-delivery-ios-lock-{build,uitest}.log; /tmp/clan-delivery-android-lock-{build,install}.log; /tmp/clan-delivery-e2e.log; /tmp/clan-delivery-android-{build,scenario,update-smoke}.log; /tmp/clan-delivery-ios-{device-build2,final-uitest}.log; /tmp/clan-delivery-mac-lock-smoke.log; /tmp/clan-delivery-audit.json. Logs contain disposable test inputs and are not committed. Windows evidence: https://github.com/ashar-codes/CLAN/actions/runs/38212448780.

### Remaining limits / decision

Local multicast discovery currently returns no nearby peers/classrooms in the diagnostic setup; manual-address linking and emulator OPAQUE/pinned joining pass. macOS Local Network permission changes/live testing were deferred by the user; do not claim the permission is fixed or that it is the proven sole cause. Full-profile/OS snapshot rollback and abrupt power-loss fencing are not certified by the tested SQLite-backup rollback guarantees. Native radio/background/media and real-device handover remain unverified. Desktop SQLite/files are not application-encrypted; temporary expiry is not forensic erasure of backups/WAL/saved copies.

The dependency scan retains node-forge/braces high and uuid/sprintf-js moderate findings in observed build/development paths; requested fixes for the first two and sprintf-js were unavailable during registry checks. Do not describe this as a clean dependency audit.

Android beta-key backup is unconfirmed: only debug-signed .qa candidates are supplied. No existing beta signing material was accessed, replaced or regenerated. No Apple signing Team/provisioning profiles were available, so physical capability/signing validation and a genuine device IPA are unavailable. The prepared Xcode workspace and instructions are real; a simulator ZIP is not an IPA. Mac signing is ad-hoc, not Developer ID/notarized; electron-builder's internal ad-hoc hardened-runtime package includes its required library-validation exception, while the configured Electron fuses remain enforced. Windows is unsigned.

**TEST builds for personal validation; public release BLOCKED.** Use DEVICE_TESTING_GUIDE.md, report results, then stop delivery work. PRs #1–#4 remain drafts, including https://github.com/ashar-codes/CLAN/pull/4.


## BTC-1 update (2026-10-12)

See [BTC_1.md](BTC_1.md) for the root causes, opt-in foreground/tray availability, authenticated durable delivery, bounded call intent, notifications, real-discovery radar and mobile ownership. This is an internal TEST candidate; hardware and public-release gates remain open. Preserve OS-protected keys and existing profiles.

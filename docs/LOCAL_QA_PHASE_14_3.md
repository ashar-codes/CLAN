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

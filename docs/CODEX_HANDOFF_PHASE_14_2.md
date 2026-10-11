# Codex handoff — Phase 14.2

Written by Claude Code when capacity ran low (the CLI cannot read the weekly usage percentage, so this was written
early). Progress table: [PHASE_14_2_PROGRESS.md](PHASE_14_2_PROGRESS.md).

## 1. Where things are
* Repo worktree: `/Users/ashar/clan-astra-phase12` (isolated). **Do not touch** the original checkout
  `/Users/ashar/Desktop/My Projects/untitled folder` (branch `main` @ `2a6d854` with 226 staged files).
* Branch: `phase-14.2`, pushed to GitHub. HEAD: see `git log -1`. `40fa357` adds the native Windows retest procedure.
* Baseline: tag `clan-beta-v0.1.0-rc1` = `6b86e7f`; integration branch `clan-astra-phase12` @ `1994793` (docs).
* Remote: `https://github.com/ashar-codes/CLAN` (PRIVATE). Pushed so far: branch `clan-astra-phase12`, tag
  `clan-beta-v0.1.0-rc1`. The Mac's active `gh` account is `ryvostudios`; use `GH_TOKEN=$(gh auth token -u ashar-codes)`
  for repo commands instead of switching the global account.

## 2. Completed in 14.2 (source, verified by tests on macOS only)
| Commit | Change | Files |
|---|---|---|
| `fd8249c` | Join tries every advertised IPv4 address and pairs once (P0-1 part 1) | `packages/protocol/src/index.ts` (`Advertisement.a`, `lanUrls`), `packages/server/src/discovery.ts`, `packages/client/src/{index,pairing}.ts` (`Candidate.alt`, `lanCarrier`), `apps/mobile/src/discovery.ts`, `packages/server/test/multi-address.test.ts` |
| `a833dd1` | Windows host never binds virtual adapters (P0-1 part 2) | `packages/server/src/netinfo.ts`, same test file |
| `bb4fb16` | Bounded desktop/mobile chat, paged catch-up and retained reading position | chat controllers/views, shared history helper, unit/desktop/native harness checks |
| `bd8f545` | Classroom teacher/everyone/approval sharing policy and private review queue | server authorization/quarantine, client result, desktop/mobile controls, regression tests |
| `249ae0c` | Native chat observation and simulated host persistence projection fixes | Android harness and simulated host mapping |
| `7d16b04` | Passive preview, native viewer choice and verified Save Copy / Android SAF | shared file-view policy, desktop IPC/views, Android native module and mobile controls |

Root causes and reasoning: [PHASE_14_2_PROGRESS.md](PHASE_14_2_PROGRESS.md) › P0-1.

## 3. Database migrations / compatibility
Server migration 8 appends `sessions.file_sharing_policy` (teacher default) and `share_uploads.approval`; prior migrations remain intact. Upload states/IDs and the whiteboard protocol are unchanged. New file policy messages require an updated host/client; fields are optional for older state messages. Protocol: the mDNS TXT gains optional `a`; old hosts/clients interoperate (missing `a` ⇒ old
ordering plus all addresses). `Candidate.alt` is optional. RC1 profiles unaffected.

## 4. Tests actually run (macOS arm64, 2026-10-11)
* PASS: `pnpm typecheck`; `packages/server/test/multi-address.test.ts` (3); `unit`, `clan`, `discovery`, `direct`
  (58); `security`, `mobile`, `integration` (60); `discovery` + `direct` re-run after the netinfo change (20).
* Codex baseline 2026-10-11: full serial unit 327/327 PASS (36 files, 242.46 s), desktop E2E 22 active PASS / 2 opt-in performance skips (269.50 s), typecheck PASS. See progress record for logs.
* NOT RUN in 14.2: Android emulator suites, installers. Run them before tagging
  (`pnpm test`, `pnpm test:e2e`, `python3 apps/mobile/e2e/android_cross_device.py` — see docs/TESTING.md).
* Windows / physical Android / iOS: **NOT TESTED**.

## 5. Security / architecture decisions
* Discovery stays untrusted: extra addresses only add *candidates*; `lanCarrier` checks the `/api/info` session id,
  then OPAQUE + pinned TLS + host approval decide. One OPAQUE attempt per host (no doubled guess counting).
* No TLS, firewall or authorization relaxation. Firewall prompts on Windows must be answered by the user.

## 6. Next actions (priority order) — exact continuation steps
1. **Windows retest of P0-1 (needs the Windows PC):** check out `phase-14.2` (after it is pushed, §8),
   `pnpm install --frozen-lockfile`, `pnpm dev`; on first host start answer the Windows Defender Firewall prompt
   **Allow, Private networks**; the Wi-Fi profile must be *Private* (`Get-NetConnectionProfile`). Host a Classroom.
   On the Mac run the same commit (`pnpm dev`) and join; on Android install an APK built from this commit
   (`NO_INSTALL=1 apps/mobile/scripts/android-dev.sh --prebuild --release`) and join. Record in `design/hardware/`.
   If it still fails, collect `ipconfig /all`, `Get-NetFirewallRule -DisplayName "*Electron*","*CLAN*"`, the Mac's
   `CLAN_DEBUG_DISCOVERY=1 pnpm dev` output (`browse up {url, alt}`), and `curl http://<windows-ip>:<bootstrap-port>/api/info`
   from the Mac.
2. **P0-2 chat implemented, Android verification in progress:** desktop `apps/desktop/src/renderer/world/chat/{ChatPanel.tsx,useChat.ts}` (has `loadEarlier`,
   unread, cursors); mobile `apps/mobile/src/Chat.tsx` (loads the latest 50 only). Scroll container + "Jump to latest",
   keep position on prepend, auto-scroll only near the bottom; mobile inverted `FlatList` + `KeyboardAvoidingView`.
   Reuse the existing messages API cursor (check `packages/server/src/chat.ts`). Tests: `apps/desktop/e2e/chat.test.ts`.
3. **P0-3 classroom file-sharing policy implemented; native UI verification pending:** server-side in `packages/server/src/{classroom.ts,shares.ts,chat.ts}`
   (capabilities via `MESSAGE_CAPABILITY` in `server.ts`); policy `everyone | approval | teacher` for `CLASSROOM` only
   (Study Group/Friends/Project keep current behaviour); a pending-share queue the host approves; tests in
   `packages/server/test/` (unauthorized and revoked senders).
4. **P0-4 preview/open/save implemented:** desktop and Android emulator checks passed; native Windows/iOS execution remains pending. See `docs/FILE_ACTIONS_PHASE_14_2.md`. Desktop "Open" remains restricted to safe types (docs/SECURITY.md); Save-as supports
   any type; mobile save via SAF (`expo-file-system` StorageAccessFramework) / share sheet, images inline, PDF via OS
   viewer. Never execute content; keep SHA-256 checks.
5. **P0-5 lifecycle:** archive (local flag), leave (member), delete (owner, confirmed), remove-local-copy with
   last-copy warnings, in `packages/clan` + desktop/mobile UI.
6. P1 (notifications, Raise Hand, persistent mobile CLANs with standby hosts and fencing epochs, Android hosting
   service, iOS) — **NOT STARTED**; write a design doc first (no owner-key transfer, no split-brain writes).
7. 14.2 installers into `Installable Files/` (docs/BUILDING.md › Beta release builds) only after the software gates
   pass. Never commit binaries.

## 7. Commands
`pnpm install --frozen-lockfile` · `pnpm typecheck` · `pnpm test` · `pnpm test:e2e` ·
`npx vitest run packages/server/test/multi-address.test.ts` · Android: `apps/mobile/scripts/android-dev.sh
--prebuild --release` (signing password from the keychain item "CLAN Android upload key"; `NO_INSTALL=1` skips adb).
Run long suites on macOS with normal QoS (e.g. `launchctl submit`); background shells time out.

## 8. Pushing
Pushed through `7d16b04` after review; native Windows feedback is pending. Exact retest: [WINDOWS_RETEST_PHASE_14_2.md](WINDOWS_RETEST_PHASE_14_2.md). For subsequent commits, review the diff (no keys, no binaries), then
`git push https://github.com/ashar-codes/CLAN.git refs/heads/phase-14.2:refs/heads/phase-14.2` with the ashar-codes
credential. Never force-push; never move `clan-beta-v0.1.0-rc1`.

## 9–11. Platform, hardware, signing
* Android: RC1 APK (versionCode 2) runs on the emulator; no native hosting yet. iOS: not built (no Xcode).
* Hardware: a Mac test session is still set up — real RC1 app with a disposable profile in `~/CLAN-hardware-test/`
  (launchd job `clan.mac-student`; stop with `launchctl remove clan.mac-student`). It never joined a Windows host (no
  handoff arrived). Windows / physical Android / classroom Wi-Fi: NOT TESTED.
* Signing: Android upload key `~/.clan-signing/clan-beta-upload.p12`, password in the login keychain; **offline backup
  not done** (docs/ANDROID_SIGNING_BACKUP.md). macOS ad-hoc; Windows unsigned. RC1 installers in
  `release/beta-v0.1.0-rc1/` (local, git-ignored) — don't modify.

## 12. Known risks
P0-1 remains hardware-unverified; Windows Firewall or a *Public* network profile could still block. Baseline full suites passed. New chat targeted desktop/unit checks passed; Android rerun is pending. P0-3 host policy and desktop UI passed 70 targeted units and 5 desktop E2Es. Pending queues stay scoped to their original session; native UI verification is pending.

## 13. Evidence
`design/beta/v0.1.0/`, `design/beta/v0.1.0-rc1/VERIFICATION.md`, `docs/RC1_HARDWARE_GATES.md`,
`docs/REAL_DEVICE_TESTING.md`, `docs/WINDOWS_SETUP.md`, `docs/BETA_READINESS.md`.

## 14. Don't repeat
Don't re-implement multi-address discovery or the Windows adapter filter; don't launch desktop builds without a
disposable `CLASSROOM_USER_DATA`; never delete or replace the keychain items "Classroom LAN Safe Storage",
"CLAN Safe Storage" or "CLAN Android upload key".

## 15. Checklist
- [ ] Push `phase-14.2` (after review) - [ ] Windows retest P0-1 - [ ] Full `pnpm test` + `pnpm test:e2e`
- [ ] P0-2 chat - [ ] P0-3 share policy - [ ] P0-4 preview/save - [ ] P0-5 lifecycle
- [ ] Android key offline backup - [ ] P1 design doc before code - [ ] 14.2 installers + hardware pack

Native chat focused checks now passed: bidirectional/persisted messages, older pages, reader position, Jump to latest. Harness fixes cover asynchronous notification prompts and Escape closing RN Modal; `tools/sim/class-peer.ts` now initializes the host local-reader mapping. Full updated-APK suites remain pending.

Updated APK full cross-device emulator suite passed (exit 0): personal sync/conflicts/revocation/private inbox,
secure join, persisted chat/history, whiteboard both ways and verified download. Android file-action runtime also
passed passive text preview, actual SAF selection/grant/streamed export plus independent hash readback, and native
viewer chooser cancellation. Physical Android and native Windows remain NOT TESTED. Android reliability suite and
final full software suites remain pending. A focused export preflight failed because the preceding peers were still
tearing down; rerun after exit passed. No timeout changes.

P0-5 is being implemented separately: archive/restore is a local presentation preference, and permission/assignment/
course/host-identity lookups retain archived membership. Core leave rejects sole owners. Desktop/mobile archive
controls and new targeted tests passed typecheck, 26 targeted units and the desktop restart/restore E2E and are being committed separately. `clans` migration 2 appends local archive preferences. Native archive UI verification is next. Destructive cleanup and live leave
coordination remain unfinished. See `docs/CLAN_LIFECYCLE_PHASE_14_2.md` before extending this work.
Xcode rechecked: Command Line Tools only, no Xcode.app. User agreed to install Xcode and complete first launch;
recheck later before marking iOS unavailable. Preserve signing and original profiles as before.

Latest continuation: `7d16b04` file actions pushed; `d636ecd` local archive/restore committed. Member leave increment
has passed 50 targeted security/lifecycle units, desktop live/offline leave E2E, typecheck and the complete native
Android lifecycle regression. New `apps/mobile/e2e/android_lifecycle.py` refuses physical devices and requires a
DISPOSABLE emulator/profile (it clears the test app data). It tests actual native controls and production transport.
Leave only removes this device's membership and requests authenticated caller-only host revocation; unavailable
hosts produce an explicit unconfirmed result. Signing identities, personal notes and receipt anchors are retained.
Next: finish remove-copy/owner delete with shared-file protection and durable tombstones, then P1 notifications/Raise
Hand and the gated hosting work. Android reliability/final full suites and candidate packaging remain pending.
Windows user reports Codex is installing, not a tested-commit/result report yet. Xcode installation was approved by
user and is pending; recheck availability later. Never interpret these setup reports as hardware PASS.

Cleanup foundation continuation: durable intents + scoped projection APIs + managed orphan collection are implemented
and tested (51 targeted units/typecheck PASS). Destructive controls remain hidden until adopted server bytes, scoped
downloads and stop-host cleanup are coordinated and tested. See lifecycle/progress docs. Candidate IDs persist in
`clans_cleanup`; never mark cleanup complete based on projection cleanup alone. File publication rechecks membership.
Xcode 26.6 is installed/selected but license is not accepted; user asked to complete first launch. Windows actual tested
commit/results still pending. No Phase 14.2 candidate packaging or completion tag yet.

Further cleanup preparation: server `purgeStoppedSessions` only accepts stopped validated scopes and preserves adopted
Resource Store bytes before removing UUID-owned server files/history. Desktop `removeSessionCopies` stops scoped jobs,
serializes index updates and protects changed/shared/exported files. Authenticated session IDs persist in clans migration
4. Helpers pass 33 targeted units/typecheck and 8 desktop regressions; removal UI/coordinator and native cleanup remain
unfinished. Do not advertise helpers as complete erasure. Legacy unowned partials cannot be deleted by title guessing.
Xcode user completed first launch; SDKs now query successfully. CocoaPods installing; isolated `ios-build.sh` is prepared
but not yet executed. It compiles unsigned .app, never an IPA or signing identity change. Check logs/progress for evidence.

Desktop remove/delete controls now passed typecheck and two real Electron E2Es (owner changed-file failure/retry,
last-copy warning, restart/rehost fence, private/original retention; member secure join, owner refusal, scoped removal,
restart/cache/reconnect and intact remote host). Mobile cleanup controls/tests remain next. See lifecycle doc for exact
scope and conservative legacy/edited/exported retention. Pending intent must never be cleared because cleanup failed.
Isolated iOS build running from `/Users/ashar/clan-ios-build`, session log `/tmp/clan-142-ios-build1.log`;
prebuild/codegen PASS, pod dependency download ongoing, native compile unverified. CocoaPods 1.17.0 installed, SDKs
available, simulator runtime absent. Dedicated Android launchd job stopped for memory; AVD/profile retained and may
be restarted for the next genuine Android regression. Original checkout/signing/application profiles preserved.


Latest iOS result supersedes earlier build-running notes: Expo prebuild/codegen and CocoaPods install PASS;
xcodebuild FAIL/BLOCKED (missing iOS 26.5 platform/destination), confirmed by showdestinations. Native compile,
simulator execution, signing and IPA remain unverified. User has been asked for platform-component installation.
Use isolated `apps/mobile/scripts/ios-build.sh`; see BUILDING.md. Do not rerun CocoaPods setup unnecessarily.


Current storage interruption: free disk reached ~790MiB. Dedicated emulator `clan.phase142.emu` and the owned native
lifecycle test/peer were stopped safely; profile/AVD retained. Mobile cleanup implementation + post-leave stored-copy
controls are present. Typecheck/target contracts and desktop E2Es PASS; native run1 FAIL (empty card hid completion),
fixed; run2 INTERRUPTED exit130 before verifying fix. Do not call native cleanup PASS. See lifecycle/progress docs.
User requested to free >=15GB; no further large builds/tests until space is available. Xcode now DOES recognize iOS26.5
and iPhone17 simulator; component installation resolved, compile still pending. Recheck storage, restart only the
owned emulator, rerun android_lifecycle.py, then attention/sharing and final gates. No physical Windows results yet.

# BTC-2A verification record — 2026-10-13

Branch: `btc-2a-universal-lan`; parent BTC-1 checkpoint `fd33b95e3793c26de49c05ec8b0b835356e52fa6`. Software implementation checkpoint: `4b0ad6b8de1f6d9e306b7daf6a7cd7b7ae336e7f`; subsequent documentation checkpoints identify this immutable source. No BTC-1 installer, installed application, profile, private identity or signing material was replaced. PRs #1–#4 remain open drafts, with their ancestry unchanged.

## Implemented and repaired

Opt-in pinned HTTPS administrator directory, signed public-key enrollment/lookup, replay protection, expiring rotating hints, bounded requests and private-address validation. Existing anonymous public-profile probes and authenticated peer handshakes remain mandatory. Directory hints appear in desktop/mobile CLAN and People Radar with separate reachability state. Existing netmask/working-route ordering, coalesced dials, duplicate-session arbitration, retry/backoff, network-change wakeups and native availability/resume paths reuse the encrypted outbox and recipient receipts. The directory does not forward messages/files or bypass firewalls.

Repairs found by regression testing:

- Link-first desktop QR adoption omitted the authenticated TLS route binding needed after restart. Advertised HTTPS first contact is retained; encrypted, expected-key link fallback works when HTTPS is unreachable.
- The forged-QR fixture still pointed its alternate link at the genuine peer. Both carriers now point at the impostor; rejection and no-impostor-profile assertions remain mandatory.
- Late handshakes could resurrect stopped networking; simultaneous dials and shutdown are fenced, stopped states become Offline, and blocked active links close before flushing.
- A privacy change during a directory round could lose its forced refresh. One following round now publishes the newest visibility/configuration.
- A malformed saved certificate could abort desktop networking after being persisted. Candidate transports validate before replacement, invalid startup settings leave direct networking available, and write failures restore the previous runtime configuration.
- Concurrent multicast refreshes could create an orphan publisher and leave Invisible visible. Publication is serialized and rechecks current visibility after asynchronous goodbye; the existing visibility disappearance E2E remains unchanged.

## Automated software evidence

| Check | Actual result |
|---|---|
| All four TypeScript projects | PASS, including final privacy fix |
| Full unit/integration suite | PASS: 63 files / 470 tests at final implementation `4b0ad6b` (135.17 seconds); preceding full run also passed 470; 8 affected tests separately passed after publication repair |
| Repeated targeted directory/peer security and delivery | PASS: 23 tests; previous 21-test checkpoint also repeated successfully |
| Complete macOS Electron E2E, GPU/screen capture enabled (`PERF=1`) | PASS: final implementation `4b0ad6b`, 24 files / 41 tests, 497.93 seconds, 0 FAIL / 0 SKIPPED; earlier full 40-test run also passed |
| New directory consent and People/media E2E subset | PASS: earlier 2 files / 6 tests; later run exposed orphan multicast publisher (5 PASS / 1 FAIL), repaired and rerun without weakening assertions |
| Linux + native Windows CI | PASS at `9b22341`: typecheck/build and 20 core tests on both OSes; Windows actual Electron 6 E2Es; Linux real routed and bridged namespace fixtures. Final revision CI recorded below |
| Android native Gradle | PASS: `:app:assembleQa` at `4e2ac4e` (final mobile sources), 1,037 tasks, bundled JavaScript and native arm64 modules, debug TEST signing; subsequent `4b0ad6b` changes desktop publication only |
| Android API 36 disposable emulator integration | PASS at `e579917`: encrypted storage, approved two-way device sync, offline edits/Keep Both convergence, revocation refusal, private sharing, OPAQUE/pinned classroom join, two-way chat/pagination, whiteboard and SHA-verified download |
| Android final emulator repeat | FAIL / environment blocker: restart reports “No initial system image for this configuration”; SDK API 36 directory lacks system/vendor/ramdisk images. No physical phone, original AVD or user data was modified; earlier successful emulator run is not presented as final-revision physical validation |
| iOS native Xcode compilation | PASS: Xcode 26.6 Release iOS simulator native build, including changed Swift redirect policy, at implementation checkpoint `e579917` |
| iOS final-source JavaScript | PASS: actual iOS Hermes export from `4e2ac4e`, after mobile lifecycle fixes; no Swift changes since native compilation |
| iOS simulator startup | FAIL: unsigned build SecureStore Keychain `-34018` (“A required entitlement isn’t present”); disposable ad-hoc entitlement attempts verified their signature but were refused at launch. No valid Apple Team/provisioning available; no IPA claimed |
| iOS UI persistence suite | NOT TESTED: resource-limited run interrupted before assertions; simulator startup blocker remains |
| Full Git history / staged secrets | PASS: redacted Gitleaks; final history scan recorded below |
| Dependency audit | Unresolved: 0 critical, 2 high, 2 moderate; see security findings |

No test assertions were weakened or silently skipped. CI OS-specific steps are explicitly SKIPPED on the other OS; all physical BTC-2A multi-router/device tests are NOT TESTED. Desktop test media uses fake capture devices; it proves media transport/signaling, not physical microphone quality or actual audio across VLANs.

Local evidence logs remain outside Git under `/tmp/clan-btc2a-*`: `full-tests-lifecycle.log`, `typecheck-final-privacy.log`, `privacy-unit.log`, `e2e-final-all.log`, `android-lifecycle-build.log`, `android-integration.log`, `ios-build.log`, `ios-final-js.log`, `ios-runtime-final.log`, `audit.json` and redacted secrets logs. These are disposable evidence, not application data.

## Network topologies

| Topology | Verified setup / result | Physical result |
|---|---|---|
| A: same subnet | PASS: real TCP/TLS peer tests and virtual bridged subnet | NOT TESTED physically at BTC-2A |
| B: separate bridged APs | PASS: real multicast discovery/TCP across Linux virtual Ethernet bridge, directory disabled | NOT TESTED on physical Wi-Fi APs |
| C: routed internal subnets | PASS: separate Linux network namespaces on two /24 networks, explicit permitted routing, encrypted peer traffic | NOT TESTED on physical routers/VLANs |
| D: cross-subnet directory | PASS: real pinned TLS directory discovery across those routed networks, followed by authenticated peer sessions | NOT TESTED physically |
| E: isolation | PASS: real virtual link cut; no recipient delivery acknowledgement while unreachable; queued items retained | NOT TESTED physically |
| F: disconnect / IP change / reconnect | PASS: receiver IP changes in both fixtures; queued text, consented file/voice attachment bytes, SHA verification, recipient receipts, live call signaling and no duplicate message | NOT TESTED physically |

A/B use virtual Ethernet, not real access points. C–F use real kernel routing/sockets, not fabricated reachability. Coordination markers only synchronize test phases; payloads travel over network sockets. Voice attachment fixture bytes exercise transfer integrity, not codec playback. Classroom hosting, OPAQUE auth, handover/rollback fencing, revocation, existing board/files/chat and calls remain covered by the full regression suites.

## Security findings and limits

Directory requests are enrolled-key signed and certificate pinned; nonces/timestamps, method/path/body/recipient binding, body/response limits, private endpoint validation, expiry and redirect refusal are tested. Advertisement enrollment never grants peer identity or CLAN host authority. Unknown profile probes remain anonymous. Blocking, consent and SHA verification remain required. Invalid settings and stale async operations fail safely.

The administrator is explicitly trusted and sees enrolled public keys/listening addresses. The global 240-request/minute budget is appropriate only for a small controlled deployment and can be exhausted by hostile internal callers. Native transports buffer responses before the 128 KiB parsed-response check and do not honor the JS five-second abort uniformly. Use administrator-controlled ingress; this is not a public or campus-scale hardened relay. Existing local-storage encryption/forensic-deletion limitations documented in SECURITY.md are unchanged.

Inherited build/development dependency advisories remain unresolved: high [node-forge RSA issue](https://github.com/advisories/GHSA-86w9-cpqp-85rv) via Expo signing tooling; high [braces ReDoS](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) via Metro glob tooling; moderate [uuid buffer disclosure](https://github.com/advisories/GHSA-w5hq-g745-h8pq) via Xcode tooling; moderate [sprintf-js prototype pollution](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) via builder logging. Registry checks did not offer the suggested node-forge/braces/sprintf patched versions. No safe unverified dependency replacement was made; production directory authentication uses Node TLS/Ed25519, and no new exploitable network-input path into those build dependencies was identified. This is not a clean dependency scan or public-release approval.

Directory forwarding, unicast DNS-SD proxy integration, Internet relay/push/TURN and native IPv6 hardware validation are incomplete. Directory configuration restricts endpoints to RFC1918 IPv4 / IPv6 ULA; publicly allocated internal networks need a future reviewed configuration policy or existing trusted manual transport. Windows routed inbound rules require narrow administrator authorization. Android Keep is opt-in with a persistent foreground notification and OEM power limits. Suspended iOS cannot promise continuous LAN listening; resume/reconnect remains the supported behavior.

## Completion and hardware handoff

Networking implementation has real virtual bridged/routed and security/delivery evidence. **Hardware/platform completion remains BLOCKED** by physical network validation and iOS signing/runtime. BTC-1 Desktop packages remain byte-for-byte intact and do not contain BTC-2A features; no installer regeneration or public release is authorized in this stage.

Use the identical final branch revision with disposable profiles for [the eight hardware checks](BTC_2A_LAN_DIRECTORY.md#verification-and-hardware-handoff): same LAN; bridged AP roaming; administrator-approved routed QR connection; directory enrollment/discovery; isolated routes; restore/IP change/queued transfers; Android Keep/lock + desktop tray + restart + signed iOS resume; blocking/revocation and classroom handover fencing. Record each OS pair separately. Resolve the iOS Apple-Team Keychain/App Group/Hotspot capabilities before device tests. Restore the missing Android system image through SDK Manager before repeating emulator tests; do not wipe original AVD data or user profiles.

## Final checkpoint evidence

PASS: [final implementation CI](https://github.com/ashar-codes/CLAN/actions/runs/38300212005), source `4b0ad6b`: 21 core tests on each OS, Windows 6 actual Electron E2Es, and real routed + bridged network fixtures. The intermediate `4e2ac4e` CI reproduced the multicast privacy defect (Windows 5 PASS / 1 FAIL); the final fix passes that unchanged assertion. PASS: final redacted Gitleaks history scan, 131 commits / 5.89 MB, no leaks. All four BTC-1 Desktop package SHA-256 hashes match their protected originals. PASS: final complete local unit/integration suite, 63 files / 470 tests (135.17 seconds, 0 FAIL / 0 SKIPPED); complete Mac Electron suite with `PERF=1`, 24 files / 41 tests (497.93 seconds, 0 FAIL / 0 SKIPPED). Final available disk: 12.10 GB (11.27 GiB), measured with statvfs. Disk readings fluctuate with build memory/swap; no original caches, tools, installers or signing material were deleted. Only disposable test-clone intermediate outputs were reclaimed during the session.

## Changed-file inventory

- `.github/workflows/btc2a-network.yml`
- `apps/desktop/e2e/lan-directory.test.ts`
- `apps/desktop/src/main/lan-directory.ts`
- `apps/desktop/src/main/main.ts`
- `apps/desktop/src/main/people-runtime.ts`
- `apps/desktop/src/main/people.ts`
- `apps/desktop/src/preload/preload.ts`
- `apps/desktop/src/renderer/world/Commons.tsx`
- `apps/desktop/src/renderer/world/Radar.tsx`
- `apps/desktop/src/renderer/world/people/NearbyPeople.tsx`
- `apps/desktop/src/shared.ts`
- `apps/desktop/test/lan-directory-runtime.test.ts`
- `apps/mobile/modules/pinned-transport/android/src/main/java/expo/modules/pinnedtransport/PinnedTransportModule.kt`
- `apps/mobile/modules/pinned-transport/ios/PinnedTrust.swift`
- `apps/mobile/src/Shell.tsx`
- `apps/mobile/src/discovery.ts`
- `apps/mobile/src/people/directory.ts`
- `apps/mobile/src/people/native.ts`
- `apps/mobile/src/people/nearby.ts`
- `apps/mobile/src/screens/People.tsx`
- `docs/BTC_2A_LAN_DIRECTORY.md`
- `docs/BTC_2A_RESULTS.md`
- `docs/BTC_2_DISK_CLEANUP.md`
- `docs/BTC_2_PLAN.md`
- `docs/CODEX_HANDOFF_PHASE_14_3.md`
- `docs/PHASE_14_3_ARCHITECTURE.md`
- `docs/SECURITY.md`
- `packages/clan/src/modules/people/link.ts`
- `packages/clan/test/people-link.test.ts`
- `packages/clan/test/people-transport.test.ts`
- `packages/client/src/index.ts`
- `packages/client/src/lan-directory.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/lan-directory.ts`
- `packages/server/src/discovery.ts`
- `packages/server/src/index.ts`
- `packages/server/src/lan-directory.ts`
- `packages/server/test/lan-directory.test.ts`
- `tools/sim/lan-directory.ts`
- `tools/sim/lan-topology.sh`
- `tools/sim/lan-topology.ts`

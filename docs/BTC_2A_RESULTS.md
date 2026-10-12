# BTC-2A verification record

Branch: `btc-2a-universal-lan`. Parent: `fd33b95e3793c26de49c05ec8b0b835356e52fa6`. Revision under test is the branch implementation checkpoint; final evidence is appended after CI/local runs complete. No BTC-1 installer, installed application, profile or signing identity is replaced.

## Implemented

Opt-in certificate-pinned, signed/enrolled, expiring internal LAN directory; actual peer handshakes independent of discovery; directory CLAN/People hints in desktop and mobile Radar; public administrator configuration and privacy consent; working-route/netmask ordering, bounded/coalesced dials, shutdown/block fencing, native Android background refresh and resume/roaming retries. Existing encrypted outboxes and receipt/attachment/call contracts are reused.

## Initial verification

- PASS: all four TypeScript projects after fixes.
- PASS: first targeted directory/peer-link/integration run, 15 tests.
- PASS: Android `:app:assembleQa`, 1,037 native Gradle tasks, including bundled JS, arm64 and debug TEST signing. Output remains a local development build; Desktop installers unchanged.
- FAIL, diagnosed: broad test's forged QR left a valid authenticated alternate link. Fixture now substitutes both target carriers; rejection assertion retained. Restart delivery exposed the new link-first QR path omitting TLS route binding; HTTPS QR first-contact is retained where advertised, with authenticated link fallback when HTTPS is unreachable.
- FAIL, environment: relocated iOS precompiled module cache retains original absolute path. Only the new disposable clone's ModuleCache was removed; original QA caches/project preserved. Recompilation pending.
- Pending: repeated targeted tests, final full suite, complete Electron E2E with PERF=1, dependency audit and actual routed Linux CI fixture.

## Topology and platform distinctions

| Scenario | Evidence at initial checkpoint |
|---|---|
| A same-subnet | Existing real loopback TCP/TLS tests pass; physical LAN BTC-1 user evidence is historical, not BTC-2A hardware validation |
| B bridged Wi-Fi APs | NOT TESTED physically; multicast discovery unchanged |
| C routed subnets | CI fixture prepared; pending actual run |
| D enrolled directory | PASS real pinned TLS and People runtime on loopback; routed fixture pending |
| E isolation | PASS malformed/untrusted discovery refusal; actual disconnected routed fixture pending |
| F outage/IP change | PASS real TCP listener replacement/queued receipt/no-duplicate regression; routed fixture pending |
| macOS | Source Electron E2E pending; installed BTC-1 app untouched |
| Windows | Native runner software tests pending; physical NOT TESTED |
| Android | Native Gradle PASS; BTC-2A emulator/physical network NOT TESTED |
| iOS | Native compilation retry pending; simulator network/physical NOT TESTED |

Gateway forwarding, unicast DNS-SD proxy integration, Internet relay/push and native IPv6 hardware validation remain incomplete. See [deployment/security contract](BTC_2A_LAN_DIRECTORY.md). The small directory has bounded global capacity and trusts its administrator; do not deploy it publicly. Native response buffering/cancellation remains a transport limitation. Neither hints nor virtual topology tests establish physical-router release readiness.

Hardware steps: follow the eight sequential checks in the directory document, record PASS/FAIL for each OS pair, and test blocked VLANs through an administrator-approved lab. Windows routed ingress requires an explicit narrow administrator rule. iOS resumes/reconnects; it cannot promise continuous suspended listening. Android Keep is opt-in and must show its foreground notification.

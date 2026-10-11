# Phase 14.2 progress

Branch `phase-14.2` in worktree `/Users/ashar/clan-astra-phase12` (from `clan-astra-phase12` @ `1994793`, which is
tag `clan-beta-v0.1.0-rc1` + one docs commit). Status values: PASS (executed), FAIL, NOT TESTED, NOT STARTED.

| # | Item | State | Commit | Evidence |
|---|---|---|---|---|
| P0-1 | Windows-hosted CLAN: Mac/Android discover but can't connect | **Fixed in source, NOT TESTED on Windows** | `fd8249c`, `a833dd1` | `packages/server/test/multi-address.test.ts` (3 PASS); join/discovery/security/mobile/integration suites 138 PASS; typecheck PASS |
| P0-2 | Chat scrolling/pagination/jump-to-latest (desktop + mobile) | NOT STARTED | — | — |
| P0-3 | Classroom student file-sharing policies (everyone / approval / teacher only) | NOT STARTED | — | — |
| P0-4 | File preview / open / save-export (SAF, iOS Files) | NOT STARTED | — | — |
| P0-5 | CLAN archive / remove from device / leave / delete | NOT STARTED | — | — |
| P1-6…10 | Notifications + Raise Hand, persistent mobile CLANs (standby hosts, epochs), Android hosting, iOS parity, installers | NOT STARTED | — | — |

## P0-1 root cause and fix
Two independent source defects, both consistent with "Windows host is discovered but nobody can connect" and
neither visible on a Mac host:
1. **Clients used the first advertised address.** mDNS (bonjour-service) publishes A records for *all* the host's
   IPv4 addresses; `packages/server/src/discovery.ts` (desktop) and `apps/mobile/src/discovery.ts` (phone) took the
   first. On Windows that is often a WSL/Hyper-V/VMware/hotspot adapter. Fix: hosts add TXT `a` = bound address;
   browsers keep all usable IPv4 addresses (`lanUrls`, preferred first) and `lanCarrier` (`packages/client/src/pairing.ts`)
   probes `GET /api/info` on all, pairing once with the first that reports the expected session. OPAQUE + pinned
   TLS still decide authenticity; older (RC1) hosts without TXT `a` also benefit.
2. **The Windows host could bind a virtual adapter.** `candidateInterfaces()` only filtered Unix adapter names;
   Windows names (VMware, VirtualBox, `Local Area Connection*` hotspot, Bluetooth, Hyper-V, Teredo…) passed with the
   same score as the real adapter. Fix: Windows patterns excluded, `Ethernet`/`Wi-Fi` preferred. Direct Mode unaffected
   (binds the helper-provided address).

Not yet ruled out on real hardware: Windows Defender Firewall when running `pnpm dev` (no installer rules: Windows
asks once per program — "Allow" on Private networks is required; a dismissed prompt blocks inbound), and Wi-Fi
profile set to *Public*. See the retest procedure in `docs/CODEX_HANDOFF_PHASE_14_2.md`.

## Codex continuation (2026-10-11)

Preflight confirmed clean isolated worktree on `phase-14.2` at `4a7dcaa`; original staged checkout, release tags,
signing material and application profiles preserved. Reviewed both Windows fixes. `phase-14.2` is on GitHub;
`40fa357` adds [the exact native Windows retest](WINDOWS_RETEST_PHASE_14_2.md). Physical Windows connectivity is
**NOT TESTED** pending Windows Codex feedback.

Baseline: typecheck PASS; complete serial unit suite **327/327 PASS**, 36 files, 242.46 s.
Desktop E2E **22/22 active PASS**, two opt-in performance cases skipped, 269.50 s. The first unit invocation was interrupted after command-line arguments were incorrectly
placed after `--` and Vitest started parallel workers; the corrected full serial run above passed.
Logs: `/tmp/clan-142-typecheck.log`, `/tmp/clan-142-unit-baseline-serial.log`, `/tmp/clan-142-e2e-baseline.log`.
No timeouts were increased. The [P1 hosting design](PHASE_14_2_HOSTING_DESIGN.md) defines authorization, durable
relinquishment, replication and fencing gates before implementation.

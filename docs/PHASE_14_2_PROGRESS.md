# Phase 14.2 progress

Branch `phase-14.2` in worktree `/Users/ashar/clan-astra-phase12` (from `clan-astra-phase12` @ `1994793`, which is
tag `clan-beta-v0.1.0-rc1` + one docs commit). Status values: PASS (executed), FAIL, NOT TESTED, NOT STARTED.

| # | Item | State | Commit | Evidence |
|---|---|---|---|---|
| P0-1 | Windows-hosted CLAN: Mac/Android discover but can't connect | **Fixed in source, NOT TESTED on Windows** | `fd8249c`, `a833dd1` | `packages/server/test/multi-address.test.ts` (3 PASS); join/discovery/security/mobile/integration suites 138 PASS; typecheck PASS |
| P0-2 | Chat scrolling/pagination/jump-to-latest (desktop + mobile) | IMPLEMENTED; desktop PASS, Android verification in progress | see git log | 4 desktop E2Es + 17 targeted unit tests PASS |
| P0-3 | Classroom student file-sharing policies (everyone / approval / teacher only) | IMPLEMENTED; host + desktop PASS, native UI pending | see git log | 70 targeted units + 5 desktop chat/sharing E2Es PASS |
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

## P0-2 chat implementation

Desktop chat has a bounded internal scroll area, reader-position preservation when older pages load, and Jump to
latest. Mobile uses a full-screen keyboard-aware modal with an inverted FlatList, older-page loading, explicit
Retry/Discard for failed sends, and durable idempotent retries. Read receipts require a visible conversation and an
active app. Shared catch-up walks all 200-message pages and reloads edits/removals at their original sequence.
No chat domain, whiteboard protocol or permission checks were replaced.

PASS: typecheck; 17 targeted unit cases (4 history/catch-up and 13 existing secure-host chat cases);
final desktop chat E2E **4/4 PASS** (41.97 s), including widths 1440/1024/390/360, pagination and live arrivals while
reading. An earlier E2E revealed a genuine 26px scroll shift caused by anchoring a day separator; anchoring the
message article fixed it. Logs `/tmp/clan-142-chat-unit-final.log`, `/tmp/clan-142-chat-typecheck4.log`,
`/tmp/clan-142-chat-e2e-final.log`.

Android release APK built with the existing signing identity, installed on a fresh dedicated `clan_phase142` AVD
(no original emulator/user profile reused). First cross-device run passed personal sync/conflicts/revocation and
secure joining, then failed to open chat. The harness incorrectly searched for absent OS prompt buttons while
scrolling and accepted the room preview as chat evidence. A focused native check opened the modal successfully.
The harness now handles only a visible OS prompt and verifies Close chat; a full rerun is in progress. No timeout
was increased. Emulator results do not establish physical Android performance or connectivity.

## P0-3 classroom student file sharing

Classroom defaults to teacher-only. The host may select Everyone or Teacher approval; permission changes reach
connected students immediately. Other CLAN types retain their existing defaults. Approval uploads are checksum-verified
and quarantined in host temporary storage without a resource/manifest/download until approved. The host sees a bounded
queue and may approve/decline; duplicate approval returns the same resource. Authorization is checked at initiation,
resume, final upload, and immediately before resource publication, including removal during asynchronous copying.
Pending clients return an explicit approval result rather than endlessly uploading a completed file.

Database migration 8 appends the session policy and upload approval columns. Existing upload states, IDs, byte/hash
validation and authenticated transport remain unchanged. This is a live-session policy; new sessions default to the
safer teacher-only rule. Pending review is scoped to its originating session and remains stored if that session ends.
Cross-host transfer of such queues belongs to the separately gated durable hosting design.

PASS: typecheck; **70/70** targeted sharing/chat/security/data-safety unit tests (32.12 s);
**5/5 desktop chat/sharing E2Es** (51.96 s). Tests cover real HTTP credentials, WSS privilege denial, cross-session review,
checksum failure, duplicate approval, policy change and removal during copying, plus live controls/table visibility.
Logs `/tmp/clan-142-sharing-typecheck2.log`, `/tmp/clan-142-sharing-unit2.log`, `/tmp/clan-142-sharing-e2e1.log`.
Native UI changes still require an updated APK and emulator verification. Physical devices remain NOT TESTED.

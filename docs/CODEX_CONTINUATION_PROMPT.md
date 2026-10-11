# Paste this into Codex

You are continuing CLAN Phase 14.2 (cross-platform classroom fixes) on the Mac. Work in the isolated worktree
`/Users/ashar/clan-astra-phase12`, branch `phase-14.2`. Never modify `/Users/ashar/Desktop/My Projects/untitled folder`
(original checkout with staged files), release tags (`clan-beta-v0.1.0-rc1` and earlier), signing material
(`~/.clan-signing`, keychain items "CLAN Android upload key", "Classroom LAN Safe Storage", "CLAN Safe Storage") or real
user data. Always launch desktop builds with a disposable `CLASSROOM_USER_DATA`.

First read, in order: `docs/CODEX_HANDOFF_PHASE_14_2.md` (state, decisions, exact next steps),
`docs/PHASE_14_2_PROGRESS.md`, `docs/REAL_DEVICE_TESTING.md`, `docs/WINDOWS_SETUP.md`, `docs/SECURITY.md`,
`docs/TESTING.md`. The repository and its tests are the source of truth.

Done already (don't redo): P0-1 source fixes for "Windows-hosted CLAN is discovered but Mac/Android can't connect"
(`fd8249c` multi-address join via `lanUrls`/`lanCarrier`; `a833dd1` Windows virtual-adapter filter). They are
NOT TESTED on Windows.

Do next, in order, one small verified commit per item (tests first, then `pnpm typecheck` and the relevant suites;
record PASS / FAIL / NOT TESTED honestly in `docs/PHASE_14_2_PROGRESS.md`):
1. Run the full `pnpm test` and `pnpm test:e2e` on this branch; fix regressions you caused before anything else.
2. P0-2 chat scrolling/pagination/jump-to-latest on desktop and mobile (existing chat storage and APIs only).
3. P0-3 Classroom file-sharing policy (everyone / teacher approval / teacher only), enforced on the host server; other
   CLAN types unchanged.
4. P0-4 file preview / open with / save-export for any permitted file (SAF on Android); never execute content.
5. P0-5 CLAN archive / remove from device / leave / delete, with confirmations and last-copy warnings.
Then P1 (notifications + Raise Hand; persistent mobile CLANs with standby hosts and fencing epochs; Android hosting
service; iOS) — design doc first.

Rules: security → correctness → simplicity. No TLS/OPAQUE/approval/firewall bypasses, no cloud services, no
force-push, no binaries or secrets in Git. Windows, physical Android and iOS results count only when executed on that
hardware. Push only `phase-14.2` (after reviewing the diff for secrets) using the `ashar-codes` GitHub account:
`GH_TOKEN=$(gh auth token -u ashar-codes)`. Keep `docs/CODEX_HANDOFF_PHASE_14_2.md` updated before you stop.

# v0.1.0 release evidence (Phase 14)

Emulator: Android 16 arm64 (Pixel profile), `adb root` image. Host: the build Mac. "Staged" = the first beta-signed
APK (before `SYSTEM_ALERT_WINDOW` was blocked); "final" = the shipped `CLAN-0.1.0-android-arm64.apk`.

| Log | APK | Suite | Result | Notes |
|---|---|---|---|---|
| `up2.txt` | staged → test 0.1.1 | upgrade | PASS | |
| `upF.txt` | final → test 0.1.1 | upgrade | PASS | data, Diary, device identity, signed sync kept; debug-key APK refused |
| `relB1.txt` | staged | reliability | PASS | |
| `relF.txt` | final | reliability | PASS | |
| `xdB1.txt` | staged | cross-device | PASS | |
| `xdF.txt` | final | cross-device | FAIL | phone whiteboard text not seen by host in 40 s (ran while packaged-app probes ran) |
| `xdF2.txt` | final | cross-device | FAIL | same step |
| `xdF3.txt` | final | cross-device | FAIL | harness: previous run's host still held port 47499 (`EADDRINUSE`) — fixed |
| `xdD.txt` | final | cross-device | PASS | host instrumented to log who ends the CLAN |
| `xdD1.txt` | final | cross-device | FAIL | whiteboard text step; the "CLAN has ended" screen was the suite's own teardown (shown after peers stop) |
| `xdD2.txt` | final | cross-device | FAIL | harness `EADDRINUSE` |
| `xdC1.txt` | final | cross-device | PASS | after an emulator cold boot |
| `xdC2.txt` | final | cross-device | FAIL | harness `EADDRINUSE` |
| `xdE1.txt` | final | cross-device | FAIL | text step passed; "file downloaded" step: the page never scrolled to Download (`xdE1-failure.png`) |
| `xdE2.txt` | final | cross-device | FAIL | onboarding: system-wide ANRs (launcher and system_server too) while the Mac ran at load ≈ 20 with thermal throttling (`xdE2-failure-anr.png`) |
| `icF.txt` | DMG app → 0.1.1 | macOS install/update/rollback | PASS | identity keys kept; two earlier attempts timed out on a new build's first launch |

The harness bug (back-to-back runs) is fixed: peers are waited for, and a peer that can't start fails the run.
Failure screenshots are now taken before the peers stop. The three whiteboard-text timeouts are **not explained**:
the step works in other runs (xdD, xdC1, xdE1), but a product cause has not been ruled out — re-run the suite on an
idle machine and on a physical phone before the beta goes out.

## Desktop / unit verification (Phase 14)

| Log | Run | Result | Load (1/5/15 min) |
|---|---|---|---|
| `desktop-unit14.txt` | full unit + typecheck | typecheck OK · 318/321 (3 timeouts) | ≈ 16–20 |
| `desktop-e2e14-1.txt` | full desktop E2E | 20/22 (+2 PERF skipped) — 2 timeouts | ≈ 20–24 |
| `desktop-e2e14-2.txt` | full desktop E2E | 18/22 — 4 timeouts | ≈ 20 |
| `desktop-ab.txt` | same 3 E2E files, Phase 13 tag vs this tree, alternating | tag: 1 and 2 failures · this tree: 2 and 2 | ≈ 12–21 |
| `desktop-u3.txt`, `desktop-rr.txt` | targeted re-runs | still timing out | 12 → 87 (orphaned test apps, below) |
| `desktop-fin.txt` | full unit | 303/321 — 18 timeouts (OPAQUE/Argon2, 100-peer transfer, SFU) | ≈ 15–19 |

The host was overloaded during all of these: a Chrome renderer at 100–145 % CPU, `kernel_task` at 140–165 %
(thermal throttling), load 15–87. No code under `packages/` or `tools/` changed since `clan-beta-hardening`, where all
321 unit and 22 E2E passed; only 6 lines of desktop main-process code changed (test switches ignored when packaged).
The A/B run shows the Phase 13 tag failing the same way on this machine. Timed-out E2E tests also left 4 orphaned
Electron apps running (load 87); `e2e/global-teardown.ts` now stops Playwright-launched apps after every suite.
**Not re-verified on an idle machine — required before distribution:** `pnpm test && pnpm test:e2e`.

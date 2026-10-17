# Screen sharing verification

Source `d5a154d` (branch `fix/screen-sharing-and-presentation-ux`). Legend: **PASS** · **FAIL** · **NOT TESTED** (needs
hardware or a person) · **BLOCKED**.

## Real capture — no test pattern
"Real" means: the source was chosen in CLAN's picker, the OS captured it, it was published through the bundled LiveKit SFU
over the pinned TLS media path, and a **second CLAN instance** sampled its `<video>` and saw changing frames. The source is a
helper window drawing green, changing frames, so a test pattern (navy/burgundy, development only) cannot pass.

| Check | macOS 26 (this Mac) | Windows (GitHub windows-2025) |
|---|---|---|
| Original bug reproduced on the **installed** QA app (permission granted, sources listed, `getDisplayMedia` → `NotAllowedError`) | PASS (reproduced) | — |
| Minimal Electron 44 repro: refused as shipped / live 3024×1964 `monitor` track with the fix | PASS | — |
| `e2e/screen-real.test.ts` (development build, real capture) | PASS (`CLAN_REAL_CAPTURE=1`); **fails with the old handler** (presenter bar never appears) | PASS (run 39011141098) |
| `e2e/packaged-screen.mjs` on the **packaged** app: window, then entire screen, received live by a second packaged instance; fullscreen; + menu; note saved during playback; Stop ends capture | PASS 5/5 on the `d5a154d` build (window 576×360–1280×800, 6–7/7 distinct frames; screen 1662×1078, 7/7) | PASS in the installed app (run 39011140981: window 626×392, 7/7; screen 1024×768, 7/7) |
| Capture stages recorded (picked → permission granted → handler ran → source found) | PASS (asserted in the packaged check) | PASS |

macOS authorization note: the packaged checks were started from Terminal, so macOS applied Terminal's Screen Recording
grant. The packaged binary did the capture itself. The new build's **own** grant (ad-hoc signature) must be approved by
you once after installing (SCREEN-SHARING-TEST-GUIDE.md §0). That step was not done for you.

## Automated (all platforms)
| Area | Result |
|---|---|
| Capture error classifier: OS denial, stale grant after update, source removed, expired/no pick, start failure, host refused, server unreachable, publish failure (`test/capture-error.test.ts`) | PASS 6/6 |
| No silent capture without a pick; forged source id refused (`e2e/screen.test.ts`) | PASS |
| Cancelled picker starts nothing; switch source without ending; stop → wall returns; Leave view / Watch again | PASS |
| Classroom: request → host allows → present → host stops; approval covers one presentation | PASS |
| Wrong capture ticket for remote control (`control:screen`) | PASS (existing remote-control E2E) |
| Fullscreen entry/exit, + menu items, note saved, note private (not in chat), autosave when the presentation ends while editing | PASS (real-capture E2E + packaged check) |
| Media token/publish failure → named error, `present.stop`, no false active presentation | Covered by classifier + existing code path; not fault-injected |
| Presentation reconnection after a dropped media connection | Existing `media.test.ts` / meeting E2E PASS; real network interruption NOT TESTED |

## Regression
| Suite | Result |
|---|---|
| macOS unit/integration | PASS 81 files, 563 tests (4 opt-in skips) |
| macOS Electron E2E (30 files incl. real capture) | PASS 29 + 1 conditional skip. One whiteboard join timed out once and passed 3/3 on rerun (approval timing, not screen code) |
| Linux + Windows unit, full Windows Electron E2E, discovery matrix (run 39011141098) | PASS |
| Windows installer: install, launch, profile lock, **packaged real screen sharing**, uninstall, firewall preservation (run 39011140981) | PASS |
| macOS packaged profile lock / identity preservation | PASS 3/3 |

## NOT TESTED (needs your hardware)
Mac ↔ Windows and Windows ↔ Mac across two physical computers; desktop → Android phone viewer, Android fullscreen + notes;
network interruption during a presentation; multi-monitor fullscreen; the macOS permission step for the newly installed
build. Use SCREEN-SHARING-TEST-GUIDE.md.

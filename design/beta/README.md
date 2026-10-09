# Phase 13 evidence

All Android numbers come from the emulator (Android 16 arm64, Pixel profile, release build, `-gpu host`) on a loaded
macOS host. They are relative comparisons only, not physical-phone performance.

## Whiteboard, same workload, both renderers (`bench-board-*.json`, 3 runs each, medians)

30 identical pen swipes per stage; Android `gfxinfo` frames of the app (reset before the swipes); PSS per process.

| Strokes on the board | Legacy View renderer | Canvas renderer (shipped) |
|---|---|---|
| 100 | p50 150 ms · p99 300 ms · 100 % janky · app 287 MiB | p50 26 ms · p99 69 ms · 35 % janky · app 168 + WebView 159 MiB |
| 1,000 | p50 200 ms · p90 4,950 ms · app 991 MiB (2 of 3 runs), **1 of 3 crashed: OutOfMemoryError** | p50 26 ms · p99 73 ms · app 179 + WebView 184 MiB |
| 5,000 | **never reached: the app died (Java heap OOM) in all runs** | p50 28 ms · p99 65 ms · app 200 + WebView 243 MiB |

Canvas frame time is flat from 100 to 5,000 strokes, so on the emulator the floor is compositing, not the board.
Coalescing draft updates per frame and memoising the label overlay (`bench-board-canvas-optimized-*`) changed nothing
measurable (p50 26–27 ms); the change was reverted.

## Phone memory at rest (Home, 15 s after launch, 3 launches)

| | app PSS | WebView renderer PSS |
|---|---|---|
| OPAQUE join WebView always mounted (before) | 143 / 152 / 166 MiB | 84 / 86 / 86 MiB |
| Mounted only while joining (after) | 104 / 111 / 110 MiB | 12 / 12 / 12 MiB |

## Phone startup (`startup-*.json`)

`activityMs` = `am start -W` TotalTime; `contentReadyMs` = first screen capture equal to the settled screen (resolution
≈ 0.6 s). Fresh = `pm clear` first.

| Build | Fresh: activity / content | Existing: activity / content |
|---|---|---|
| Passphrase key (shipped) | 445–1,051 / 2.2–3.0 s | 534–778 / 3.8–4.9 s |
| Raw SQLCipher key (tried, reverted) | 581–857 / 2.2–3.3 s | 563–633 / 4.1–4.4 s |

No measurable difference, so the raw-key change (and the one-time re-key it needed) was reverted. Phase 12's single
4,851 ms fresh-profile sample didn't reproduce: fresh activity start is now 0.4–1.1 s.

## Desktop startup (`desktop-startup.txt`, 5 + 5 launches)

Launch → navigation ready: fresh median 703 ms, existing median 674 ms; the very first cold launch took 1,680 ms.
Opening Study in Full mode → 3D campus visible: ~835 ms every time; prefetching the 3D chunk on idle changed nothing
(`desktop-campus-prefetch.txt`), so the cost is scene setup. The prefetch was reverted. Reduced/Minimal never create a
canvas (`astra-world.test.ts`).

## Reliability and data recovery

* `android-final-*.txt`: cross-device ×2 and reliability ×2 on the final APK (on-demand join bridge);
  `android-prebridge-*.txt`: the same suites ×2 on the build before that change. `android-idle-memory.txt`: the table above.
* `macos-install-check.txt`: packaged 0.1.0 → 0.1.1 → 0.1.0 → uninstall on a disposable profile.
* `desktop-e2e-run*.txt`: three runs before the last fixes (run 2 failed on the `astra-world` race; fixed, 5/5 alone afterwards); `desktop-e2e-final-run*.txt` and `unit-final.txt`: the final tree.

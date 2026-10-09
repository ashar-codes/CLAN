# CLAN Astra — Phase 12 evidence

Base: `clan-mobile-completion` (`4b5b9a8`). Implementation and captures: macOS / Android 16 arm64 emulator. No physical-device performance claim. Release hardening and the excluded product phases have not begun.

## 1. Visual direction

**Sunlit campus workshop:** warm paper, navy ink, campus green, tactile wood, rounded architecture and restrained depth. Existing palette, font and timing tokens are preserved. The production app and Visual Lab informed the changes. The logo remains unchanged and undecided. See [DIRECTION.md](DIRECTION.md).

## 2. Characters and assets

Original procedural SVG, native geometry and Three geometry. Six hairstyles, clothing variants/colors, accessories, backpacks, expressions and activity props reuse the existing CLANmate specification. Production appearance customization follows your own avatar through My Space, Me and CLAN rooms and is device-local; remote members still see the generated appearance supported by the existing presence interface. 3D characters are in the Visual Lab; production rooms use lightweight SVG characters. All new assets are project-owned; existing OFL font licenses/source URLs remain recorded in [asset attribution](../../assets/ATTRIBUTION.md) and [manifest](../../assets/ASSET-MANIFEST.json). No manual model creation or downloaded game assets.

## 3. Screens and interactions

- **My Space:** daylight, window landscape, layered wood/furniture/rug/plant; all seven existing functional objects remain accessible.
- **Commons / rooms:** warmer surfaces, compact discovered-CLAN cards, type-specific room tables and accents, authenticated avatar states, finite arrival/departure feedback and existing contextual/drop actions. Positions are decorative, never physical location estimates.
- **Campus / Course:** real-topic floors, foundations for courses without topics, course-code roof variants, entrances, paths, actual confidence/activity/exam indicators, selection and entry motion. No invented academic progress.
- **Saved, Diary, Exam Prep, Chat, Whiteboard:** shared spacing/touch/layout refinements; Diary is first when opened on a narrow screen. Existing functional content and media wall remain intact.

## 4. Motion system

Shared 140/240/520 ms timings, bounded exponential settling, 1.6 s finite presence gestures and 850 ms transfer flight. CSS/native/3D use shared counterparts. Focus settles, Guide/session/course/exam entry gets short transitions, room membership has finite entry/exit, and file transfer uses existing real completion events. No essential action waits for an animation. Reduced motion, Minimal, hidden-scene suspension and listener/timer cleanup are supported. [Production recording](captures/focus-guide-study.webm), [timeline](captures/motion-timeline.json), [motion specification](../MOTION-SYSTEM.md).

## 5. Mobile

Native touch cards and seven room-object shortcuts; no desktop 3D scene on the phone. Screen entry uses the native animation driver and OS reduced-motion settings. Board toolbar targets are at least 48 points. Stroke rendering now uses two canvases inside the already-installed WebView, demand rendering, viewport culling, cached bounds and incremental visual updates. Native gestures, reducer, operations, undo, authorization and transport stay unchanged. Text/card accessibility remains native. A failed canvas offers reload.

## 6. Whiteboard before / after

Historical baseline in [TESTING.md](../../docs/TESTING.md): View renderer, **41–81 strokes**, p50 **25 ms**, p90 **44 ms**, **32% janky frames**. No historical thousands-of-strokes or board-specific memory measurement exists.

Release Android emulator measurements with the canvas renderer:

| Host board objects after drawing | Frame p50 | Frame p90 | Android aggregate jank | App package PSS |
|---|---:|---:|---:|---:|
| 108 | 24.93 ms | 35.94 ms | 39.94% | 168.6 MiB |
| 1,058 | 26.46 ms | 41.45 ms | 34.85% | 172.6 MiB |
| 5,088 | 31.18 ms | 51.81 ms | 34.48% | 204.8 MiB |

The change removes thousands of native stroke/segment views and renders a board of about 5,000 objects successfully. It **does not establish a universal frame-time or jank improvement**: jank remains, and 5,000-object p90 exceeds the historical small-board baseline. Comparable-count p90 is lower, while aggregate jank is higher. A paired legacy/canvas benchmark at the same thousands-of-strokes workload is still needed for a causal performance comparison.

Method: existing real host and operation protocol; add 80, then 920, then 4,000 strokes, and draw 30 native swipes at each stage. Counts include initial/gesture objects. Frame p50/p90 use the retained valid `gfxinfo framestats` buffer (118–119 frames); aggregate jank uses Android's larger reset-to-dump interval. These are different sample windows and measure host UI timing, **not isolated WebView GPU FPS**. Raw measurements: [performance.json](android-native/performance.json), `gfxinfo-*.txt`, `memory-*.txt`. File suffixes are newly added stroke counts, not board totals.

WebView runs another process. A separate idle snapshot after the stress run measured **188.2 MiB host PSS + 142.3 MiB renderer PSS** (330.5 MiB combined, excluding shared WebView services). This snapshot is later than the table and must not be added to those rows. Package-only PSS is not total board memory. Future benchmark runs also retain sandbox renderer snapshots per stage.

## 7. Bundle, startup, memory and frame timing

| Measurement | Result |
|---|---:|
| Production renderer entry JS | 407.63 kB / 117.82 kB gzip |
| Lazy 3D campus chunk | 920.16 kB / 244.58 kB gzip |
| Renderer CSS | 53.83 kB / 12.60 kB gzip |
| Android release Hermes bundle | 5,227,568 bytes |
| Embedded mobile canvas HTML | 104,226 bytes |
| Electron launch to navigation ready, final QA run | 2,181 ms |
| Campus scene initialization | 394 ms |
| Electron rAF intervals, 120 samples | p50 8.3 ms / p90 9.3 ms |
| Electron process working sets | Browser 249.2, GPU 114.5, Utility 44.1, Tab 195.7 MiB |
| Android fresh-profile cold first activity | 4,851 ms |
| Android existing-profile cold first activity (three runs) | 553 / 686 / 425 ms; median 553 ms |

Desktop rAF intervals correspond to about 120 Hz median scheduling on this Mac; they are not a sustained animated-scene FPS benchmark. Working sets can contain shared pages and are not exclusive memory. Startup is a single local sample, not a percentile; earlier runs ranged from 868 to 6,912 ms on this host. Android's historical first-activity time was 687 ms. Three fresh process launches with the existing profile measured 553/686/425 ms ([raw results](android-native/startup-existing-profile.json)); the fresh-profile 4,851 ms run includes different initialization conditions. These are not controlled paired samples. The fresh-profile delay remains a concern, and activity start is not equivalent to content ready. No battery or physical-phone measurement. The 3D chunk remains large and lazy; Reduced/Minimal and GPU-loss fallback keep course actions usable.

## 8. Screenshots and captures

[Open the gallery](index.html). All ten requested screens at **1440×900, 1024×768, 390×844, 360×800**, plus Reduced/Minimal captures: 48 production Electron PNGs. The two phone-sized sets are explicitly **desktop responsive**, not native mobile. Final [QA results](qa.json) also verify that the customized local avatar appears in the host room: zero page errors and zero horizontal overflows across 48 captures. Android PNGs are separate native emulator captures at **1080×2400**, density 420. The recording shows actual Focus, Guide and study-session actions.

## 9. Accessibility

Keyboard activation of room objects, named controls, persisted appearance inputs, live OS reduced-motion handling, Minimal suppression, native board text/card labels, enlarged touch targets, visible mobile object labels and responsive wrapping. Departed people immediately lose actions while their visual exit finishes. GPU context loss removes the scene and exposes existing DOM course controls. Automated checks are targeted; this is not a full screen-reader or WCAG audit.

## 10. Tests and E2E

- **307 existing unit tests passed**, plus **2 new motion tests** (309 across the recorded runs).
- **19 existing desktop E2E scenarios passed across the main run and isolated retries**; two existing opt-in performance tests remain skipped.
- **2 new desktop E2Es passed:** generated mobile canvas with 5,000 strokes/deltas/culling/preview cleanup; object actions, loaded narrow layout, appearance persistence, Reduced/Minimal, reduced motion, context loss and listener cleanup.
- Final typecheck, production desktop build, Visual Lab build and Android release build passed.
- **Existing Android cross-device suite passed** on the release emulator build: link/approval, two-way sync, offline conflict/Keep both, unlink/refusal, Share-to-Inbox, secure join, bidirectional chat and board operations, and SHA-256-verified download. See [native test log](validation/android-cross-device.txt).

[Validation logs](validation/) retain failures as well as retries. Initial runs had peer-join/teardown timeouts and a Study Tape seek timing failure; isolated normal-priority retries passed. The new object test initially expected “Saved” instead of the existing “Your shelves” heading; the assertion was corrected. A later CLAN run saw the downloaded label before the host-signature detail; its unchanged isolated retry passed. These are not represented as one clean full-suite run.

## 11. Regressions fixed

Native stroke-view scaling; canvas text/sticky accessibility; narrow Diary/provider-selector overflow; Diary pushed below profile customization; close campus camera clipping tall buildings; empty-topic courses lacking an entrance; idle scene rendering; context-loss fallback; removal of departed-member actions; transient host-test interference during concurrent validation. Security, business logic and media module were not refactored.

## 12. Unverified platforms

Physical Android performance/battery/touch, real Wi-Fi/BLE/location behavior, iOS runtime/rendering/VoiceOver, Windows/Linux visuals and assistive-technology audits remain unverified. Existing emulator evidence cannot establish those results. Screen-sharing regression evidence is desktop; this phase did not repeat a native Android screen-share viewing capture.

## 13. Remaining visual limitations

Production room characters remain 2D; appearance preferences do not sync or alter remote presence. Rooms share a lightweight stage with type-specific accents rather than five fully modeled environments. Mobile uses small native avatars and object cards rather than the desktop appearance editor or 3D world. Commons can only show people where existing authenticated interfaces expose them; discovery alone shows CLANs. Native screenshots do not cover every desktop route. The canvas still has measurable jank and additional WebView memory; the large 3D chunk and startup variability need further work before performance claims. No new logo was selected.

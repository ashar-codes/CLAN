# CLAN visual language

**Concept: your academic life as a place.** Things you own are objects in *My Space*; people near you stand in the
*Commons*; courses are buildings on the *Knowledge Campus*. A spatial shape only appears when it encodes real data;
otherwise use a plain card. Every screen must also work flat (no WebGL).

## Tone
Warm, modern, university-age: a well-lit shared desk, not a dashboard. Avoid purple "AI" gradients, glass blur, neon and
cyberpunk, corporate blue/grey, and toy-like childishness.

## Tokens (`packages/design/src/tokens.css`, the only source of colour)
| Group | Values | Use |
|---|---|---|
| Paper | `--paper` `--paper-2` `--surface` `--line` | ground, panels, cards, hairlines |
| Ink | `--ink` `--ink-2` `--ink-3` | text, primary buttons |
| Materials | `--clay` (action), `--sage`, `--mustard`, `--sky`, `--teal`, `--stone` + `-soft` tints | accents; colour by meaning, never decoration |
| Beacon | `--beacon-{available,studying,focus,presenting,transfer,away}` | status only |
| Shape | radius 8/14/22, pill buttons, two shadow levels | |
| Type | Bricolage Grotesque (display), Figtree (body), both variable, OFL | |

Dark theme and an **exam mode** (`[data-mode=exam]`: cooler paper, higher contrast) override the same tokens.
3D scenes read their colours from these tokens at runtime.

## The CLAN Beacon
An open **C-ring** (CLAN's mark) beside a person's shoulder, never above the head. The state is shown by colour **and** an
inner glyph (dot, lines, closed ring, broadcast arcs, arrow, dash), so it is readable without colour vision. Focus closes
the ring (do not disturb); Transfer spins it.

## Rules
* One primary action per view (`.c-btn.primary`, ink); clay is reserved for "do it now" (Quick Capture, countdown).
* Demo or fixture data is labelled on screen ("Visual Lab · demo data", "Demo mode").
* Diary uses the same tokens but no Guide, no accents beyond mood dots, and more whitespace.
* Minimum 44 px touch targets on mobile; visible `:focus-visible` rings; respects `prefers-reduced-motion`.

## Production (clan-production-world-ui)
**Palette** (tokens.css; plain copy in `palette.ts` for React Native/three.js, kept equal by a test):
| Role | Light | Night |
|---|---|---|
| paper / surface / ink | #f7f1e6 / #fffbf3 / #17233b (navy ink) | #0e1424 / #1a243d / #f3ead9 (lamplight) |
| campus green (available, places) | #287a4e | #52b882 |
| notebook yellow (focus, deadlines, lit windows) | #f0b02f | #f5c45c |
| brick (act now, presenting) | #c04826 | #ee7049 |
| library burgundy (courses, books) | #8a2d48 | #cf6283 |
| study blue (studying, links) | #2a66c1 | #6aa0ee |
| AI violet (Guide only) | #6a4fd6 | #9b8cf2 |
Contrast (WCAG): ink 13.9:1, ink-3 4.7:1, study links 4.96:1, campus text 4.69:1, text on brick 5.0:1 (light) via `--on-accent`
(night navy on night brick 6.2:1). Legacy names (`--clay`, `--sage`, …) alias the semantic set.

**Type roles**: Bricolage Grotesque = places/headings/numbers (`.title.world`, `.c-num`); Figtree = UI and reading; labels =
700 11px caps (`.eyebrow`). One variable file per family/subset.

**Visual Experience** (Me › Visual experience; default follows reduced-motion + WebGL): **Full** = SVG places + 3D Campus on
entry + motion; **Reduced** = 2D places (towers instead of 3D), short motion; **Minimal** = conventional panels, no motion.
Every place has a conventional equivalent (Today list, List View, tabs).

**What stays conventional, on purpose**: forms (create/join, profile), file lists with transfer state, roster/approval, settings,
timeline, note editor, tables — the room frames them; it never replaces them.

**Desktop performance (this Mac, Electron, 1440×900)**: shell JS 380 KB (116 KB gz, was 337/100), 3D Campus chunk 895 KB lazy;
My Space painted 0.65–1.2 s after launch; Campus 3D scene-ready 0.41–0.63 s; 120 fps (display cap) on My Space and Campus;
JS heap ~10–12 MB (WebGL memory not counted). No mobile performance claims (no devices).

Screenshots: `design/production/after/{desktop,mobile,interaction,modes}`; before/after: `design/production/compare.html`.
Scripts: `apps/desktop/scripts/production-shots.ts`, `apps/desktop/scripts/perf.ts`.

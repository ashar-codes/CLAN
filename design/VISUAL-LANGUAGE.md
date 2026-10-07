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

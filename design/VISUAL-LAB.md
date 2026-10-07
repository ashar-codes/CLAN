# Visual Lab (Phase 1)

`pnpm lab` (dev) · `pnpm build:lab && node apps/visual-lab/shots.ts [--perf]`. Isolated app (`apps/visual-lab`); it imports
only `@clan/design` and `@clan/world` plus its own **demo fixtures** (`src/demo/`), never the backend.

## Screens
1. **My Space**: a room where every object is navigation with a live count (bookshelf → Campus, books = course progress;
   board → exams; laptop → continue; journal → Diary; lamp → Guide; backpack → Saved Inbox; door → Commons).
2. **Commons**: people on distance rings (table / building / campus network), with Beacons. 3D or flat.
3. **CLANmate**: radial wheel (Send, Chat, Study, Profile, Screen, Invite); drag a file onto the person.
4. **Study Room**: wall switches screen share ⇄ whiteboard (working pointer drawing); shared table; Chat, Files,
   Notes, Members, AI, Tasks panels.
5. **Knowledge Campus**: building = course, floor = lecture (solid = attended), lit window = person studying it now,
   kiosk = resource, path = prerequisite, column = term. Select a building to glide in and list its floors.
6. **Saved**: collections as columns (Inbox, Watch Later, Programming, AI, CS-201, custom); drag between them; cards
   hold title/source/URL/preview/note/tags only.
7. **Diary**: date, mood, writing, past entries; Guide hidden; "never shared, never read by AI".
8. **Exam Command Center**: labelled demo mode; countdown, readiness rings, topic confidence, week plan, material.

Global: Quick Capture (Note/Link/File/Idea → Inbox; Voice/Scan shown disabled, "not in lab"), Beacon picker, Focus
mode (25-min timer), Guide (abstract three-dot shape; static demo suggestions per screen; never on Diary), 3D toggle, dark theme.

## Screenshots
`design/screenshots/desktop/*.png` (1440×900), `design/screenshots/mobile/*.png` (390×844 @2x),
`design/screenshots/interaction/` (Commons → Hana → Send → file flight at 150/450/750 ms → transfer Beacon → verified, plus
Quick Capture, Focus, Campus enter, Guide, Exam transition, dark Home) and `commons-send.webm`.

## Performance (Chrome 154 headed, Apple Silicon, 1440×900)
| screen | mode | scene ms (import → first frame) | fps | JS heap MB |
|---|---|---|---|---|
| Commons | 3D | 440 | 120 | 10 |
| Campus | 3D | 391 | 120 | 12 |
| Commons / Campus | 2D | — | 120 | 3 |
| Home / Study | either | — | 120 | 3 |

fps is capped by the display (120 Hz), so it shows "no dropped frames" rather than headroom. GPU memory was not measured.
Bundle (minified / gzip): main 238 / 75 kB; three.js + scenes 925 / 245 kB, **lazy**, loaded only when a 3D screen opens
with 3D on; CSS 22 / 6 kB; fonts 99 kB (Latin subsets load first). Raw data: `apps/visual-lab/perf.md`.

## Simplifications
* All 3D is procedural primitives: no glTF, no textures, no shadows, no post-processing.
* Chat, AI, Screen and Invite are interaction prototypes on fixtures; nothing touches the network.
* The send animation is cosmetic; real transfers keep the existing verified protocol.
* No scene-graph instancing (fewer than 100 meshes per scene); add it if a Commons holds more than about 60 people.

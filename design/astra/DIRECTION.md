# Astra — sunlit campus workshop

Source: `clan-mobile-completion`, the production app and `design/production/after`, Visual Lab and the shared design tokens. The established warm paper, navy ink, campus green, notebook yellow, study blue, burgundy and Guide violet remain unchanged. No new logo.

The audit found flat room objects, empty-looking course scenes, sparse Commons layouts, simplified 3D characters that did not express most of their specs, and continuously running 3D render loops. The upgrade uses rounded foundations, tactile wood, legible silhouettes, daylight, planted spaces and finite character gestures. Depth is restrained so controls and real study information remain primary.

## Assets and production

Every new visual is original procedural SVG, CSS, React Native geometry or Three geometry. No external game assets, textures, rigs, downloaded models, or image generation. No Blender dependency or manual modeling. Font sources and licenses are in `assets/ASSET-MANIFEST.json` and `assets/ATTRIBUTION.md`; no new third-party asset license is introduced.

The same CLANmate specification retains six hairstyles, four tops, four bottoms, shoes, accessories and backpacks. SVG adds expression and activity props; 3D now renders more of the existing spec. The production appearance editor stores a **device-local visual preference**; publishing/syncing that preference to other people is outside the current presence interface. Production room avatars remain SVG; the procedural 3D avatars are available in the Visual Lab.

Room objects remain keyboard-operable buttons with existing actions. Classroom, Study Group, Project Team, Friends and Temporary room styles use the existing room type, leaving screen sharing and board ownership intact. Commons positions are decorative, and unauthenticated discovery never produces invented people.

Course foundations/entrances are architecture, not progress. Floors are actual topics; confidence colors and recent activity windows come from existing Study view models. Roof form varies deterministically with the actual course code. Exam flags only appear for real upcoming exams. Entrance walks are decorative circulation; prerequisite links remain a separate input.

## Motion and mobile

Preserved timings: 140 / 240 / 520 ms, shared native/3D counterparts in `packages/design/src/motion.ts`. Presence gestures run finitely; Focus remains still. OS reduced motion and Minimal disable CSS motion. Native screen entry uses a short opacity transition with cancellation on unmount/reduced-motion changes. Campus renders on demand and stops scheduling once its camera settles. Hidden/reduced-motion scenes do not run idle character motion.

Mobile uses native cards and room objects rather than desktop 3D. The board uses the installed WebView's canvas engine, two canvas layers, viewport culling and on-change rendering. Its protocol and domain reducer are unchanged. Text/sticky/reference accessibility remains in a small native overlay; strokes create no native views. No external renderer dependency was added. Regenerate its bundled artifact with `pnpm --filter @classroom/mobile build:board`.

## Evidence conventions

`desktop-responsive-*` images are production Electron renderings at four viewport sizes. They are **not native phone screenshots**. `android-native` is reserved for adb captures and measurements from the Android emulator. Emulator numbers never establish physical-device performance. `qa.json` records startup, scene initialization, frame intervals and memory with the screenshot layout checks.

# Handoff — Phase 14.3 A+B done in the cloud; C+D not started

* Branch `claude/phase-14.3-ab` (based on Phase 14.2 PR #1 head `claude/laughing-clarke-yql2cy` @ `80d431c`).
  Draft PR targets `claude/laughing-clarke-yql2cy`. Nothing merged; no release builds; no signing keys touched.
* Read first: `PHASE_14_3_ARCHITECTURE.md` (design + security), `PHASE_14_3_PROGRESS.md` (what ran, with results),
  `PHASE_14_3_HARDWARE_TESTS.md` (owed device checks), `KNOWN_LIMITATIONS.md` › Phase 14.3.

## Where the code is
| Area | Files |
|---|---|
| Protocol | `packages/protocol/src/people.ts` |
| Core rules + storage (`people_*` tables, migrations 1–2) | `packages/clan/src/modules/people/index.ts` |
| Server endpoint + DNS-SD | `packages/server/src/people-server.ts` |
| Node client (desktop) | `packages/client/src/people.ts`, `people-auth.ts` |
| Desktop runtime / IPC / UI | `apps/desktop/src/main/people-runtime.ts`, `main/people.ts`, `renderer/world/people/*` |
| Phone runtime / UI | `apps/mobile/src/people/{runtime,native}.ts`, `src/screens/People.tsx`, `modules/pinned-transport/index.ts` (`firstContactRequest`) |
| Tests | `packages/clan/test/people{,-transport,-phone}.test.ts`, `apps/desktop/e2e/people.test.ts` |

## Running the checks (Linux needs Xvfb and a non-root user for Electron)
`pnpm typecheck` · `pnpm test` · `cd apps/desktop && pnpm test:e2e e2e/people.test.ts` (builds, then runs that file)
(the E2E passes `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`; the main-process permission gate
is still the real one). macOS: run the same E2E natively, then the hardware list.

## Next work candidates (not started — C+D is a separate phase)
1. Phone: camera QR (expo-camera), voice notes (expo-audio), calls (react-native-webrtc already in the app) — each
   needs a device run before shipping.
2. Profile picture exchange between peers (signed, size-limited, cached by SHA-256).
3. Optional: let a linked computer relay for its owner's phone (phone-to-phone via the owner's computer).

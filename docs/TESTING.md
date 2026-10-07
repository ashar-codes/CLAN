# Testing

| Command | What runs |
|---|---|
| `pnpm test` | Vitest, 68 tests: `unit.test.ts` (19: state machine, throttling, ranges, names, storage paths), `integration.test.ts` (10: join/approve/reconnect/security), `files.test.ts` (20: import, download, Range/If-Range, 100 MB resume after a TCP cut at 47 MB, corruption, versions, names, hide/remove, Send to Everyone, auth matrix, cross-session on one DB, traversal, limits, idle watchdog, disk reserve), `assignments.test.ts` (19: publish, receipt, late, types/size, overrun, hash mismatch, offsets, interrupted upload via TCP cut, idempotency incl. concurrent, versions, malicious names, metadata limits, cross-class, overwrite attempts, spoofed identity, removed/blocked, restart persistence) |
| `pnpm test:e2e` | Builds the desktop app, launches **two real Electron instances** with isolated data dirs: create class, real mDNS discovery, wrong code refused, approval, quality indicator; teacher adds files (native dialog stubbed), student downloads + SHA-256 verified on disk, **400 MB download paused mid-way and resumed** (UI shows "resumed", partial never appears as a finished file), Send to Everyone auto-download with teacher completed count, assignment publish, student submits, receipt shown + stored, teacher sees Submitted 1, class end |
| `E2E_EXECUTABLE=… vitest run -c apps/desktop/vitest.e2e.config.ts` | Same E2E against the packaged `.app`/`.exe` |
| `pnpm benchmark` | Load simulation (1/10/20/40 students) |
| `pnpm typecheck` | All packages + desktop + mobile |

Connection drops are simulated with a TCP proxy that cuts the socket after N bytes (`cuttingProxy` in `packages/server/test/helpers.ts`), not by client aborts.
Key security checks were mutation-tested (removing session scoping, hidden check, idempotency, hash check, approved check, If-Range each makes a test fail).

E2E needs a network interface with a private IPv4 address and multicast (it uses the machine's real LAN).

## Mobile
No emulator/SDK on the dev machine. Verified: TypeScript against Expo SDK 57 typings; Metro bundles iOS and Android JS;
`expo prebuild` (M1) generated the expected native config. **Not verified on any device:** discovery, downloads
(`expo-file-system` resumable), on-device SHA-256 speed, document picker, uploads, receipts, notifications. The join/reconnect logic it uses is the same `@classroom/client` exercised by the
integration tests. Device smoke test:
1. `pnpm server --title Test` on a laptop (prints the code).
2. Install a dev build on the phone (BUILDING.md), same Wi-Fi.
3. Fill in details → enter code → see "Waiting for the teacher" → approve (desktop teacher) or use `open` policy.
4. Toggle airplane mode for ~10 s: indicator goes "Reconnecting…", then back to Excellent/Good.
5. Teacher adds a 100 MB file; on the phone tap Download, Pause at ~40%, Resume → "Downloaded"; open via the share sheet.
6. Teacher publishes an assignment; submit a file from the phone; receipt card appears; teacher sees Submitted.
7. Airplane mode during a submission upload, then retry → teacher still shows exactly one submission.

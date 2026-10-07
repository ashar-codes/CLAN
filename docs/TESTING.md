# Testing

| Command | What runs |
|---|---|
| `pnpm test` | Vitest, **110 tests**, all over the real secure path (OPAQUE pairing, TLS 1.3 with the pinned per-class certificate, Ed25519 device proofs). `unit.test.ts` (19: state machine, OPAQUE-attempt throttling, trust classes, ranges, names, storage paths), `integration.test.ts` (10: secure join/approve, multi-classroom pairing, reconnect, teacher-only actions, tokens across classes, throttling, malformed bodies, removal, lock/end), `files.test.ts` (20) and `assignments.test.ts` (19) — the Milestone 2 suites, unchanged in intent, now over HTTPS — and `security.test.ts` (42: active MITM, binding tampering ×6, stale binding, certificate substitution, OPAQUE replay, guessing without finishing, downgrade, CORS/origin/content-type, copied/wrong keys, eavesdropper MAC, replayed/expired/cross-class challenges, known vs new device, UUID non-migration, blocked/removed, device-key reconnect, signed receipts ×11, absolute token lifetime, code not persisted, log redaction) |
| `pnpm test:e2e` | Builds the desktop app and drives **two (then four) real Electron instances** over the machine's LAN: create class; real mDNS; wrong code refused; secure pairing + approval; WSS state shows the teacher key; files (download + SHA-256 on disk, 400 MB pause/resume, Send to Everyone); assignment submit; **receipt shows "Verified ✓"**; from inside the student app: an attacker TLS server on the teacher's IP is **blocked by the pin**, the genuine pinned server is reachable, **ws:// and http:// are blocked**; **student app restart → "Rejoin" by device key** (no code, no re-approval, download state intact); **cloned profile without the private key**: device-key rejoin refused, code join lands in "Waiting" and the teacher sees "New device for this roll number" (not auto-approved under "known devices"); class end |
| `E2E_EXECUTABLE=… vitest run -c apps/desktop/vitest.e2e.config.ts` | Same E2E against the packaged `.app`/`.exe` |
| `pnpm benchmark` | Load simulation (1/10/20/40 students) |
| `pnpm typecheck` | All packages + desktop + mobile |

Connection drops are simulated with a TCP proxy that cuts the socket after N bytes (`cuttingProxy` in `packages/server/test/helpers.ts`), not by client aborts.
Key security checks were mutation-tested: for Milestone 2 (session scoping, hidden check, idempotency, hash check, approved check, If-Range) and for 2.5 (client binding MAC check, binding session check, join signature check, join MAC check, join single use, reconnect single use, reconnect key binding, absolute token expiry) — removing any one makes a test fail. The token-lifetime test was strengthened after the first mutation run showed it passing for the wrong reason.

E2E needs a network interface with a private IPv4 address and multicast (it uses the machine's real LAN).

## Mobile
No emulator/SDK on the dev machine. Verified: TypeScript against Expo SDK 57 typings; Metro bundles iOS (737 modules) and
Android (735). **Mobile cannot join in this build** — no OPAQUE binding compatible with the 1.1 server and no pinned native
transport (see native.ts / PAIRING_AND_TRUST.md); the join screen says so. Nothing mobile has run on a device or emulator. The join/reconnect logic it uses is the same `@classroom/client` exercised by the
integration tests. Device smoke test:
1. `pnpm server --title Test` on a laptop (prints the code).
2. Install a dev build on the phone (BUILDING.md), same Wi-Fi.
3. Fill in details → enter code → see "Waiting for the teacher" → approve (desktop teacher) or use `open` policy.
4. Toggle airplane mode for ~10 s: indicator goes "Reconnecting…", then back to Excellent/Good.
5. Teacher adds a 100 MB file; on the phone tap Download, Pause at ~40%, Resume → "Downloaded"; open via the share sheet.
6. Teacher publishes an assignment; submit a file from the phone; receipt card appears; teacher sees Submitted.
7. Airplane mode during a submission upload, then retry → teacher still shows exactly one submission.

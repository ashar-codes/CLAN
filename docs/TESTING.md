# Testing

| Command | What runs |
|---|---|
| `pnpm test` | Vitest, **124 tests** after Milestone 2.6 (68 from Milestones 1–2 adapted to the secure transport, 48 from 2.5, 8 from 2.6: `mobile.test.ts` ×7 — bridge protocol over the real OPAQUE library, mobile signer, correct/wrong code, fake classroom, changed pin/certificate, copied key, token expiry → device reconnect, download + submission + receipt; `modules/pinned-transport/tests` ×1 — iOS trust code on Apple Security), all over the real secure path (OPAQUE pairing, TLS 1.3 with the pinned per-class certificate, Ed25519 device proofs). `unit.test.ts` (20: state machine, OPAQUE-attempt throttling, trust classes, ranges, names, storage paths, v2→v3 database upgrade), `integration.test.ts` (10: secure join/approve, multi-classroom pairing, reconnect, teacher-only actions, tokens across classes, throttling, malformed bodies, removal, lock/end), `files.test.ts` (20) and `assignments.test.ts` (19) — the Milestone 2 suites, unchanged in intent, now over HTTPS — and `security.test.ts` (42: active MITM, binding tampering ×6, stale binding, certificate substitution, OPAQUE replay, guessing without finishing, downgrade, CORS/origin/content-type, copied/wrong keys, eavesdropper MAC, replayed/expired/cross-class challenges, known vs new device, UUID non-migration, blocked/removed, device-key reconnect, signed receipts ×11, absolute token lifetime, code not persisted, log redaction, receipt-verifier CLI exit codes) and `apps/desktop/test/trust.test.ts` (4: teacher-key change detection, no re-pinning of a session, durable receipt anchors, per-install device keys) |
| `pnpm test:e2e` | Builds the desktop app and drives **two (then four) real Electron instances** over the machine's LAN: create class; real mDNS; wrong code refused; secure pairing + approval; WSS state shows the teacher key; files (download + SHA-256 on disk, 400 MB pause/resume, Send to Everyone); assignment submit; **receipt shows "Verified ✓"**; from inside the student app: an attacker TLS server on the teacher's IP is **blocked by the pin**, the genuine pinned server is reachable, **ws:// and http:// are blocked**; **student app restart → "Rejoin" by device key** (no code, no re-approval, download state intact); **cloned profile without the private key**: device-key rejoin refused, code join lands in "Waiting" and the teacher sees "New device for this roll number" (not auto-approved under "known devices"); class end |
| `E2E_EXECUTABLE=… vitest run -c apps/desktop/vitest.e2e.config.ts` | Same E2E against the packaged `.app`/`.exe` |
| `pnpm benchmark` | Load simulation (1/10/20/40 students) |
| `pnpm typecheck` | All packages + desktop + mobile |

Connection drops are simulated with a TCP proxy that cuts the socket after N bytes (`cuttingProxy` in `packages/server/test/helpers.ts`), not by client aborts. The proxy honours backpressure, so the cut point is bytes actually handed to the client (an earlier version without backpressure made the 100 MB resume test flaky under parallel load).
Key security checks were mutation-tested: for Milestone 2 (session scoping, hidden check, idempotency, hash check, approved check, If-Range) and for 2.5 (client binding MAC check, binding session check, join signature check, join MAC check, join single use, reconnect single use, reconnect key binding, absolute token expiry) — removing any one makes a test fail. The token-lifetime test was strengthened after the first mutation run showed it passing for the wrong reason.

E2E needs a network interface with a private IPv4 address and multicast (it uses the machine's real LAN).

## Mobile (2.6)
No emulator/SDK/Xcode project on the dev machine. Verified here:
* TypeScript; Metro bundles iOS (748 modules) and Android (746); `expo prebuild` autolinks the local `PinnedTransport` module on both platforms.
* `e2e/mobile-bridge.test.ts`: the exact generated bridge HTML runs in sandboxed Chromium (Electron), pairs + joins a real server,
  refuses a wrong code, rejects unknown operations, and cannot reach the network.
* `PinnedTrust.swift` compiled for macOS and run against a real server (Apple Security framework).
* `mobile.test.ts`: the mobile logic in Node (native transport replaced by the Node pinned transport).
**Not verified:** anything on an iPhone/Android device or emulator; the Swift Expo module and the Kotlin module have never been compiled.

### Device test procedure (when hardware is available)
1. `pnpm install`; `pnpm --filter @classroom/mobile build:bridge` (only if the OPAQUE version changed); then
   `pnpm --filter @classroom/mobile ios` (Xcode, real iPhone, same Wi-Fi) or `pnpm --filter @classroom/mobile android`.
2. Teacher: desktop app → Create Classroom. iOS shows the local-network prompt: Allow.
3. Phone: details → enter code → expect "Waiting for the teacher"; teacher approves → class view. Wrong code first: refused.
4. Pin check: run `node packages/server/src/cli.ts` on another laptop with the same title and a different code; from the phone
   enter the teacher's code while only the fake is visible → must fail. (Optional: mitmproxy as Wi-Fi proxy → join must fail.)
5. Download a 100 MB file, toggle airplane mode mid-way, resume → completes, then submit an assignment → "Verified ✓".
6. Leave the phone idle > 30 min (or restart the class's token lifetime in a dev build) → reopen → reconnects without the code.
7. Copy nothing off the device: confirm `classroom.device.ed25519.v1` exists only in Keychain/Keystore (no file in Documents). The join/reconnect logic it uses is the same `@classroom/client` exercised by the
integration tests. Device smoke test:
1. `pnpm server --title Test` on a laptop (prints the code).
2. Install a dev build on the phone (BUILDING.md), same Wi-Fi.
3. Fill in details → enter code → see "Waiting for the teacher" → approve (desktop teacher) or use `open` policy.
4. Toggle airplane mode for ~10 s: indicator goes "Reconnecting…", then back to Excellent/Good.
5. Teacher adds a 100 MB file; on the phone tap Download, Pause at ~40%, Resume → "Downloaded"; open via the share sheet.
6. Teacher publishes an assignment; submit a file from the phone; receipt card appears; teacher sees Submitted.
7. Airplane mode during a submission upload, then retry → teacher still shows exactly one submission.

# Testing

| Command | What runs |
|---|---|
| `pnpm test` | Vitest: unit (`packages/server/test/unit.test.ts`) + integration/security over real sockets (`integration.test.ts`) — 25 tests |
| `pnpm test:e2e` | Builds the desktop app, launches **two real Electron instances** with isolated data dirs, teacher creates a class, student discovers it over real mDNS on your LAN, wrong code refused, teacher approves, quality indicator, class end |
| `E2E_EXECUTABLE=… vitest run -c apps/desktop/vitest.e2e.config.ts` | Same E2E against the packaged `.app`/`.exe` |
| `pnpm benchmark` | Load simulation (1/10/20/40 students) |
| `pnpm typecheck` | All packages + desktop + mobile |

E2E needs a network interface with a private IPv4 address and multicast (it uses the machine's real LAN).

## Mobile
No emulator/SDK on the dev machine. Verified: TypeScript, Metro bundles the Android JS, `expo prebuild` generates the
expected native config. The join/reconnect logic it uses is the same `@classroom/client` exercised by the
integration tests. Device smoke test:
1. `pnpm server --title Test` on a laptop (prints the code).
2. Install a dev build on the phone (BUILDING.md), same Wi-Fi.
3. Fill in details → enter code → see "Waiting for the teacher" → approve (desktop teacher) or use `open` policy.
4. Toggle airplane mode for ~10 s: indicator goes "Reconnecting…", then back to Excellent/Good.

# Classroom LAN

Offline-first classroom collaboration. One teacher laptop hosts the classroom; students join from desktop or phone
over the local network with a 6-digit code. **No internet is required at runtime.**

> Status: Milestones 0–2.5 are complete on desktop: LAN Mode, discovery, approval, roster, presence, timeline, classroom
> files with resumable verified downloads, assignments with idempotent submissions, and the security foundation — 6-digit
> code authenticated with OPAQUE, TLS pinned through the PAKE, Ed25519 device/teacher identities, signed receipts
> ([docs/PAIRING_AND_TRUST.md](docs/PAIRING_AND_TRUST.md)). Phones cannot join yet (see KNOWN_LIMITATIONS). Everything else
> in the V1 spec is not built yet — see [docs/PROGRESS.md](docs/PROGRESS.md).

## Quick start (development)

```sh
pnpm install          # needs internet once, for dependencies
pnpm dev              # desktop app (teacher or student) with hot reload
pnpm test             # unit + integration + security tests
pnpm test:e2e         # launches two real Electron apps and joins over your LAN
pnpm benchmark        # join + file-transfer benchmarks; rewrites docs/BENCHMARKS.md
node tools/sim/lan-bench.ts   # real-Wi-Fi capacity: students open the printed URL in any browser
node tools/sim/verify-receipt.ts receipt.json --teacher-key KEY   # verify an archived receipt offline
pnpm typecheck
```

Run a teacher and a student on one machine: `pnpm dev -- --profile=teacher` and `pnpm dev -- --profile=student`
in two terminals. Headless teacher server: `pnpm server --title "Operating Systems"` (ephemeral teacher identity; prints the code, never tokens or keys).

Mobile (student): `pnpm dev:mobile` (requires a development build — see [docs/BUILDING.md](docs/BUILDING.md)).

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Wire types + zod schemas used at every trust boundary |
| `packages/server` | Teacher-hosted server: Fastify HTTP, WebSocket, SQLite (`node:sqlite`), DNS-SD |
| `packages/client` | Platform-neutral student client (join by code, reconnecting socket) — desktop, mobile, simulator |
| `apps/desktop` | Electron + React: Teacher and Student modes |
| `apps/mobile` | Expo (dev build) + React Native: Student mode |
| `tools/sim` | Load simulator / benchmark |
| `docs/` | Architecture, security, protocol, networking, platform notes, progress |

The product name lives in `PRODUCT_NAME` (`packages/protocol`), app manifests and `electron-builder.yml`.

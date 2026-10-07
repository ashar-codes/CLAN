# CLAN

Offline-first academic life: your own space, the people near you, and the CLANs you belong to (classes, study groups,
project teams). The original classroom flow — one teacher laptop hosts, students join from desktop or phone over the local
network with a 6-digit code — is the CLASSROOM CLAN type. **No internet is required at runtime.**

Internal identifiers that still say `classroom` are kept on purpose — see [Legacy names](docs/MODULES.md#legacy-names).

> Status: Milestones 0–2.75. Desktop: LAN Mode, secure pairing (OPAQUE + pinned TLS + Ed25519 identities), files and
> assignments with signed receipts, and **peer-assisted distribution** (teacher-signed manifests; the teacher stays the only
> authority — [docs/PEER_ASSISTED_MODE.md](docs/PEER_ASSISTED_MODE.md)). Mobile: secure join and peer downloads implemented,
> **not yet run on a device**. Windows Direct Mode, screen sharing and the rest of V1 are not built — see
> [docs/PROGRESS.md](docs/PROGRESS.md).

## Quick start (development)

```sh
pnpm install          # needs internet once, for dependencies
pnpm dev              # desktop app (teacher or student) with hot reload
pnpm test             # unit + integration + security tests
pnpm test:e2e         # launches two real Electron apps and joins over your LAN
pnpm benchmark        # join + file-transfer benchmarks; rewrites docs/BENCHMARKS.md
node tools/sim/bench-swarm.ts --workers 6   # 60/100-client teacher-only vs peer-assisted
node tools/sim/lan-bench.ts [--mode classroom]   # real Wi-Fi: browser capacity test, or a real classroom with real devices
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

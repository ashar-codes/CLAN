# Architecture

## CLAN (modular monolith)

```
apps/desktop  (shell: Home / CLANs / Study / Saved / Me + classroom flows)
  renderer ──preload API──► main: registerClan() ─► @clan/core openClan(db)        @classroom/server (classroom protocol)
                                                     │ composition root                │ sessions, members, resources,
            core: db (module migrations) · events · identity · permissions ·          │ assignments, submissions …
                  resources (Resource Store) · search · context (AI) · contracts      │
            modules: clans · files · notes · saved · diary · reminders · share        │
                     (+ contracts.ts: chat, tasks, courses, exams, flashcards, …)     │
            ──────────────── one SQLite file per device (teacher.db) ────────────────┘
packages/design (tokens + components, no data access) · packages/world (lazy 3D scenes, view models only)
```

* **Dependency rules** (enforced by `packages/clan/test/boundaries.test.ts`): core never imports modules; a module imports
  core and other modules' `index.ts` only; a module's SQL names only its own `<prefix>_` tables (migrations refuse anything
  else); the only readers of classroom tables are `clans/classroom-import.ts` and `files/classroom-adopt.ts`, read-only;
  UI packages never import backend packages; the renderer reaches CLAN only through the preload API.
* **Composition root** `packages/clan/src/index.ts` is the one file that knows every module.
* **Personal sync** (`modules/sync`, [SYNC.md](SYNC.md)) reads and writes module data only through each module's
  `syncProviders()`; it talks to other devices through a `SyncTransport` (LAN today).
* **Communication**: direct calls to public APIs for queries/commands, typed domain events for reactions
  ([EVENTS.md](EVENTS.md)), explicit references for shared content ([RESOURCE_STORE.md](RESOURCE_STORE.md)), permission-aware
  queries everywhere ([PRIVACY_MODEL.md](PRIVACY_MODEL.md)). Module list and legacy names: [MODULES.md](MODULES.md).
* **Universal join.** The classroom server is the generic CLAN session host: `startClassroomServer({ clan: { type, id } })`.
  The desktop creates the canonical CLAN first (or reuses a course's CLASSROOM CLAN) and passes its id; members' devices
  record the CLAN they joined (`clans.recordJoined`). Capabilities, not types, decide authority ([PROTOCOL.md](PROTOCOL.md#clan-sessions-universal-join)).
* **The classroom server owns live sessions** (pairing, TLS, transfers, assignments, receipts) for every CLAN type; CLAN
  modules own the canonical CLAN, membership and personal data.

## Classroom transport (milestones 0–2.75)

```
 Teacher laptop (Electron)                                   Students (Electron / iOS / Android)
 ┌───────────────────────────────────────────┐               ┌─────────────────────────────┐
 │ Renderer (React)  ──IPC──  Main process    │   (pairing, keys, pins, file I/O in main)               │ UI                          │
 │   teacher dashboard        │               │   DNS-SD      │  @classroom/client          │
 │   uses WS w/ teacher token ├─ Fastify HTTP ◄───browse──────┤   joinByCode() ─POST /api/join
 │                            ├─ WebSocket /ws ◄──────────────┤   ClassroomConnection (WS)  │
 │                            ├─ node:sqlite (teacher.db)     └─────────────────────────────┘
 │                            └─ DNS-SD advertise (_classroomlan._tcp)
 └───────────────────────────────────────────┘
```

* **Teacher is the authority.** The classroom server runs *inside the Electron main process* (no child process, no
  Docker). All permission decisions use the server-side principal derived from the bearer token.
* **No native Node modules.** SQLite is Node's built-in `node:sqlite` (Electron 44 ships Node 24.21), mDNS is the
  pure-JS `bonjour-service`. Packaging needs no `electron-rebuild`.
* **One student client for all platforms.** `@classroom/client` uses only `fetch` + `WebSocket`, so the desktop
  renderer, React Native and the Node load simulator run the same code.
* **Control vs bulk.** WebSocket carries small JSON control messages only. File bytes go over streamed HTTP with Range
  resume and SHA-256 verification in both directions (FILE_TRANSFER.md).
* **Domain vs transport.** `Classroom`, `Resources`, `Assignments` take principals, ids and Node streams; they know nothing
  about HTTP. `server.ts` is a thin adapter (auth header → principal, params → ids, errors → status codes). On the client,
  all authenticated HTTP goes through `api()` / the Node transfer functions. An encrypted transport can replace the adapter
  layer without touching the file/assignment domain.
* **Managed storage.** `<userData>/storage/{resources,submissions,tmp}`; every path is built from server-generated UUIDs (+ a
  sanitized name for submissions) and re-checked to stay inside the root.
* **Desktop file I/O is main-process only.** The renderer passes opaque ids (resource ids, dialog pick ids), never paths.
* **Bind narrowly.** The server listens on the selected classroom interface address only, not `0.0.0.0`.
* **Two listeners.** Plaintext *bootstrap* (DNS-SD target) serves only OPAQUE pairing; *HTTPS* (TLS 1.3, per-class CA + leaf)
  serves every classroom API and WSS. Clients learn the HTTPS port, CA and leaf pin only from the OPAQUE-authenticated binding
  ([PAIRING_AND_TRUST.md](PAIRING_AND_TRUST.md)).
* **Identities in the OS keystore.** Device key, teacher signing key and OPAQUE server setup are `safeStorage`-encrypted
  (`apps/desktop/src/main/keystore.ts`). The server package takes the teacher identity as an option and never touches storage.
* **Pinning in two stacks.** Node-side requests (downloads, uploads, pairing in main) use `pinnedTransport` (undici + ws trusting
  only the session CA + SPKI pin); renderer WSS goes through Chromium, constrained by `session.setCertificateVerifyProc`
  (`apps/desktop/src/main/trust.ts`) to the same pins. The `Transport` interface is the seam for the future mobile native transport.
* **Teacher UI uses the same API as students** (with a teacher token handed over IPC), so there is exactly one
  authorization path.

Planned (not built): mobile OPAQUE binding + pinned native transport, LiveKit sidecar for media (M4), Windows Direct Mode (M3). See PROGRESS.md.

## Control plane vs data plane (Milestone 2.75)

```
CONTROL PLANE — always the teacher (pinned HTTPS/WSS, teacher Ed25519 signatures)
  lifecycle · approvals · permissions · lock/end · official resources · assignments · (later: quizzes, groups, presenting, exam)
  signs manifests / peer endorsements / peer capabilities / receipts · tracker of who holds which chunks · revocation push
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
DATA PLANE — teacher or peers, chosen per mode; correctness never depends on who carried the bytes
  teacher Range streaming ──┐
  peer servers (HTTPS, teacher-endorsed TLS key, capability + holder proof) ──┼──▶ chunk SHA-256 (manifest) ──▶ file SHA-256 ──▶ atomic rename
  scheduler: own slice from teacher, rest from peers, teacher fallback ─────┘
```

* `packages/protocol/src/peer.ts` / `network.ts` — signed data-plane objects, mode axes.
* `packages/server/src/peers.ts` — teacher-side registry (signs endorsements/capabilities, tracks availability). No bytes.
* `packages/client/src/swarm.ts` — platform-neutral scheduler, peer auth, sources. `peer-node.ts` — chunk store, peer server,
  `PeerAgent` (the desktop `ResourceTransport`). `transports.ts` — the mode-independent boundaries.
* Mobile (2.6): OPAQUE in an isolated WebView + native pinned TLS module; downloads from peers, does not seed.
Details: [PEER_ASSISTED_MODE.md](PEER_ASSISTED_MODE.md), [TRANSPORT_MODES.md](TRANSPORT_MODES.md), [MESH_MODE.md](MESH_MODE.md).

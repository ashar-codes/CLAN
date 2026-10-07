# Architecture

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

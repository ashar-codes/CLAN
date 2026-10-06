# Architecture

```
 Teacher laptop (Electron)                                   Students (Electron / iOS / Android)
 ┌───────────────────────────────────────────┐               ┌─────────────────────────────┐
 │ Renderer (React)  ──IPC──  Main process    │               │ UI                          │
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
* **Control vs bulk.** WebSocket carries small JSON control messages only. Bulk file transfer (Milestone 2) will use
  streamed HTTP with Range support, never base64 over WS.
* **Bind narrowly.** The server listens on the selected classroom interface address only, not `0.0.0.0`.
* **Teacher UI uses the same API as students** (with a teacher token handed over IPC), so there is exactly one
  authorization path.

Planned (not built): LiveKit sidecar for media (M4), file repository (M2), Windows Direct Mode (M3). See PROGRESS.md.

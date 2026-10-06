# Security

Last reviewed: 2026-10-06 (Milestone 1). Re-review with every milestone.

## Model
* The teacher's app is the only authority. Students are untrusted; the LAN is untrusted.
* The 6-digit code is a **discovery/convenience gate, not a credential**. Default policy additionally requires teacher
  approval. After joining, every request is authorized by a 256-bit random bearer token (`crypto.randomBytes(32)`).

## Controls implemented
| Threat | Control | Test |
|---|---|---|
| Join-code brute force | 5 failures / 5 min per source IP → 5 min lockout; 50 failures / min classroom-wide → 1 min lockout; constant-time compare | `unit: wrong code…`, `integration: code guessing…` |
| Code exposure | Code is never advertised over mDNS | — |
| Token theft from DB | Only SHA-256 of tokens stored | — |
| Token replay / stale sessions | Sliding 30-min idle expiry; rejoin rotates token; removal/blocking/end invalidates | `tokens expire…`, `rejoin rotates…` |
| Privilege escalation / fake teacher commands | Teacher-only message set checked against the server-side principal; client-supplied role fields ignored | `student cannot perform teacher actions` |
| Cross-session leakage | Token lookup is scoped to the session id; teacher token is per session | `tokens do not cross classrooms` |
| WebSocket spoofing | Must authenticate within 5 s; unauthenticated messages close the socket | `invalid token…` |
| Malformed input / injection | zod schemas on every inbound message; control characters rejected in names; parameterized SQL only | `rejects malformed…`, `profile validation` |
| Resource exhaustion | 16 KB HTTP body, 64 KB WS message, max 200 pending join requests | `rejects malformed and oversized…` |
| Exposure on extra interfaces | Server binds only the chosen interface address | — |
| Renderer compromise | `contextIsolation`, `sandbox`, no `nodeIntegration`, CSP without remote scripts, navigation/new windows blocked, all permission requests denied, IPC args validated in main; deviceId owned by main | — |
| Tracking | No analytics, telemetry or remote calls of any kind | — |

## Known gaps (tracked)
* **Traffic is plaintext HTTP/WS on the LAN.** Anyone sniffing the Wi-Fi can read join codes and tokens and hijack a
  session. Planned: TLS with a per-session self-signed certificate whose fingerprint is pinned via the join exchange,
  or a Noise-based channel using an established library. Not invented here.
* `deviceId` is a random UUID, not a key pair. The "auto-approve known devices" policy and "approved device rejoins
  without re-approval" therefore trust a UUID that a determined attacker on the LAN could copy (it is never broadcast,
  but is sent in plaintext — see above). Planned: Ed25519 device keys stored in OS secure storage.
* Permissive CORS (`*`) is intentional: auth is bearer-only with no cookies, so a web page gains nothing ambient.
* Throttle state is in memory; restarting the teacher app resets counters (and issues a new code).

# Security

Last reviewed: 2026-10-07 (Milestone 2). Re-review with every milestone.

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

## File transfer & submissions (Milestone 2)
| Threat | Control | Test |
|---|---|---|
| Path traversal / arbitrary read | URLs carry only UUIDs (regex-validated); storage paths derived from UUIDs and re-checked to be under the root; lookup always scoped to the session | `path traversal and non-id paths…`, `Storage refuses…` |
| Arbitrary write (server) | Submissions written to `submissions/<session>/<uuid>/<safeFileName>`; temp files named by upload UUID | `a malicious file name is stored…` |
| Arbitrary write (student) | Server-provided names re-sanitized client-side; final path = unique name inside the class download folder; partials in `.partial/` by UUID | `a malicious server-provided name cannot escape…` |
| Malicious names (`..`, absolute, `\`, NUL, bidi overrides, reserved Windows names, trailing dots, 5 MB names) | `safeFileName` (NFC, last segment only, control/forbidden/bidi chars replaced, reserved names prefixed, ≤120 bytes, bounded work); display name stored separately | unit `safeFileName…` |
| Header injection via Content-Disposition | ASCII fallback with quotes/CR/LF replaced + RFC 5987 percent-encoded UTF-8 name | `contentDisposition cannot inject…`, `serves headers…` |
| MIME sniffing / auto-execution | Always `application/octet-stream` + `nosniff`; desktop "Open" only for an allowlist of document/media types, otherwise "Show in folder"; teacher can only *reveal* submissions, never open them; archives never extracted | — |
| Unauthorized / cross-class download | Every content request: valid unexpired token, this session, approved student or teacher, resource ready + available | `rejects missing, garbage, pending, removed, blocked and expired tokens`, `cross-session isolation…` |
| Resource enumeration | Identical 404 for nonexistent, hidden and other-session ids; UUIDv4 ids | `cross-class…` |
| Overwrite / read another student's upload | Upload lookups require `(uploadId, memberId, session)` | `a student cannot read, write or overwrite…` |
| Spoofed identity in requests | Body is schema-parsed (unknown fields dropped); identity comes only from the token | `spoofed identity fields…` |
| Duplicate submissions on retry | Unique `(member, idempotencyKey)`; concurrent inits collapse; per-upload lock across finalize | `idempotency…` |
| Tampered / truncated files | SHA-256 verified on both sides before a file becomes visible; overrun → 413; mismatch → 422 and temp deleted | `hash mismatch…`, `corrupted partial…`, `declared size smaller…` |
| Resource exhaustion | Concurrency caps (global/per student), per-student request rate limit, idle watchdog, pending-upload cap, disk reserve, max submission size, per-session file/assignment caps, strict single-range parsing | `file resource limits`, `caps unfinished uploads…` |
| Zip bombs | Archives are never extracted or inspected | — |

Note on hashes: SHA-256 protects against corruption and partial writes. Against an **active network attacker** it does not
help while the transport is plaintext (the attacker can change both bytes and the advertised hash). That is the
transport gap below.

## Known gaps (tracked)
* **Traffic is plaintext HTTP/WS on the LAN.** Anyone sniffing the Wi-Fi can read join codes and tokens and hijack a
  session. Planned: TLS with a per-session self-signed certificate whose fingerprint is pinned via the join exchange,
  or a Noise-based channel using an established library. Not invented here.
* `deviceId` is a random UUID, not a key pair. The "auto-approve known devices" policy and "approved device rejoins
  without re-approval" therefore trust a UUID that a determined attacker on the LAN could copy (it is never broadcast,
  but is sent in plaintext — see above). Planned: Ed25519 device keys stored in OS secure storage.
* **Plaintext also affects files:** classroom files and submissions can be read or replaced in transit by anyone able to
  intercept LAN traffic, and receipts are not signed (a student can't prove a receipt to a third party beyond the teacher's
  own database). Planned with the transport work: teacher identity key, signed receipts.
* Desktop "Open" allowlist includes Office documents, which may contain macros; Office's own protected-view/macro policy applies.
* Students report their own download state; a student can lie about having downloaded a file. It is informational only.
* Permissive CORS (`*`) is intentional: auth is bearer-only with no cookies, so a web page gains nothing ambient.
* Throttle state is in memory; restarting the teacher app resets counters (and issues a new code).

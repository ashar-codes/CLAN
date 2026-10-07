# Security

Last reviewed: 2026-10-07 (Milestones 2.6 and 2.75). Re-review with every milestone.
Pairing, transport, identities, tokens, receipts and the full threat model: **[PAIRING_AND_TRUST.md](PAIRING_AND_TRUST.md)**.

## Model
* The teacher's app is the only authority. Students are untrusted; the LAN, discovery and addresses are untrusted.
* The 6-digit code is a short-lived pairing secret used **only** as the OPAQUE password. It is never sent, stored, or used
  as a key. It authenticates the TLS identity of the classroom to the student and the student to the classroom.
* After pairing, all classroom traffic is HTTPS/WSS (TLS 1.3) pinned to a per-class certificate authenticated through OPAQUE.
  A plaintext listener exists only for the OPAQUE exchange and serves nothing else.
* Device identity is an Ed25519 key in OS-protected storage; trust is bound to its fingerprint plus a fresh proof of possession.
* Receipts are Ed25519-signed by the teacher's long-term key and verifiable offline.

## Dependency choices (Milestone 2.5)

| Need | Chosen | Why | Rejected |
|---|---|---|---|
| PAKE | `@serenity-kit/opaque` 1.1.0 | Maintained (1.1.0, Feb 2026) binding of `opaque-ke` (audited Rust OPAQUE, RFC 9807); WASM embedded, works in Node and Electron main without native builds; supports custom identifiers. | Home-made PAKE (never); SRP/SPAKE2 packages (older, weaker fit). |
| PAKE on React Native (2.6) | the **same** `@serenity-kit/opaque` 1.1.0 build, run in an isolated WebView (`react-native-webview` 13.16.1) | No maintained RN binding of OPAQUE 1.x exists; `react-native-opaque` 0.3.1 is pinned to 0.8 and verified **wire-incompatible**; other WASM packages wrap different opaque-ke builds. Hermes has no WebAssembly, so the official WASM runs in a WebView behind a 3-operation typed bridge. Identical library ⇒ compatibility is not a guess. | 0.8 on both sides; home-made PAKE; less-maintained WASM forks. |
| Mobile pinned TLS (2.6) | local Expo module: iOS URLSession + `SecTrust` with the class CA as sole anchor + SPKI pin; Android OkHttp + `X509TrustManager` over a KeyStore holding only the class CA + SPKI pin | Platform-native TLS; no trust-all, no `rejectUnauthorized:false`, user-installed CAs never count. | Third-party pinning libraries (they pin on top of system trust and reject a per-class CA). |
| X.509 generation | `@peculiar/x509` 2.1 over WebCrypto | Standard, maintained, pure JS (no `openssl` at runtime). Needs `reflect-metadata`. | Shelling out to `openssl`; `node-forge` (no ECDSA certs). |
| JSON canonicalization | `canonicalize` 5.1 (RFC 8785 JCS) | Reference implementation of the standard. | Ad-hoc string concatenation. |
| HKDF / HMAC / Ed25519 verify | `@noble/hashes`, `@noble/curves` 2.4 | Audited, dependency-free, identical on Node, Electron and Hermes. | Per-platform implementations. |
| Pinned HTTP/WS in Node | `undici` 8 (own fetch + Agent), `ws` 8 | Full control of TLS options (CA, `checkServerIdentity`, TLS 1.3). | Global fetch with mismatched undici internals. |

## Controls implemented
| Threat | Control | Test |
|---|---|---|
| Join-code brute force | Each OPAQUE start = one guess; incomplete attempts count; ≤ 4 unfinished per address; 5 failures / 5 min per address → 5 min lockout; 50 / min classroom-wide → 1 min lockout | `unit: wrong code…`, `integration: code guessing…`, `security: guessing without finishing…` |
| Code exposure | Never advertised, transmitted, logged, or stored (old stored codes scrubbed by migration 3) | `security: the join code is never persisted` |
| Token theft from DB | Only SHA-256 of tokens stored | — |
| Token replay / stale sessions | Tokens only inside TLS; sliding 30-min idle + 8-h absolute expiry; rejoin/reconnect rotates; removal/blocking/end invalidates | `tokens expire…`, `absolute lifetime…`, `rejoin rotates…` |
| Privilege escalation / fake teacher commands | Teacher-only message set checked against the server-side principal; client-supplied role fields ignored | `student cannot perform teacher actions` |
| Cross-session leakage | Token lookup is scoped to the session id; teacher token is per session | `tokens do not cross classrooms` |
| WebSocket spoofing | Must authenticate within 5 s; unauthenticated messages close the socket | `invalid token…` |
| Malformed input / injection | zod schemas on every inbound message; control characters rejected in names; parameterized SQL only | `rejects malformed…`, `profile validation` |
| Resource exhaustion | 16 KB HTTP body, 64 KB WS message, max 200 pending join requests | `rejects malformed and oversized…` |
| Exposure on extra interfaces | Server binds only the chosen interface address | — |
| Renderer compromise | `contextIsolation`, `sandbox`, no `nodeIntegration`, CSP (`connect-src https: wss:` only, no remote scripts), navigation/new windows blocked, permission requests denied, IPC args validated in main; pairing, keys, pins and all file I/O live in main; renderer passes opaque ids only | E2E: http/ws blocked |
| Plaintext downgrade | No classroom route on the plaintext listener; clients refuse non-https/wss URLs; Chromium CSP blocks http/ws | `security: downgrade…`, E2E |
| Web pages on the LAN / DNS rebinding | No CORS headers; WS upgrades refused for web origins; bearer tokens only (no cookies); pinned self-issued certs are not trusted by browsers anyway. Host header is not checked (TLS pin + no ambient credentials make it moot). | `security: no CORS…` |
| Secrets in logs | Fastify logging off; single `logError` path through `redact()` (tokens, PEM keys, long base64 blobs, 6-digit codes, OPAQUE fields); CLI never prints tokens/keys | `security: redact()…` |
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

## Pairing, transport and identity (Milestone 2.5)
| Threat | Control | Test |
|---|---|---|
| Wrong code / fake classroom | OPAQUE fails client-side; nothing issued; attempt counted | `security: wrong code…`, `discovery points at a fake classroom…` |
| Binding tampering (pin, cert, session id, expiry, port, teacher key, MAC) | HMAC-SHA256 under OPAQUE-derived key over JCS(binding); client rejects | `security: binding tampered in transit (…)` ×6 |
| Stale binding replay | Per-attempt keys; pairing id + expiry checked | `security: stale binding replay…`, `client-side: an expired binding…` |
| Certificate substitution | Only the session CA is trusted + leaf SPKI pin, in Node and Chromium | `security: certificate substitution…`, `pinned transport also rejects…`, E2E |
| OPAQUE message replay | Single-use attempt state; identifiers bound to session | `security: OPAQUE message replay…` |
| Copied public key / wrong private key | Ed25519 proof over a fresh challenge | `security: copied public key…`, `device-key reconnect: copied public key…`, E2E clone |
| Eavesdropper reusing the plaintext binding | Join also needs HMAC under K_join | `security: a valid signature without the OPAQUE-derived MAC…` |
| Replayed / expired / cross-class challenges | Single use, 2-min TTL, session-bound | `replayed signed join…`, `expired challenge…`, `challenge/proof from class A…` |
| Known-device impersonation | Trust = approved key fingerprint + proof; same roll number on a new key = `new_device` | `known device auto-approves only with the same key…`, `pre-2.5 UUID trust is not carried over…` |
| Receipt tampering / forgery | Ed25519 over JCS(payload); verifier pins the paired teacher key | `signed receipts` (11 tests) |

## Peer-assisted data plane (Milestone 2.75)
Principle: **a network role never confers authority**. Peers can only move bytes; what the bytes must be, who may serve, and who
may request are all decided by teacher-signed objects verified against the teacher key from pairing.

| Threat | Control | Test |
|---|---|---|
| Malicious peer alters chunk / serves wrong chunk / another resource's chunk / stale version | Every chunk checked against the teacher-signed manifest before storage; whole-file hash before rename; source avoided 10 min | `peers: corrupt / wrong-chunk / lying / refusing / slow…` |
| Forged or tampered manifest (name, chunk hash, total hash, version, other class, peer-signed) | Ed25519 verification with the paired teacher key; session + resource id + chunk-count consistency | `resource manifests` |
| Fake peer discovery / impostor at a peer's address | Sources only used after the endorsement verifies; TLS must match the endorsed CA + leaf pin | `impostor at a peer address…` |
| Peer impersonation (copied public key, wrong private key) | Endorsement binds device key ↔ TLS key; requests need a holder proof signed by the capability's device key | `legitimate request succeeds; none / wrong private key…` |
| Unauthorized requester / cross-class / forged / expired capability | Teacher-signed capability, session-bound, 15 min; proof names the serving peer | `expired, forged (peer-signed) and cross-class capabilities fail` |
| Removed / blocked student keeps downloading from peers | No new capabilities/endorsements; dropped from tracker; `peer.revoked` deny list enforced by peers; ≤ 15 min expiry backstop | `removed / blocked members…` |
| Peer DoS (request floods, slowloris) | Per-requester rate limit, concurrency cap, header/request timeouts, pause switch | `peer endpoints: path traversal is refused; request floods are rate-limited` |
| Path traversal on peer endpoints | Strict route regex (UUID + integer), no filesystem paths | same |
| Topology manipulation (lying about availability, hogging) | Availability is a hint; lies cost the liar (`404` skip, failures avoid); teacher is always a fallback | `a partial peer…`, `lies` case |
| Peer claims teacher powers / mints capabilities while teacher is offline | Only teacher-signed objects are accepted; capabilities aren't bearer tokens; WS teacher commands refused | `authority stays with the teacher` (2 tests) |
| Private data leaking through peers | Assignments are never peer-shared | — (design) |

Out of scope: a removed student keeps files it already downloaded; peers learn which classmates fetch which resources from them.

## Universal CLAN join

* Authority is a server-side capability check (`MESSAGE_CAPABILITY`, `capabilitiesFor(type, role)` in
  `protocol/src/clan.ts`) on top of the existing host-token check; members never receive authority capabilities, and only
  CLASSROOM hosts get `CREATE_ASSIGNMENT` (uploads also require `SUBMIT_ASSIGNMENT`). Tests: `server/test/clan.test.ts`.
* Network/security code never branches on `CLASSROOM` (architecture test); the one exception is the known-device trust scope,
  which stays keyed by course title for classrooms (compatibility) and by `clan:<id>` for other types, so trust never leaks
  between CLANs that share a name.
* Cross-CLAN isolation: tokens are bound to one session (`members.session_id`), also when several CLANs share a database.
* Host impersonation: authority data is verified against the PAKE-learned host key only; member- or peer-signed manifests,
  endorsements and capabilities are rejected; relaying peers gain no capabilities.
* Temporary CLANs: after `expiresAt` (or End) joins are refused and member tokens stop working; downloaded files are not touched.

## CLAN Direct Network
* The six-digit code stays the only human secret (OPAQUE). Wi-Fi credentials are random per session, never derived from it,
  and released only inside a completed OPAQUE exchange, AES-256-GCM-sealed under an OPAQUE-derived key (DIRECT_BOOTSTRAP.md).
* Wi-Fi association is not authorization: OPAQUE, pinned TLS, device-key proof and capabilities apply unchanged.
* BLE/QR carry no code; SSIDs carry no personal data; the host's name reaches members only after pairing.
* Native helper: fixed, schema-validated command set; no shell; firewall rules are program/port/LocalSubnet/Wireless-scoped.
* Mock backend can never be selected in a packaged build (`createDirectBackend`).

## Known gaps (tracked)
* **Mobile is implemented but not device-verified.** The bridge page has been run in Chromium (Electron) and the iOS trust
  code on Apple's Security framework (macOS); the Swift/Kotlin modules have not been compiled for iOS/Android here.
* Mobile OPAQUE runs inside a WebView: the 6-digit code passes over the app↔WebView message channel (in-process).
  JS strings can't be zeroed; login state lives only inside the WebView behind single-use handles.
* **Malware / local compromise**: anything running as the user can read tokens in memory or use the OS keystore through the app.
  Tokens are bearer tokens; proof-of-possession tokens (e.g. DPoP) were evaluated and not adopted: TLS + short lifetimes +
  device-key re-issuance address LAN theft, and DPoP wouldn't stop on-device malware that can also use the device key.
* Students self-report download progress; it is informational only.
* Opening a downloaded file runs a viewer app and inherits its vulnerabilities. A matching SHA-256 means "the teacher's
  file, unmodified", **not** "safe". "Open" is limited to PDF, text, images, audio/video and modern non-macro Office/ODF
  (`docx/pptx/xlsx/odt/odp/ods`); legacy and macro-enabled Office (`doc xls ppt docm xlsm pptm dotm xlam ppam …`),
  executables, scripts, archives and unknown types are "Show in folder" only.
* Unsigned macOS builds: Keychain access is tied to the code signature; re-signing can regenerate identities (handled and
  surfaced, but it means re-approval).
* Throttle counters and pairing state are in memory (a teacher-app restart resets them and also creates a new code).

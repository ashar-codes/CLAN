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

## Screen sharing (MEDIA.md)
* Being on the Wi-Fi/LAN grants nothing: a media token needs an authenticated, approved CLAN session. Tokens are LiveKit
  JWTs for one random room id (no CLAN name), bound to the member identity, ≤ 600 s, subscribe-only unless that identity is
  the current presenter. Other CLANs' tokens are rejected (separate per-process API secret and room).
* Expiry is only a backstop: stop/removal/block revokes publish rights and removes the participant on the SFU immediately;
  presentation ends with `member_removed` (tested).
* The SFU's API key/secret are generated per host process, never leave the host process, and the config file holding them is
  0600 and deleted once the server is up. Signaling is bound to 127.0.0.1 and reached only through the existing pinned
  TLS server (`/media/*`); RTC is UDP on the CLAN interface only (no TCP, no IPv6 global, no external IP lookup).
* Media is DTLS-SRTP (WebRTC). No certificate checks are relaxed anywhere.
* The renderer can't capture silently: the main process grants display media only for the source the user just picked from
  the list it offered; anything else is denied. Electron permission handler allows `display-capture` only. No microphone.
* No recording, no frame persistence; the test pattern source exists only in unpackaged builds with `CLAN_TEST_CAPTURE=1`.
* Gap: phones can't view yet (MEDIA.md) — not worked around with an unpinned socket.

## CLAN Intelligence (AI.md, AI_CONTEXT.md, AI_PROVIDERS.md)
* Provider credentials: OS secure storage per provider address; write-only from the UI; never in SQLite, logs, prompts or
  the renderer; only sent as `Authorization` to that address; provider errors redacted. No secure storage → no key stored.
* Context: built from module APIs as an agent principal; cross-CLAN, removed members, unshared items and non-participant
  direct chats yield nothing; Diary needs the unexpired grant plus a per-request choice; Exam Coach cannot read it.
* Prompt injection: sources fenced as untrusted data, rules first, no tools, schema-validated output, citations limited to
  given sources, proposals created only by code for the agent's allowed kinds, accepted only by the user, re-validated,
  applied atomically by owning modules. Adversarial tests: injected PDF, tag-breaking markdown, gullible model output.
* Files opened from a citation: readable by this person and only PDF/TXT/Markdown are opened; anything else is revealed.
* `pdfjs-dist` 6.3.289 (Mozilla PDF.js) parses untrusted PDFs in the main process (text layer only; font-face loading disabled),
  no font loading, 60 MB cap; it is loaded lazily on first extraction.

## Personal device sync (SYNC.md)
* Linking: a 60-bit, 2-minute, single-use code (not the CLAN join code). HMAC proofs are bound to the TLS SPKI the joiner
  saw, both device keys and both nonces. The joiner signs, proving it holds its key. Explicit approval on a trusted
  device; the registry is signed by trusted devices; a revocation can't be undone.
* Sync requests: pinned TLS 1.3 to the peer's registered certificate, plus an Ed25519 signature over method, path, time,
  nonce and body hash. Replay, skew, unknown and revoked devices are refused.
* Scope: owner's personal data only. Never CLAN host secrets, memberships, OPAQUE material, TLS session keys, AI keys,
  other members' messages or other users' files. Rows owned by another user are refused; Diary is opt-in.
* Limit: revocation can't wipe a device that is already compromised or offline. Its local copy stays.

## Mobile (MOBILE.md)
* **Storage:** core's database is SQLCipher with a Keychain/Keystore key. Device and sync keys and the AI key are in
  secure storage (`*_THIS_DEVICE_ONLY`) and never in the database. AI keys are keyed by provider address and sent only
  there.
* **TLS:** classroom and sync traffic trusts only the pinned CA and SPKI (TLS 1.3). First contact exists only for
  linking (proofs bind the key seen). Binary WebSocket frames use the same pinned client. Insecure schemes are refused.
* **Shared files and URIs:** only `content://` streams granted with the share intent are read. Items are capped, file
  names reduced, and everything is re-validated in JS (`share/items.ts`, tested). Nothing is posted automatically, and
  only `file://` copies inside the sandbox are captured.
* **Chat:** no composer while a conversation opens, and drafts are per conversation (a fixed bug: text carried over to
  another audience). The audience of a file is fixed before upload, and the host re-checks the scope on every send.
* **CLAN authority:** the phone files into a CLAN only where it is an active member (core check). Linking a device
  grants no CLAN rights. A revoked phone is refused and learns it on its next request.
* **Deep links:** `clan://share?id=` accepts only a UUID; `clan://capture` keeps the strict parser.
* **Media and permissions:** RECORD_AUDIO is blocked in the Android manifest and the microphone is never captured.
  The camera is asked each time and photos are taken without EXIF. Location/BLE is asked only when the host wasn't
  found or typed in.
* **Release builds:** no development fallbacks (no trust-all, no plaintext keystore). The dev client is only in debug
  builds.

## Closed-beta hardening (Phase 13, BETA_READINESS.md)
* **Packaged desktop:** Electron fuses off for `RunAsNode`, `NODE_OPTIONS`, `--inspect`; only the asar loads, with embedded
  asar integrity validation (configured; a tampered asar was not tried). Verified: an injected `NODE_OPTIONS --require` and `ELECTRON_RUN_AS_NODE` both do nothing in the packaged app,
  but run in plain Electron). Without this any local process could run code as CLAN, with CLAN's keychain access to the
  safeStorage-wrapped AI keys. `CLASSROOM_DEV_URL` and the deterministic AI provider are ignored in packaged builds.
* **Resource limits:** per-socket ceiling of 300 messages/s on the classroom WebSocket (closed with 4400); the
  unauthenticated media proxy is capped at 256 sockets and 64 queued frames; personal-sync bodies ≤ 32 MB (pages are cut
  at 8 MB so large notes still sync), garbage JSON is a 400. A heartbeat drops sockets that answer nothing for 15 s, so a
  member whose network vanished is shown offline and stops receiving (previously "connected" until the OS gave up).
* **Phone data:** `android:allowBackup=false` (a restore onto another phone carried a database whose Keystore key can't
  follow → the app could not start). An unreadable database is moved aside, never deleted.
* **Diagnostics:** errors are logged by kind only (last 50 `{context, name, code}`, no messages). Feedback and its
  diagnostics are saved to a file the student picks; nothing is uploaded.
* **Exports** contain the student's own records only (no device keys, chats, AI keys or owner ids); Diary only when
  ticked. Files are written `0600`.

## Beta release (Phase 14)
* **Signing material:** the Android upload keystore is outside the repo (`~/.clan-signing`, 0600, PKCS#12) and its
  password lives in the login keychain; release builds fail without it instead of falling back to the debug key.
  Verified: a debug-signed update is refused by Android (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) and the data stays.
* **Packaged desktop:** every test-only switch is ignored when packaged (downloads/export folders, peer upload throttle,
  test AI provider and its status flag, mock Direct backend, test capture, dev URL). `CLASSROOM_USER_DATA` is still
  honoured (a disposable profile for install tests; it only changes where the same user's own data lives).
  `scripts/release-audit.sh` checks each package for keys, env files, source maps, tests, dev URLs and foreign
  native binaries.
* **Integrity:** `SHA256SUMS` for every installer; APK certificate fingerprint published in SETUP.md.
* **Windows firewall:** program-scoped, local-subnet-only inbound rules (TCP CLAN, UDP discovery, UDP screen sharing),
  removed on uninstall — unverified on Windows.
* **macOS keychain:** CLAN's keys are wrapped by the login-keychain item "Classroom LAN Safe Storage". Ad-hoc builds have
  a cdhash-only designated requirement that changes every build; on the build Mac an update between two ad-hoc builds
  kept all identity keys (tested), but on other Macs macOS may ask for consent after an update and a denial means a new
  identity (old key files are kept as `*.unreadable-*`, never exported). Developer ID signing gives a stable requirement.
* **iOS:** the remote-push entitlement is removed (no push server exists); purpose strings say exactly when camera and
  photos are used and that the microphone is never turned on.

## Known gaps (tracked)
* A packaged desktop app still accepts Chromium's `--remote-debugging-port`: a process running as the same user can
  drive the UI (and the preload API) — the same reach it already has over the unencrypted desktop database.
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

## Phase 14.2 Classroom sharing

Classroom student file uploads default to disabled. Only the authenticated host may change the sharing rule or
review uploads. Teacher-approval bytes stay in quarantine without a public resource, manifest or download. Student
membership, target scope and policy are rechecked on retries and immediately before publication after asynchronous
copying; the originally declared SHA-256 is checked again. Approval cannot restore a removed student's rights.
Review IDs are session-scoped, moderation is idempotent, and pending uploads count against bounded upload quotas.
The existing pinned transport and teacher-only checks remain mandatory. Other CLAN types retain their permissions.

### Phase 14.2 file views and export

Preview, Open With and Save recheck the recorded SHA-256 and accept resource/session IDs rather than renderer-selected
paths. Embedded preview is limited to bounded plain text and validated PNG/JPEG; active documents never enter an
embedded browser. Open With retains the safe extension allowlist. All types may be exported as a new verified copy.
Android sources are canonical regular files inside the app sandbox; viewer URIs receive temporary read grants.
SAF export streams into a new empty document and verifies size/hash by reading back the destination, removing only
the new failed copy. Desktop uses exclusive creation. Private keys and unrelated files are outside these interfaces.

## Internal test candidate audit, 2026-10-12

Application revision: `6f7d946cc46f19805d6bc423e56c7d6642d87410`. Existing unreadable identity keys are no longer silently regenerated; an access error preserves the original file and refuses startup. Corrupt rollback-fence records refuse hosting, and disk-write failures prevent handover acceptance/activation/replay acknowledgement. Regression coverage includes actual filesystem failure and shared-adapter fence serialization. See LOCAL_QA_PHASE_14_3.md for earlier authority omission, SessionGate, input queue, file range, QR and native permission repairs.

The dependency audit still reports 0 critical, 2 high and 2 moderate findings in build/development dependency paths. This is not a clean scan. Desktop database/files are not application-encrypted; temporary expiry is active-store deletion, not forensic erasure of WAL, backups or another participant's saved copies. Mobile power-loss fsync, physical radios, actual microphone/camera, host handover across physical combinations and OS background policy remain unverified. No public release approval is granted.

Desktop profile concurrency: the final TEST source acquires Electron's per-userData process lock before keystore/database initialization. Duplicate launches forward bounded capture URLs through the existing strict intake parser; they do not open a second writer. Independent QA profiles retain separate locks. This complements per-file fence write serialization.


## BTC-1 audit follow-up (2026-10-12)

See [BTC_1.md](BTC_1.md) for the root causes, opt-in foreground/tray availability, authenticated durable delivery, bounded call intent, notifications, real-discovery radar and mobile ownership. This is an internal TEST candidate; hardware and public-release gates remain open. Preserve OS-protected keys and existing profiles.

### BTC-2A internal LAN discovery

The optional administrator LAN directory requires explicit client opt-in, certificate/SPKI pinning and signed, enrolled public-key requests with replay/expiry limits. It returns untrusted rotating discovery hints; existing peer authentication, blocking, attachment consent and CLAN OPAQUE/host authority remain authoritative. Native pinned transports refuse redirects. No payload forwarding or firewall changes are implemented. See [trust, deployment, limits and tests](BTC_2A_LAN_DIRECTORY.md) and [verification record](BTC_2A_RESULTS.md).

BTC-2A follow-up regression repairs serialize multicast publication during privacy changes, queue a newest-state directory refresh after an in-flight round, close blocked direct sessions and fence shutdown. Malformed persisted directory certificates cannot stop ordinary direct networking, and invalid candidates do not replace a working desktop configuration. The directory remains a small trusted administrator service with global-rate-limit and native response-buffering limitations. The inherited dependency scan remains 0 critical / 2 high / 2 moderate, not clean; [the evidence record](BTC_2A_RESULTS.md#security-findings-and-limits) identifies advisories and applicability.


## BTC-2B+C local media audit (2026-10-13)

Direct video retains signed People signaling, friendship/block authorization and pinned peer identities. CLAN meetings reuse bearer authentication inside pinned TLS, current membership/capabilities, host-epoch fencing and local LiveKit. Join tokens expire after two minutes and have source-scoped grants and immutable lease metadata. The gateway checks signature/expiry and the current room/identity/lease; revocation disconnects established media. Per-participant authorization generations fence in-flight token requests across removal/reinvitation. Stale hosts terminate media on the bounded three-second sweep; failed revocation closes the SFU, which cannot restart in the closed session. Server secrets are not returned to clients.

Capture cancellation, late permissions, background camera shutdown and shared capture ownership have regression tests. Native meeting audio-session cleanup finishes before releasing capture ownership; an unstarted meeting cannot stop a direct call's audio session. Native camera IDs replace the browser `default` placeholder and preserve camera restart/switch behavior. Group media uses DTLS-SRTP **transport encryption**, with access available to the SFU host; group E2EE and recording are not claimed. Scope, limits, unresolved dependency advisories and actual evidence are in [BTC_2C_RESULTS](BTC_2C_RESULTS.md) and [BTC_2BC_VERIFICATION](BTC_2BC_VERIFICATION.md). This is software QA, not public-release approval.

## BTC-2D/F review — 2026-10-13

Remote control is disabled until explicit, per-session native consent. Every packet is authenticated through existing pinned meeting transport, strictly bounded and sequenced, tied to both current participant leases, host authority and a live screen SID. Replay, unauthorized approval, stale grants and queue/rate abuse fail closed. Native one-second heartbeat loss, local input, protected surfaces, OS permission loss, expiry and explicit stop terminate injection. No keyboard/clipboard logging, command execution, unattended access or privilege elevation. The trusted CLAN host can inspect control input; there is no claim of group/control E2EE against that host. Whole-display control only; safe window-scoped injection is not implemented. Native capture approval is bound to a random selection ticket, meeting, exact published track SID and renderer owner. Native lifetime/heartbeat deadlines use monotonic time; a wall-clock rollback cannot prolong a grant.

A regression review exposed initial-only media proxy authorization and a termination race: pinned signaling now checks current leases on forwarding/open and periodically closes revoked sockets; room termination explicitly removes participants before deleting the SFU room. Dedicated pinned-channel revocation tests retain consent/membership requirements.

Timetable images are private, bounded PNG/JPEG files verified in the canonical store before OCR/viewing; JSON import and personal-sync payloads are strict and bounded. OCR runs locally and requires reviewed corrections. AI access is denied and timetable tables cannot leak through CLAN host handover. Deletion retains sync tombstones; original files are preserved. Notifications omit subject, teacher and room contents.

Carry-forward limits remain: physical media/multi-router/permission tests, physical iPhone signing, two high and two moderate dependency advisories, and desktop database data-at-rest encryption limitations. No security control, signing identity or existing profile was replaced. Final results and platform limits: [BTC-2D/F verification](BTC_2DF_VERIFICATION.md).

Native API contracts: [Apple CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent), [Windows SendInput/UIPI](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput), [Apple Vision recognition](https://developer.apple.com/documentation/vision/vnrecognizetextrequest), [Expo local notifications](https://docs.expo.dev/versions/latest/sdk/notifications/).

## BTC-2E lifecycle review (2026-10-13)

Owner-only destructive/edit operations now explicitly reject read-only agent principals in affected Study/File/Diary modules. Sync child keys are bound to their aggregate parent and reject cross-parent collisions transactionally. Concurrent edits cannot silently restore a deleted entity: tombstone persists and the edit is kept for explicit recovery. Custom collection deletion safely moves its links to Inbox; incoming sync cannot overwrite built-in collections. File removal rechecks active membership/host fencing and refuses deletion of a stable reference still used by personal Course/Task/Exam/Timetable/recording data. CLAN cleanup retains these referenced files locally.

Named confirmations, busy guards and draft retention add UI safety; domain checks remain authoritative. No identities, encryption, media grants, native permission controls or signing settings are replaced. Remaining two high/two moderate dependency advisories and desktop data-at-rest limitations are carried forward, not marked resolved. Full feature/platform acceptance is reported separately in BTC_2E_VERIFICATION.md.

Final BTC-2E audit retains 0 critical / 2 high / 2 moderate dependency findings. Redacted staged and nine-commit implementation history scans found no secrets. Windows pagination verification passed after correcting the visible-anchor precondition; complete native workflow parity remains an acceptance blocker; software passes do not constitute hardware/privacy or public-release approval.

Search-retention follow-up: deleted flashcard text and study-tape title/timeline documents are invalidated through existing events. Authenticated personal-sync application also refreshes all timeline keys, so deleted or edited timeline text does not remain searchable on a linked device. Two-device signed fixtures cover timeline/card deletion and unchanged private ownership. This does not promise forensic erasure of immutable sync/audit history.

## BTC-2R reliability follow-up

Authenticated People reconnect preserves opt-in availability, Invisible and block rules; discovery remains an untrusted hint. Native service pulses enforce existing session deadlines and interface-change reconnect without activating capture. Desktop file-progress telemetry is bounded and deferred until host authority verification succeeds; live capture/control is never deferred past consent.

Device database recovery distinguishes confirmed SQLite corruption (CORRUPT/NOTADB or failed integrity check) from lock, permission and I/O failures. Uncertain access errors stop startup without renaming/replacing the database or rolling it back to a backup. Disposable actual-lock and corrupted-file tests verify both paths. This fixes reproduced data replacement under an exclusive lock; the intermittent Windows startup stall remains a separate unproven cause. Inherited two high/two moderate dependency advisories and desktop at-rest limitations remain unresolved.

Windows recovery diagnostics expose a protected-identity decryption failure after first-run crash. The candidate startup guard requires Chromium's existing DPAPI wrapping metadata to be durable before creating identity ciphertext; new ciphertext writes are exclusive and fsynced. It never re-encrypts/replaces existing identities or changes OS encryption. Unreadable keys remain fail-closed and preserved. Native Windows crash verification is required before claiming this issue resolved.

# Pairing and trust (Milestone 2.5)

How a student who typed `482915` ends up on an encrypted, authenticated connection to the real teacher computer,
and how identities, tokens and receipts are bound together. Code: `packages/server/src/{pairing,tls,classroom,assignments,server}.ts`,
`packages/protocol/src/trust.ts`, `packages/client/src/{pairing,node}.ts`, `apps/desktop/src/main/{keystore,trust}.ts`.

No cryptography is implemented here. Every primitive comes from an established library:

| Purpose | Construction | Library |
|---|---|---|
| Authenticate the 6-digit code (both directions) | OPAQUE aPAKE (RFC 9807; ristretto255, Argon2id key stretching "rfc-recommended") | `@serenity-kit/opaque` 1.1.0 (opaque-ke, Rust → WASM) |
| Bind TLS to the PAKE | HKDF-SHA256 (RFC 5869) + HMAC-SHA256 over RFC 8785 canonical JSON | `@noble/hashes` 2.4, `canonicalize` 5.1 |
| Transport | TLS 1.3, ECDSA P-256, X.509 per-session CA + leaf | Node `https`/`tls`, `@peculiar/x509` 2.1 (WebCrypto), `undici`, `ws` |
| Device / teacher identity, signatures | Ed25519 (RFC 8032) | Node `crypto` (sign), `@noble/curves` 2.4 (verify; mobile sign) |
| Key storage | OS keychain | Electron `safeStorage`; `expo-secure-store` (mobile) |

## Keys and their roles (never reused across roles)

| Key | Where | Lifetime | Used for |
|---|---|---|---|
| OPAQUE server setup | teacher keystore (`keys/opaque-server-setup.enc`) | per installation | OPRF/AKE server key for pairing |
| OPAQUE registration record | teacher memory | per class | derived from (session id, code); code itself is not stored |
| Session CA (ECDSA P-256) | never stored; private key discarded right after signing the leaf | per class (24 h) | sole trust anchor clients accept |
| TLS leaf (ECDSA P-256) | teacher memory only | per class (24 h) | HTTPS/WSS server key; clients pin its SPKI |
| Teacher Ed25519 | teacher keystore (`keys/teacher-ed25519.enc`) | per installation | signs receipts; stable teacher identity |
| Device Ed25519 | student keystore (`keys/device-ed25519.enc`; mobile secure-store) | per installation | proves the device on join/reconnect; its SHA-256 fingerprint *is* the device identity |
| Pairing keys K_bind, K_join | memory, ~2 min | per pairing attempt | HKDF from the OPAQUE session key |
| Bearer token | student memory; SHA-256 on teacher | ≤ 30 min idle, ≤ 8 h absolute | authorizes HTTPS/WSS requests |

## Sequence

```
Student app                         Network (untrusted)                       Teacher app
-----------                         -------------------                       -----------
                                                                              start class:
                                                                               code = CSPRNG 6 digits (shown, memory only)
                                                                               OPAQUE register(code, uid=sessionId) -> record
                                                                               session CA + leaf (P-256), pin = SHA-256(leaf SPKI)
                         <-- DNS-SD "_classroomlan._tcp" {sid,title} -- (hint only, NOT trusted)
user types 482915
OPAQUE KE1 = startLogin(code)
POST http://boot/api/pair/start {sessionId, KE1}  ---------------------------->  throttle check; inflight cap
                                                                               KE2 = startLogin(record, KE1, ids(sessionId))
                         <---------------------------- {pairingId, KE2}
finishLogin(KE2, code, ids)  -- undefined? => wrong code / impostor:
                                POST /api/pair/abort, stop (counted as a failed guess)
=> sessionKey, KE3
POST http://boot/api/pair/finish {pairingId, KE3} ------------------------->   finishLogin(KE3) -> sessionKey  (fail => counted)
                                                                               K_bind,K_join = HKDF(sessionKey, labels)
                                                                               binding = {sessionId, pairingId, title, httpsPort,
                                                                                 caCert, leafSpkiPin, teacherKey, challenge,
                                                                                 issuedAt, expiresAt(+2 min)}
                         <---------------------------- {binding, mac = HMAC(K_bind, JCS(binding))}
verify mac, sessionId, pairingId, expiry  (fail => "mitm", stop)
transport := trust ONLY caCert, require leaf SPKI == pin
J = {join-proof v1, sessionId, pairingId, challenge, fp(deviceKey), names}
POST https://host:httpsPort/api/join  ===TLS 1.3, pinned=======================>  consume pairing (single use, unexpired)
  {pairingId, profile+devicePublicKey,                                         check HMAC(K_join, JCS(J))   (proves: completed OPAQUE)
   mac = HMAC(K_join, JCS(J)), sig = Ed25519(deviceKey, JCS(J))}               check Ed25519 sig           (proves: holds device key)
                                                                               trust := known | new_device | first  (by key fingerprint)
                                                                               status := approved (open / known policy) | pending
                         <============================ {memberId, token, status, classroom}
WSS /ws {auth token}  ==========================================>  ... teacher approves ...
                         <============================ member.status approved
... files, uploads over HTTPS (same pin) ...
                         <============================ receipt = {payload, Ed25519(teacherKey, JCS(payload))}
verify receipt with teacherKey from the MACed binding  ->  "Verified ✓"
```

## Why each step is there

* **The 6-digit code is never sent, stored or used as a key.** It is the OPAQUE password. OPAQUE gives a strong shared
  session key only if both sides used the same code, and each online attempt tests exactly one guess. The code is not
  persisted (migration 3 scrubbed old plaintext codes; a test reads the raw DB file to confirm). Registration is done
  in-process at class start and only the registration record is kept, in memory, until the class ends.
* **Discovery is untrusted.** mDNS/TXT, IPs, hostnames, SSIDs and class names only say "there may be a classroom here".
  A fake classroom can't complete OPAQUE without the code, and the student's OPAQUE messages give it nothing to brute-force
  offline (the client never sends KE3 if the server couldn't prove the code).
* **Why not "send the fingerprint, then trust it".** An active attacker could replace both certificate and fingerprint.
  Here the binding (CA cert, pin, port, session id, teacher key, expiry, nonce) is MACed with a key only the two
  OPAQUE parties hold. Any change → MAC fails → the client refuses (tests: replaced pin, session id, expiry, port,
  teacher key, flipped MAC byte, stale binding replay).
* **Session CA + leaf.** BoringSSL (Electron/Chromium/Android) won't accept a self-signed leaf as a trust anchor, so each
  class gets its own CA whose private key is discarded after signing the single leaf. Clients trust only that CA and
  additionally require the leaf SPKI pin. Hostname/IP isn't checked (the pin is the identity), so an address change
  doesn't weaken anything. Not `rejectUnauthorized: false`: Node would then ignore `checkServerIdentity` failures.
* **Two proofs on join.** The HMAC under K_join proves the HTTPS request comes from whoever completed OPAQUE (an
  eavesdropper who saw the plaintext binding can't produce it); the Ed25519 signature proves possession of the device
  private key for the public key being registered. The challenge is single use, bound to the session and pairing id,
  and expires with the binding (2 min).
* **Identifiers.** OPAQUE `userIdentifier = sessionId`, client/server identifiers `classroom-lan/v1/{student,classroom}/<sessionId>`
  are bound into the AKE transcript, so a pairing can't be replayed into another classroom.
* **Canonical serialization.** Everything MACed or signed is a typed object (`type`, `v`) serialized with RFC 8785 JCS.
  No string concatenation.

## Attempt limiting

Each `/api/pair/start` is one guess (an attacker can test a code from KE2 alone, without finishing). So:
* a pairing that does not complete — client abort on wrong code, failed finish, or 60 s expiry — counts as a failure;
* at most 4 unfinished attempts per source address at once (`limits.pairInflightPerSource`), 500 overall;
* 5 failures / 5 min per address → 5 min lockout; 50 failures / min classroom-wide → 1 min lockout;
* successful pairings never count, so 40+ students joining at once don't trip anything.
Online guessing of a 10^6 space under these limits is slow; the default "teacher approves everyone" policy is a second gate.

## Approval and device trust

* Device identity = SHA-256 fingerprint of the Ed25519 public key. Names/roll numbers are display data.
* On first approval the (course, fingerprint, public key, name, roll no) is stored in `trusted_devices` with first/last
  approval times (history).
* Policy "Auto-approve devices I approved before" admits a join only if the **same key** was approved before for this
  course **and** the join just proved possession of it. Copying name, roll number, the old UUID, or even the public key
  gives nothing (tests + E2E clone).
* Same roll number from a different key → `new_device`, shown to the teacher as "New device for this roll number",
  never auto-approved. Replacing a laptop or reinstalling (new key) therefore needs re-approval — by design.
* Pre-2.5 UUID trust (`known_devices`) is deliberately not migrated.

## Tokens and reconnect

* Issued only by `/api/join` (after OPAQUE + device proof) or `/api/reconnect` (device proof for a device already in this
  session). A **pending** student gets a token that can only wait for approval (WS hello/status); every file/assignment route
  requires `approved`.
* 256-bit random, stored as SHA-256, logically bound to session + member (whose identity is the device fingerprint),
  30 min sliding idle expiry, 8 h absolute lifetime. Sent only in `Authorization` headers or the first WS message — never in
  URLs; never logged (`redact()`).
* Reconnect (token expired, app restarted): over the already-pinned TLS channel, `POST /api/reconnect/challenge` → nonce
  (60 s, single use, bound to one public key) → Ed25519 signature over `{reconnect-proof v1, sessionId, challengeId, challenge, fp}`.
  No code needed; approval state unchanged; removed/blocked devices are refused. The desktop remembers paired sessions
  (CA, pin, teacher key — no secrets) for 24 h and never re-pins an existing session id.

## Teacher identity

* The teacher's Ed25519 key reaches the student inside the MACed binding, i.e. authenticated by the class code.
* Students remember `class name → teacher key`. Same key later: "teacher ✓". A different key for a class name seen before:
  a warning banner ("now hosted from a different teacher computer") with explicit "It's my teacher — trust" / "Leave".
  The code is still required either way.

## Receipt signatures

Payload (`type: classroom-lan/receipt`, `v: 1`): receiptId, submissionId, assignmentId + title, sessionId, courseTitle,
memberId, studentKeyFingerprint, fullName, rollNo, version, submittedAt (teacher clock), late, fileName, size, sha256,
status, teacherKeyFingerprint. Signed with the teacher Ed25519 key over JCS(payload) once at acceptance and stored
verbatim (idempotent retries return byte-identical receipts). Envelope: `{payload, alg: "Ed25519", signature, teacherPublicKey}`.

Verification (`verifyReceipt` in `@classroom/protocol`; CLI `node tools/verify-receipt.ts receipt.json --teacher-key KEY`)
checks version, algorithm, that the embedded key matches the payload fingerprint, the signature, and — essential — that the
key is one the verifier trusts. The desktop trusts only teacher keys it obtained through pairing (append-only
`paired-teacher-keys.json`), shows "Verified ✓" or "Verification failed — reason", and keeps failed receipts as evidence
without ever presenting them as verified.

## Key lifecycle

* **Generation:** OS CSPRNG via Node `crypto`/WebCrypto; mobile `expo-crypto`.
* **Storage:** desktop secrets are `safeStorage`-encrypted files (`userData/keys/*.enc`, mode 0600). If the OS keystore is
  unavailable the app refuses to create identities and says so; the only plaintext mode is an explicit development switch
  (`CLASSROOM_DEV_INSECURE_KEYSTORE=1`, unpackaged builds only) with a red banner.
* **Decryption failure / key loss** (Keychain item deleted, app re-signed): the unreadable file is kept as
  `*.unreadable-<time>`, a new key is generated and the UI says so. Consequences are the normal ones for a new key: a new
  device must be re-approved; a new teacher key triggers the students' "different teacher computer" warning.
* **Rotation:** there is no silent rotation. A new device key = a new device. A new teacher key = the warning path.
* **TLS:** fresh CA + leaf per class, 24 h validity; the class ends before expiry. Teacher app restart or class restart =
  new session, new code, new CA/pin; students pair again (a session id is never re-pinned). A changed LAN IP doesn't affect
  the pin (no IP in the certificate), but the current server binds one address, so the teacher restarts the class.
* **macOS unsigned builds:** `safeStorage` uses a Keychain item tied to the app's code signature. Development, unsigned
  packaged and future signed builds are different signatures; macOS may prompt or deny access, which the app handles as
  "key regenerated" (new identity). None of this happened in this repository's dev and packaged E2E runs, but it is expected
  across re-signing.

## Threat model

| Threat | Protection |
|---|---|
| Passive Wi-Fi sniffing | All classroom traffic is TLS 1.3 after pairing. The pairing exchange reveals nothing usable: OPAQUE messages don't leak the code, the binding is public data, and the join MAC needs K_join. |
| Active LAN MITM | Can relay but not alter pairing (OPAQUE fails or the binding MAC fails); can't impersonate the TLS server (pinned CA + SPKI); can't use a captured binding (K_join). Tested with relays, TLS interceptors and binding rewriters. |
| Fake mDNS classroom | Can't complete OPAQUE without the code; learns nothing from the student's attempt. |
| Certificate substitution | Rejected in Node (undici/ws) and in Chromium (verify proc) — tests + E2E. |
| Join-code interception | Code never travels. Shoulder-surfing the code lets someone *attempt* to join; default policy still needs teacher approval. |
| Token sniffing | Tokens only travel inside TLS; short idle/absolute lifetimes. |
| Copied UUID / profile | Not identity anymore. |
| Copied public key without private key | Join and reconnect proofs fail. |
| Cross-class replay | Session id in OPAQUE identifiers, binding, proofs and receipts; single-use challenges. |
| Receipt tampering | Ed25519 signature over canonical payload; any field change fails. |
| File tampering in transit | TLS + SHA-256 verification before a download becomes visible. |
| Submission tampering in transit | TLS + server-side SHA-256 check against the declared hash. |

**Out of scope:** malware or a compromised OS on the teacher or student device (it can read keys/tokens or drive the UI);
physical access to an unlocked device; students screen-recording or sharing files after download; vulnerabilities in
viewers (PDF/Office) that open downloaded files; secure-exam lockdown; denial of service by flooding the Wi-Fi itself.

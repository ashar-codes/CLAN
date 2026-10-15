# Final security review

Scope: everything added in this phase, plus a re-check of the inherited findings. Priority order used:
security → correctness → data preservation → reliability → maintainability → performance.

## New surfaces and how they are protected

| Area | Threat | Control | Evidence |
|---|---|---|---|
| Message edit / delete for everyone | someone edits/deletes another person's message; replay; reordering; resurrection | signed envelope + recipient binding + replay table (unchanged); recipient checks `author === envelope.from` and conversation; window (1 h edit / 48 h delete); newest-wins edits; deletion is a durable tombstone, also for out-of-order arrival; 500-entry cap per sender for pre-arrival tombstones | `people-final.test.ts` (forged edit refused, stale edit ignored, replayed original stays deleted, out-of-order delete wins), desktop E2E (menu shows Edit/Delete only for own messages) |
| Delete for me | false impression of global deletion | separate action and wording; peer copy untouched | unit + UI copy |
| Reactions | arbitrary text injected as a “reaction” | emoji-only regex in protocol and core | unit |
| Replies | quoting messages from another conversation | `replyTo` resolved only within the same conversation; deleted/hidden quotes show “Message deleted” | unit |
| Onboarding / visibility default | advertising a placeholder identity; leaking profile before consent | nothing is advertised or released before a real name exists; disclosure + explicit choice at onboarding; existing users keep their saved choice; blocked people never see a profile | unit (`ready()` gate), onboarding E2E |
| Device names | spoofed device name | carried only inside the authenticated link session, display only, never identity | code review |
| Push relay | content/identity leak | relay stores device key→token, sha256(cap)→device; payload = kind, id, expiry, capId, MAC | unit (payload has no text) |
| Push relay | forged registration / token hijack | Ed25519 signature by the device key, ±120 s timestamp, single-use nonce | unit (forged register → 403) |
| Push relay | spoofed calls / notifications | per-friend HMAC key never leaves the two phones; native code verifies before showing anything; iOS reports-then-ends unverifiable VoIP pushes | unit (wrong key fails), Android self-test |
| Push relay | abuse / DoS | per-capability 30/min, calls 6/min, per-IP 300/min, 500 caps/device, 8 KB bodies, expiry ≤ 24 h, call ≤ 60 s | unit (call rate limit) |
| Push revocation | blocked person keeps waking you | block / unfriend / relay change revoke at the relay and notify the friend | unit (after block → 404) |
| Relay URL from a friend | SSRF to LAN/loopback services | `RelayUrl`: https only, no private IP literals, no credentials (loopback http only in tests) | unit |
| Auto-download | malware delivered silently | off by default; friends only; size cap; extension **and** MIME must match a media/document class; executables/scripts/html always ask; never auto-opened; SHA-256 verified | unit |
| Gallery/Photos/Files export | path traversal, wrong file, partial writes | sources restricted to CLAN private dirs (canonical path check); SHA-256 before export; Android writes are verified and removed on failure; MediaStore `IS_PENDING`; no overwrite | code review; emulator check in verification doc |
| Clipboard | — | user-initiated only, 8000-char cap | — |
| Notifications | content on lock screen | sender name only when “notification previews” is on; push notifications never contain text | code review |

## Inherited findings re-assessed

`pnpm audit` (15 Oct 2026): **2 high, 2 moderate**, all in build tooling, none in shipped runtime bundles:

| Package | Path | Shipped? | Status |
|---|---|---|---|
| node-forge ≤1.4.0 (high) | expo › @expo/cli › code-signing-certificates | no (CLI only) | **Unresolved** – advisory lists 1.4.1, which is not published on npm |
| braces ≤3.0.3 (high, ReDoS) | expo › @expo/cli › metro › micromatch | no (bundler) | **Unresolved** – 3.0.4 not published |
| uuid <11.1.1 (moderate) | @expo/config-plugins › xcode | no (prebuild) | **Unresolved** – 11.1.1 not published |
| sprintf-js ≤1.1.3 (moderate) | electron-builder › @electron/get › global-agent | no (packager) | **Unresolved** – 1.1.4 not published |

An override to the advisory “patched” versions was attempted and failed because those versions do not exist on the
registry; it was reverted (no lockfile change). Risk is limited to developer/CI machines processing untrusted input.

Desktop data at rest: unchanged from BTC-2R — the database key is wrapped by Electron `safeStorage` (Keychain/DPAPI);
attachments in the resource store are plain files in the user profile. Phone database is SQLCipher with a
Keystore/Keychain-held key. Documented limitation, not fixed in this phase.

## Secrets

No Firebase service accounts, `google-services.json`, APNs keys, certificates or provisioning files are in Git
(checked with `git ls-files` for `*.p8 *.p12 *.mobileprovision *.jks *.keystore google-services*.json`). Build
switches read them from paths outside the repository.

## Not changed (verified unchanged by the regression suites)

OPAQUE pairing and pinned TLS, CLAN hosting authority/hand-over, meeting access, screen sharing, remote-control
consent and emergency stop, timetable/Diary isolation, personal sync.

## Unresolved

- Build-tool advisories above (no patched releases).
- Desktop attachments at rest are not separately encrypted.
- Push infrastructure is designed and tested locally only; its production threat model (operator, logging, TLS
  termination, retention) must be reviewed by whoever deploys it.
- An encrypted store-and-forward mailbox does not exist (see communication architecture).

# Android push activation (FCM)

Status: **Gate C BLOCKED** — no Firebase project, credentials or deployed relay exist. Local implementation and
security checks pass. Real push delivery has **not** been tested and is not claimed.

## Audit result (existing implementation kept, not rewritten)

| Item | Result |
|---|---|
| FCM HTTP v1 endpoint, OAuth2 JWT grant (RS256, `firebase.messaging` scope) | Correct; contract test against a fake Google endpoint verifies the signed JWT and body |
| Message shape | Data-only (`data.clan` = JSON string), `android.priority=high`, `ttl` from expiry, `collapse_key` per friend for messages only (calls never collapse) — the app verifies every wake-up before showing anything |
| Dead tokens | `UNREGISTERED` and (new) `SENDER_ID_MISMATCH` delete the registration; other errors are transient |
| Device registration | Ed25519-signed by the device key, ±120 s, single-use nonce |
| Capabilities / revocation | Per-friend capability (relay stores only its hash); revoked on block, unfriend, relay change |
| Forgery | Per-friend HMAC verified natively before any notification; expiry and duplicate checks (emulator self-test PASS) |
| Rate limits | Per capability, per call, per client IP — now **proxy-aware** (`CLAN_RELAY_TRUST_PROXY=1` behind a loopback reverse proxy); previously all clients behind a proxy would have shared one limit |
| Stale data | Registrations not refreshed for 60 days are purged with their capabilities (new) |
| Health | `GET /healthz` (new) |
| Token rotation on the phone | Token re-read on every push tick (new), not only at start |
| Secrets in Git | None; `.gitignore` now blocks `google-services*.json`, service-account JSON, `relay.env`, `*.p8` |
| LAN independence | Local messaging never calls the relay; relay URL empty = LAN only |
| Store-and-forward | **Not built.** A wake-up only announces; content still needs both devices reachable |

Tests: `packages/server/test/push-relay.test.ts` (4), `packages/clan/test/people-final.test.ts` (relay end-to-end),
Android on-device self-test (genuine shown / forged rejected / repeat deduplicated; call ring expires).

## QA package identifier
`app.classroomlan.student.finalqa` (debug-signed QA build). Register **this exact package name** in Firebase; register
`app.classroomlan.student` too if you later want push in the production app.

## Owner steps (exact)

1. **Create the Firebase project**: console.firebase.google.com → Add project (e.g. “CLAN”) → Analytics optional.
2. **Add the Android app**: Project settings → Your apps → Android → package `app.classroomlan.student.finalqa` →
   Register → **Download `google-services.json`**. Store it outside the repository, e.g.
   `~/clan-secrets/google-services.json` (`chmod 600`). Do not email it or commit it.
3. **Enable the API**: Google Cloud console for the same project → APIs & Services → enable
   **Firebase Cloud Messaging API** (HTTP v1). The legacy API is not used.
4. **Service account for the relay**: IAM & Admin → Service accounts → Create (e.g. `clan-relay`) → role
   **Firebase Cloud Messaging API Admin** → Keys → Add key → JSON. Store as `~/clan-secrets/firebase-sa.json`
   (`chmod 400`). This key can send pushes to your users: treat it like a password.
5. **Build the push-enabled APK**:
   `CLAN_GOOGLE_SERVICES=~/clan-secrets/google-services.json sh apps/mobile/scripts/android-final.sh`
   The resulting APK is the **push-enabled** one; installers without this variable are **LAN-only** (the app shows
   “Push is not configured in this build”).
6. **Run a relay** (needs your authorization to expose a service on the internet):
   - On a server with a DNS name: copy `deploy/push-relay/` → install Node 24, the repository at `/opt/clan`,
     `relay.env` from `relay.env.example`, the service account at `/etc/clan-relay/firebase-sa.json`,
     `clan-push-relay.service` (systemd) and `Caddyfile` (HTTPS with automatic certificates).
   - Check `https://<your relay>/healthz` → `{"ok":true,"fcm":true,…}`.
7. **On each phone**: People › Internet-assisted notifications → relay `https://<your relay>` → Save relay. Friends
   receive their wake-up capability the next time both are connected on the LAN.
8. **Live test** (tell me when steps 1–7 exist, or run yourself):
   phone A friends with computer B; on A choose People › Nearby › While using CLAN, background CLAN and lock the
   screen; leave A’s Wi‑Fi (mobile data on) or simply wait for A to be suspended; send a message from B → expected:
   a “New message” notification on A within seconds; tapping it opens CLAN, which fetches the message when A and B
   are on the same LAN again. Then a call from B → full-screen ringing on A for ≤45 s, Answer connects only when both
   are on the LAN. Report Doze (`adb shell dumpsys deviceidle force-idle`) and force-stop results separately.

## What I need from you to finish Gate C
Either (a) the two secret files placed on this Mac (paths above) **and** authorization plus access to run the relay
on an internet-reachable HTTPS host, or (b) run steps 6–8 yourself and send the exported diagnostics/notification
observations. Without these, Gate C stays BLOCKED.

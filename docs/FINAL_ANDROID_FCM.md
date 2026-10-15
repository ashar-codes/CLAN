# Android: Firebase Cloud Messaging wake-ups

Status: **client, native handling, relay and contract implemented and unit-tested; real FCM delivery BLOCKED** —
this repository has no Firebase project, `google-services.json` or service account, and none was created
(creating external accounts/services needs the owner's authorization). See FINAL_RELEASE_BLOCKERS.md.

## What is implemented

- `modules/clan-push/android` (Expo module, compiled into every build; inert without Firebase config):
  - `ClanMessagingService` (priority 1, ahead of expo-notifications' service) receives **data-only** FCM messages
    even when the app process was not running, and runs `ClanWake.handle` **without JavaScript**.
  - `ClanWake`: parse → look up the per-friend key by `capId` → HMAC-SHA256 check (constant time) → expiry check
    (≤24 h, calls ≤60 s) → dedupe (`kind:id`, last 200) → notification.
  - Channels: `clan-messages` (high), `clan-calls-v1` (ringtone, public on lock screen), `clan-missed`.
  - Calls: `NotificationCompat.CallStyle.forIncomingCall` with Answer/Decline, full-screen intent, `setTimeoutAfter`
    = remaining ring time (no stale ringing). `call.cancel`/`missed` cancel the ringer and post a missed call.
  - Taps/answers/declines are queued for JS (`takeEvents`); Answer pre-accepts only the **signed** `call.invite`
    with that call id when it arrives over the LAN — a push alone never starts media.
  - `USE_FULL_SCREEN_INTENT` declared; notification permission respected (`notifications-off`/`denied` → nothing).
- `src/people/push.ts`: token from FCM (`ClanPush.token()`), key sync to native, tap handling, self-test.
- Relay sender (`fcmSender`): FCM HTTP v1 with a service-account JWT (RS256), `priority: high` (each wake-up becomes a
  user-visible notification), `ttl` = remaining validity, `collapse_key` per friend for messages, `UNREGISTERED`/404
  removes the token.
- No polling, no high-priority non-visible traffic, no wake locks added. Token refresh: `onNewToken` stores it; the
  agent re-registers whenever the token differs from what the relay confirmed.

## Enabling it (operator steps)

1. Firebase console → project → Android app `app.classroomlan.student.finalqa` (and/or the production id) →
   download `google-services.json` to a path **outside the repository**.
2. Service account with the *Firebase Cloud Messaging API Admin* role → JSON key, outside the repository.
3. Run the relay behind HTTPS:
   `CLAN_FCM_SERVICE_ACCOUNT=/secure/sa.json CLAN_RELAY_DB=/var/lib/clan-relay.db node packages/server/src/push-relay-cli.ts`
4. Build: `CLAN_GOOGLE_SERVICES=/secure/google-services.json sh apps/mobile/scripts/android-final.sh`.
5. On each phone: People › Internet-assisted notifications → relay URL → Save. Friends receive capabilities the next
   time they are connected on the LAN.

## Limits (honest)

- High-priority FCM can be deferred or dropped by the OS/OEM (battery saver, app standby buckets, force-stop).
  **After force-stop Android delivers nothing** until the user opens CLAN again.
- The notification says a friend messaged/called; the content is fetched over the LAN only when both devices are
  reachable (see the table in FINAL_COMMUNICATION_ARCHITECTURE.md).
- Manufacturer guidance (Samsung "Never sleeping apps", Xiaomi "Autostart" + "No restrictions", Pixel "Unrestricted"
  battery) is shown in Nearby › Connectivity diagnostics; no OEM-specific code paths.

## Verification

| Check | Result |
|---|---|
| Relay + agent + MAC + revoke + rate limit (`packages/clan/test/people-final.test.ts`) | PASS |
| Native verify/dedupe/notification path on emulator via in-app self-test | see FINAL_CROSS_PLATFORM_VERIFICATION.md |
| Real FCM delivery (foreground/background/locked/Doze/killed) | **BLOCKED** (no Firebase project) |
| Real incoming audio/video call via push on hardware | **BLOCKED** (same) |

# CLAN communication architecture (final phase)

CLAN has two independent modes. Mode 2 is optional and never required for Mode 1.

## Mode 1 — local network (no internet)

- Identity = each device's Ed25519 key. Every envelope is signed end to end; transports are TLS 1.3 pinned to the
  identity (computers) or `clan-link/1` (phones, LAN/hotspot/Wi-Fi Direct/Aware/Apple P2P).
- Messages, edits, deletions, reactions, file offers and missed-call records go through a durable outbox and are
  delivered when an authenticated session to that person exists. Delivered = the recipient's authenticated reply.
- Calls: live signaling only (offer/answer/ICE, ≤60 s old), WebRTC media with no STUN/TURN.
- Background: desktop keeps running in the tray. Android keeps listening only in **Keep CLAN Available** (visible
  foreground service; Doze, OEM battery managers and force-stop can still stop it). iOS suspends sockets shortly
  after CLAN leaves the foreground — **no LAN listener survives suspension on iOS**.

## Mode 2 — internet-assisted wake-ups (optional)

```
Bilal's phone ──register(token), grant(capHash) ──▶  relay  ──FCM/APNs──▶  Bilal's phone (native code)
      │  push.cap {relay, capId, cap, mac}  (signed CLAN envelope, LAN)                │ verify HMAC(mac), dedupe,
      ▼                                                                                 │ notify / CallKit / full-screen
Aisha's device ── notify {cap, event{k,id,exp,capId,m}} ──▶ relay                     ▼
                                                                    tap → CLAN opens → connects to Aisha over the LAN
                                                                    → the real signed message/call arrives
```

- **What the relay knows**: device key → push token, sha256(cap) → device. No names, no friend keys, no content.
- **Authorisation**: `cap` (32 random bytes, per friend) authorises a wake-up; registration/grant/revoke are signed by
  the device key with timestamp + nonce (replay-safe).
- **Forgery resistance**: each event carries `m = HMAC(mac, k|id|exp|capId)`. `mac` never leaves the two phones, so
  neither the relay nor Google/Apple can make CLAN ring or notify. Unknown/revoked capId, bad MAC, expired → dropped.
- **Payload**: kind (`msg`, `file`, `call`, `call.cancel`, `missed`, `meeting`), message/call id, expiry. Nothing else.
- **When a wake-up is sent**: an envelope of a user-visible kind still undelivered after 5 s (LAN delivery wins and
  cancels it); a call that cannot reach the callee directly rings immediately (`call`, ≤60 s), and the caller keeps
  re-inviting over the LAN for the 45 s ring window; unanswered → `call.cancel` + durable missed-call record.
- **Revocation**: block / unfriend / relay change revoke the capability at the relay and tell the friend (`push.cap` null).
- **Rate limits** at the relay: 30 events/min per capability, 6 calls/min, 300 requests/min per IP, 500 caps/device.
- **Dedupe**: native code records `kind:id`; LAN alerts check the same key (`PeopleAlert.ref`), so a message is
  announced once whichever path arrives first.

## Notification vs content vs call

| | Needs | Works when sender has left the network? |
|---|---|---|
| Notification of a message | relay + internet on both sides | Yes (the notification) |
| Downloading the message | an authenticated CLAN session between the two devices | **No** — content stays on the sender until both are reachable |
| Establishing a call | both devices reachable on a local network; callee answers | No |

A push token does not store messages. Durable delivery after the sender leaves requires an **encrypted
store-and-forward mailbox** (always-on, holds ciphertext only, per-recipient quotas, expiry). It is **not built or
deployed**: it is a new internet service that needs explicit authorization, operator, retention policy and threat
model. The outbox/tombstone design is compatible with adding it later (envelopes are already signed and idempotent).

## Components

| Piece | Location |
|---|---|
| Wire contracts | `packages/protocol/src/push.ts`, `people.ts` (`push.cap`) |
| Capability store, wake queue | `packages/clan/src/modules/people/index.ts` |
| Client agent (register/grant/revoke/notify) | `packages/clan/src/modules/people/push.ts` |
| Relay (FCM HTTP v1, APNs HTTP/2) | `packages/server/src/push-relay.ts`, CLI `push-relay-cli.ts` |
| Android native (FCM service, channels, CallStyle) | `apps/mobile/modules/clan-push/android` |
| iOS native (PushKit + CallKit) | `apps/mobile/modules/clan-push/ios` |
| Phone glue / self-test | `apps/mobile/src/people/push.ts` |
| Call ringing via wake-up | `packages/client/src/call-engine.ts` (`wake` dependency) |

## Deployment (not performed)

Nothing is deployed by CLAN. To enable Mode 2 an operator must: create a Firebase project and/or Apple push key,
run `node packages/server/src/push-relay-cli.ts` behind HTTPS with those secrets outside Git, build the apps with
`CLAN_GOOGLE_SERVICES=…` (Android) / `CLAN_APNS=1` + a paid Apple team (iOS), and enter the relay URL in
People › Internet-assisted notifications. See FINAL_ANDROID_FCM.md and FINAL_IOS_PUSH_CALLKIT.md.

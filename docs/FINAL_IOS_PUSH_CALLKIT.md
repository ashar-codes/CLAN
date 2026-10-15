# iOS: APNs, PushKit and CallKit

Status: **code and relay contract implemented; real suspended-iPhone notification/call delivery BLOCKED.**
This Mac has only a free *Personal Team* (3VX95D7C3C). Personal teams cannot use the Push Notifications capability
(`aps-environment`), so neither APNs alerts nor PushKit VoIP pushes can be provisioned, and there is no APNs auth key
or relay deployment. Nothing was invented or uploaded.

## Critical limitation

A suspended or terminated iPhone app does **not** keep a LAN listener. Without a provisioned APNs path, CLAN on iOS
receives messages and calls only while it is in the foreground (plus a short grace period, and during an active call).
On resume it reconnects and the senders' outboxes deliver everything that was queued.

## Implemented

- `modules/clan-push/ios/ClanPushModule.swift`
  - Active only when Info.plist `CLANVoIPPush` is true (set by `CLAN_APNS=1`, which also adds `aps-environment` and
    the `voip` + `remote-notification` background modes). Otherwise the module reports "not configured".
  - `PKPushRegistry` (VoIP) → token for the relay (`apns-voip`); APNs alert token via expo-notifications (`apns`).
  - Every VoIP push is reported to CallKit, as iOS requires. A push that fails the per-friend HMAC/expiry check, or a
    `call.cancel`, is reported and **ended immediately** (`.failed` / `.remoteEnded`) — no fake caller can ring.
  - Genuine calls show the friend's locally stored name (or "A friend" with previews off); an unanswered call ends at
    its expiry (`.unanswered`) and is recorded as missed. Answer/Decline are queued for JS; media starts only when the
    signed `call.invite` arrives over the LAN and is accepted.
  - PushKit is used only for calls; messages use ordinary APNs alerts with generic text ("New message") — the relay
    never has names. (A Notification Service Extension could localise names later; not built.)
- Relay `apnsSender`: token-based (.p8, ES256 JWT), HTTP/2, `apns-push-type` alert/voip, priority 10, expiration from
  the event, collapse id per friend for messages, 410 → token removed.
- Files: verified **Save to Photos** (`PHPhotoLibrary` add-only) and **Save to Files** through the system share sheet.

## Enabling it (operator steps)

1. Paid Apple Developer team; App ID with Push Notifications; APNs auth key (.p8) stored outside the repository.
2. Relay: `CLAN_APNS_KEY=/secure/AuthKey.p8 CLAN_APNS_KEY_ID=… CLAN_APNS_TEAM_ID=… CLAN_APNS_TOPICS=<bundle id> node packages/server/src/push-relay-cli.ts`.
3. Build: `CLAN_APNS=1 CLAN_APNS_ENV=production` with the team's provisioning (TestFlight/ad hoc).

## Verification

| Check | Result |
|---|---|
| Swift module compiles in the device build | see FINAL_CROSS_PLATFORM_VERIFICATION.md |
| Foreground/resume messaging on iPhone | NOT TESTED by me on hardware (see verification doc) |
| APNs alert while suspended | **BLOCKED** (no Push capability / key / relay) |
| PushKit + CallKit incoming call while locked | **BLOCKED** (same) |

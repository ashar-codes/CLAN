# Final release blockers

This build is a **TEST/QA** build. It is not a release, and WhatsApp-like background reliability is **not**
complete: the internet-assisted path is implemented and tested locally but not deployed or delivered for real.

| # | Blocker | Who can unblock | Effect today |
|---|---|---|---|
| 1 | No Firebase project / `google-services.json` / FCM service account | Owner creates Firebase project (FINAL_ANDROID_FCM.md) | Android wakes only while CLAN runs (Keep CLAN Available); no push when killed/dozing |
| 2 | No paid Apple Developer team with Push Notifications; no APNs key | Owner enrolls, enables Push + PushKit | iPhone receives messages/calls only in foreground; no CallKit ringing |
| 3 | No deployed notification relay (HTTPS, operator, logging/retention policy) | Owner/school deploys `push-relay-cli.ts` | Mode 2 inactive; relay field in app stays empty |
| 4 | No encrypted store-and-forward mailbox | Product + security decision; new service | If the sender leaves the network, the recipient can be notified (once 1–3 exist) but cannot download the message until both are reachable |
| 5 | Signed iPhone IPA (out of scope in the discovery phase) | Connect the iPhone by cable (or same Wi‑Fi), unlock it, keep Developer Mode on, then run `CLAN_APPLE_TEAM=3VX95D7C3C CLAN_HERMES_TARBALL=~/Library/Caches/clan-hermes/hermes-ios-250829098.0.17-release.tar.gz sh apps/mobile/scripts/ios-final.sh` | No IPA delivered; device compile verified. Free-team profiles expire after 7 days |
| 6 | Physical network matrix (different routers, bridged APs, VLANs, client isolation) | User testing | NOT TESTED |
| 7 | Physical phones (Android hardware, iPhone) and Windows hardware against each other | User testing | NOT TESTED |
| 8 | Build-tool dependency advisories (node-forge, braces, uuid, sprintf-js) | Upstream releases | Unresolved; not in shipped runtime bundles |
| 9 | Desktop attachments not separately encrypted at rest | Future work | Documented limitation |
| 10 | macOS/Windows packages are not notarized/code-signed with a distribution identity | Owner signing identities | Gatekeeper/SmartScreen warnings on install |
| 11 | Mixed versions: devices on older CLAN refuse edits/deletions/replies/reactions | Update both devices | Sender sees “could not apply this change”; plain messages unaffected |

## Update — discovery & Android push phase (`fix/discovery-and-android-push`)

| # | Item | Status |
|---|---|---|
| D1 | Automatic People/CLAN discovery on real phones and Windows PCs on the user's own Wi‑Fi | Root causes fixed (DISCOVERY_ROOT_CAUSE.md); same-host real-network matrix PASS; **physical cross-device NOT TESTED** — run DISCOVERY_QA_INSTALLATION.md and send exported diagnostics |
| D2 | Different routers / bridged APs / VLANs / client isolation | NOT TESTED; mDNS does not cross routers — use the internal directory or QR |
| D3 | Android FCM real delivery (Gate C) | **BLOCKED**: needs Firebase project, `google-services.json`, service account and an authorized HTTPS relay (ANDROID_PUSH_ACTIVATION.md) |
| D4 | Android background under Doze / OEM battery managers / force-stop | Keep mode works in background and screen-off and recovers after Doze; Doze pauses it (OS policy); force-stop stops it |
| D5 | Packaged macOS smoke: 1 of 5 first-launch runs failed without a captured error right after signing | Open; 4/5 PASS |
| D6 | Personal sync still uses a separate NSD client on Android | Tolerated by the new resolve deadlines/retries; consolidate later |

# BTC-2R root-cause record

Baseline `7db61c7c9b8fe8e9bdff215c44c412dd380cc2e5`; branch `btc-2r-always-reachable`.

## Build identity first

Protected Desktop installer manifest records application `e73cd174f70716c8e914c8e8452030b7550f7f37` (BTC-1), version 0.1.0. BTC-2A–E deliberately did not replace these packages. Installed Mac `CFBundleShortVersionString` and ASAR package both report 0.1.0, internal QA; no embedded Git revision exists. Installed main bundle SHA-256: `41c654735f1b53df4bc4709657913fe7b22d2d2ed6da7961e7a0d8d71f6c0ae2`. Delivery records associate it with BTC-1; version metadata alone cannot independently attest that exact application revision. Physical Windows/Android installed revisions are unavailable locally. Only emulator-5580 was connected at audit.

## Proven current-source defects repaired

- ConnectionManager retries only pending outbox/download recipients. An idle friend's authenticated link could disappear and stay disconnected until interaction/discovery. Availability-enabled runtimes now maintain known friends with stored authenticated routes, bounded to 100 candidates and four concurrent dials, queued work first, existing backoff/coalescing/key checks/blocking. Automatic idle redial is disabled under Invisible or disabled availability. No address scanning.
- Android network events woke delivery but did not restart NSD, clear discovery throttles/old hints or republish the listener. Native default-network callbacks now detect changed link addresses/routes as well as availability/loss. Existing native service pulses refresh discovery/advertisements, directory and transport, without requiring UI focus. Old NSD generations are discarded and resolve queue is bounded.
- People Bonjour browser ignored SRV/TXT updates and expiration. Refresh events and expiration now reach subscribers; new endpoint hints do not share an old endpoint's throttle. Desktop interface-change handling rebuilds browse sockets, clears hints and republishes; OS resume also wakes networking.

These are verified defects, not proven explanations of the user's Windows↔Mac or home-network Android observations. Those reports involve older installed packages and unobserved firewall/OEM conditions. No physical causal claim is made. Historical second-member approval intermittency remains separately tracked; do not increase its test timeout.

## Remaining hypotheses

Windows multicast interface/VPN choice, local-network permission, actual client isolation/firewall, old peer identity binding, stale older-package endpoints and Xiaomi battery termination require physical diagnostics. Windows installer permits program-scoped local-subnet inbound traffic; routed peers need explicitly approved scoped rules, not global firewall disable. No automatic firewall modification was added.

Follow-up source audit: concurrent mobile listener starts were not coalesced, and late listener completion could resurrect discovery after Stop. Startup is now coalesced and generation-fenced; two deterministic native-adapter lifecycle unit tests PASS. Stop clears the displayed listener port. Manual profile-code entry disables capitalization/autocorrection; the native driver now shell-quotes codes containing `&` rather than losing QR parameters. These follow-ups do not establish the original physical failure's cause.

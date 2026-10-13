# BTC-2R network matrix and hardware handoff

Recorded outcomes belong in BTC_2R_VERIFICATION.md; existing BTC-2A real-socket fixtures are simulated topologies, not physical routers.

| Topology | Available verification / limitation |
| --- | --- |
| A/B Mac↔Windows same/bridged LAN | Final 3eab423 Windows and Mac full Electron each 45 PASS/2 existing PERF skips; Windows native recovery passes early and within full suite; historical failures retained; simultaneous physical pair NOT TESTED |
| C/D/E Mac↔Android active/background/locked | Disposable emulator with actual native encrypted authenticated TCP and Mac Node peer; two complete emulator runs PASS; physical Xiaomi pairing/delivery/media NOT TESTED |
| F Windows↔Android | Physical NOT TESTED |
| G roaming/IP change | Real-socket address replacement/queue tests and emulator network interruption; physical roaming NOT TESTED |
| H no public internet | Protocol fixtures use only local endpoints; physical disconnected-internet router NOT TESTED |
| I blocked/isolated | BTC-2A pinned directory/isolation/identity fixtures; no firewall bypass |
| J/K desktop close/quit | Electron opt-in hidden window and real listener/explicit quit fixture |
| L Android restriction/restart | Native build and emulator force-stop unavailable PASS; autonomous process recreation absent; physical OEM kill/reboot NOT TESTED |
| M/N late advertisement/multiple peers | Existing bounded OPAQUE/TLS join and simultaneous-dial arbitration regressions |
| O mixed-version | Source schema/keys preserved; actual old/new native pair NOT TESTED |

## User-run acceptance

Use disposable contacts; note build/source, OS/network profile, Keep mode/service indicator, permission state and measured seconds. Never share passwords, private keys, database files or QR invite secrets in diagnostics.

- [ ] Windows↔Mac same LAN: authenticated pairing/friend acceptance, texts both ways, file SHA, audio/video with actual changing frames. Expected: recipient receipt, verified identity and real media, not merely discovery/ping.
- [ ] Close both windows with Keep enabled; repeat message/call. Quit one explicitly; expected: unavailable, queued message/bounded attempt, no false Delivered.
- [ ] Android open once, allow notifications/Nearby, select separate Keep button, confirm persistent indicator. Home then lock: send text/call from Mac without reopening. Measure receipt and ringing; camera/mic stay off until accepting.
- [ ] Disable/re-enable Wi-Fi or move to an authorized network; leave Android UI closed. Expected: authenticated reconnect and exactly one copy of queued text/voice/file offer. Acceptance remains required for files.
- [ ] Force-stop Android: expected unavailable, no self-restart promise. Reopen: queues recover, data/identity intact.
- [ ] Routed Windows↔Mac: approved internal routing and QR/manual/directory. Administrator may add an executable-scoped inbound rule for ONLY the approved peer IP/CIDR and appropriate network profile/ports; preserve existing local rules. Never disable Defender Firewall globally or add public allow-all rules. LiveKit's configured UDP port also needs approved reachability; successful chat does not prove media reachability.
- [ ] iPhone foreground/resume text/calls; suspended availability limitation displayed. No APNs/PushKit or physical signing success is inferred.

For Windows failure inspect the actual EXE path, Private/Public profile, enabled program-scoped rules, active VPN/adapters, trusted QR/manual endpoint and app error. For Mac inspect Local Network permission and firewall application allowance. Capture sanitized status/elapsed times; discovery, TCP reachability and authenticated sessions are separate gates.

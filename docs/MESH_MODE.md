# Mesh mode — research notes (NOT implemented)

Milestone 2.75 deliberately stops at an **application-level overlay on a normal LAN**. True routerless, multi-hop mesh is
future research. Nothing below exists in code.

| Technology | Platforms | Why not now |
|---|---|---|
| Wi-Fi Direct groups | Windows, Android | one group owner per group; multi-group bridging needs routing we'd have to build; Windows Direct Mode (M3) covers the single-hop case |
| Wi-Fi Aware (NAN) | Android 8+, iOS 26+ (limited), not macOS/Windows | no common denominator across our four platforms |
| Apple Multipeer Connectivity | Apple only | excludes Windows/Android |
| Bluetooth mesh / BLE | all, low bandwidth | far too slow for files or media; maybe for presence signalling |
| Multi-hop IP routing (BATMAN, OLSR) | needs root/kernel modules | not available to normal apps on any of our platforms |

If pursued, the existing design carries over unchanged: teacher-signed manifests/endorsements/capabilities make bytes safe to
relay through any number of untrusted hops, and the control plane would still require teacher signatures — relays never gain
authority. What would be new is connectivity (discovery + forwarding), which `ClassroomNetworkMode.connectivity =
'mesh_experimental'` is reserved for.

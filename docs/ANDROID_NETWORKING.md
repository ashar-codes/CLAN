# Android networking

**Status: cannot join in this build** (same OPAQUE + pinned-transport blockers as iOS); not device-tested (no Android SDK here).

Pinned transport plan: OkHttp with a custom `X509TrustManager` whose only trust anchor is the session CA from the binding
(validate the chain with a `TrustManagerFactory` initialised from a KeyStore containing just that CA), followed by a leaf SPKI
SHA-256 comparison; used for requests, ranged downloads to file, offset uploads from file and WebSockets. Never a trust-all manager.
Device Ed25519 seed in `expo-secure-store` (Android Keystore-backed).

* Discovery: `react-native-zeroconf` → `NsdManager`, service `_classroomlan._tcp`.
* Permissions (app.json): `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`.
* Cleartext HTTP is still enabled (`usesCleartextTraffic`) but only the OPAQUE bootstrap uses it; classroom traffic is TLS.
  Narrow it to a network-security-config later if desired (the bootstrap is on dynamic LAN IPs).
* Direct Mode join (M3) will use `WifiNetworkSpecifier` + `ConnectivityManager.requestNetwork` and
  `bindProcessToNetwork` so traffic goes to the classroom AP even though it has no internet.

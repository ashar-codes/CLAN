# Android networking

**Status: implemented in 2.6; NOT compiled or device-tested** (no Android SDK or JDK on the development machine).

* OPAQUE: official WASM in a hidden Android WebView (Chromium; the identical page was run in Electron's Chromium).
* Pinned transport: `modules/pinned-transport/android` — OkHttp with `PinnedTrustManager` (KeyStore containing only the
  class CA → chain validation → leaf SPKI SHA-256 == pin), TLS 1.3 `ConnectionSpec`, hostname verifier accepting any name for
  this client only (identity = CA + pin). Requests, ranged downloads to file, offset uploads from file, WebSockets.
Device Ed25519 seed in `expo-secure-store` (Android Keystore-backed).

* Discovery: `react-native-zeroconf` → `NsdManager`, service `_classroomlan._tcp`.
* Permissions (app.json): `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`.
* Cleartext HTTP is still enabled (`usesCleartextTraffic`) but only the OPAQUE bootstrap uses it; classroom traffic is TLS.
  Narrow it to a network-security-config later if desired (the bootstrap is on dynamic LAN IPs).
* Direct Mode join (M3) will use `WifiNetworkSpecifier` + `ConnectivityManager.requestNetwork` and
  `bindProcessToNetwork` so traffic goes to the classroom AP even though it has no internet.

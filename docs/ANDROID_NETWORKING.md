# Android networking

**Status: code complete for LAN Mode, not device-tested** (no Android SDK on the development machine).

* Discovery: `react-native-zeroconf` → `NsdManager`, service `_classroomlan._tcp`.
* Permissions (app.json): `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`.
* Cleartext HTTP to the teacher is enabled via `expo-build-properties` (`usesCleartextTraffic`) because the classroom
  server is plain HTTP on the LAN (see SECURITY.md known gaps).
* Direct Mode join (M3) will use `WifiNetworkSpecifier` + `ConnectivityManager.requestNetwork` and
  `bindProcessToNetwork` so traffic goes to the classroom AP even though it has no internet.

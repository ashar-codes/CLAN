# Windows Direct Mode

**Status: not implemented (Milestone 3).** The setup screen shows Direct Mode as unavailable with this explanation.

Planned approach (to be re-verified against current Microsoft docs and on real hardware before implementation):
* `Windows.Devices.WiFiDirect.WiFiDirectAdvertisementPublisher` with `LegacySettings` (IsEnabled, Ssid, Passphrase)
  creates a soft AP that ordinary Wi-Fi clients can join, without the Mobile Hotspot's internet-sharing requirement.
  Accessed from Electron through a small native helper (C#/C++ WinRT), not `netsh hostednetwork` (deprecated/removed
  on many drivers).
* SSID derived from the class (e.g. `CLASS-482915`), random WPA2 passphrase delivered to student apps, never typed.
* Capability probe at startup (adapter supports Wi-Fi Direct?) so the button is only enabled when it can work.
* Must be validated on real Windows hardware; cannot be built or tested on the current macOS dev machine.

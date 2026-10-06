# Apple platforms

## macOS teacher/student (implemented)
* LAN Mode only. macOS offers no supported public API for a third-party app to create a Wi-Fi access point
  (Internet Sharing is a user-controlled system feature), so Direct Mode is shown as unavailable with an explanation.
* `NSLocalNetworkUsageDescription` and `NSBonjourServices = [_classroomlan._tcp]` are set in the packaged app
  (`electron-builder.yml`). The first discovery/hosting may trigger the macOS local-network prompt and the firewall
  "accept incoming connections" prompt — both are expected and must be allowed.

## iOS student (code complete, not device-tested here)
* `app.json` sets `NSLocalNetworkUsageDescription`, `NSBonjourServices` and ATS `NSAllowsLocalNetworking`
  (verified in `expo prebuild` output).
* Profile + deviceId stored in Keychain via `expo-secure-store`.
* Joining a Windows Direct Mode network (M3) will use `NEHotspotConfiguration` (requires the Hotspot Configuration
  entitlement); the OS will ask the user to confirm.
* Screen broadcast (Milestone 4) will need a ReplayKit broadcast upload extension.

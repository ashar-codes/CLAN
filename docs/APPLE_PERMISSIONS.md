# Apple platforms

## macOS teacher/student (implemented)
* LAN Mode only. macOS offers no supported public API for a third-party app to create a Wi-Fi access point
  (Internet Sharing is a user-controlled system feature), so Direct Mode is shown as unavailable with an explanation.
* `NSLocalNetworkUsageDescription` and `NSBonjourServices = [_classroomlan._tcp]` are set in the packaged app
  (`electron-builder.yml`). The first discovery/hosting may trigger the macOS local-network prompt and the firewall
  "accept incoming connections" prompt — both are expected and must be allowed.

## macOS keychain and signing
Identity keys are encrypted with Electron `safeStorage`, which uses a Keychain item bound to the app's code signature.
Dev Electron, unsigned packaged and Developer-ID-signed builds are different signatures: macOS may prompt for access or the
key may become unreadable; the app then generates a new key and says so (re-approval needed). No prompt appeared in this
repository's dev or unsigned-packaged E2E runs. Sign and notarize release builds so the identity is stable across updates.

## iOS student (implemented in 2.6; NOT device-tested)
* OPAQUE: official WASM in a hidden WKWebView (see PAIRING_AND_TRUST.md › Mobile).
* Pinned transport: `modules/pinned-transport/ios` — `PinnedTrust.swift` (trust decision) + `PinnedTransportModule.swift`
  (Expo module: request, download, upload, WebSocket; ephemeral URLSession, TLS 1.3). `PinnedTrust.swift` is compiled for
  macOS and run against a real classroom server by `modules/pinned-transport/tests` (accepts the right CA+pin; rejects a wrong
  pin, another CA, both). The Expo module file itself has not been compiled (needs Xcode + Pods).
* Deployment target 15.1 (async URLSession APIs).
* Device Ed25519 seed in `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (not in backups / not migrated).
* `app.json` sets `NSLocalNetworkUsageDescription`, `NSBonjourServices` and ATS `NSAllowsLocalNetworking`
  (verified in `expo prebuild` output).
* Profile + deviceId stored in Keychain via `expo-secure-store`.
* Joining a Windows Direct Mode network (M3) will use `NEHotspotConfiguration` (requires the Hotspot Configuration
  entitlement); the OS will ask the user to confirm.
* Screen broadcast (Milestone 4) will need a ReplayKit broadcast upload extension.

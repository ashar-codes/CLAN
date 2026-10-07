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

## iOS student (cannot join in this build; not device-tested)
* Joining is blocked on (a) an OPAQUE binding compatible with `@serenity-kit/opaque` 1.x and (b) a pinned transport native
  module: URLSession delegate that evaluates the server trust with **only** the session CA from the binding as anchor
  (`SecTrustSetAnchorCertificates` + `SecTrustSetAnchorCertificatesOnly`) and then compares the leaf SPKI SHA-256 to the pin,
  for data tasks, download tasks (Range resume) and `URLSessionWebSocketTask`. Never accept arbitrary self-signed certs.
* Device Ed25519 seed in `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (not in backups / not migrated).
* `app.json` sets `NSLocalNetworkUsageDescription`, `NSBonjourServices` and ATS `NSAllowsLocalNetworking`
  (verified in `expo prebuild` output).
* Profile + deviceId stored in Keychain via `expo-secure-store`.
* Joining a Windows Direct Mode network (M3) will use `NEHotspotConfiguration` (requires the Hotspot Configuration
  entitlement); the OS will ask the user to confirm.
* Screen broadcast (Milestone 4) will need a ReplayKit broadcast upload extension.

# BTC-2R verification

Branch `btc-2r-always-reachable`, baseline `7db61c7`. Software/physical completion remains **BLOCKED** pending recorded final results and unavailable cross-device acceptance. No BTC-1 package, active installed app, user profile/key or draft PR replaced.

Initial focused real TCP idle-friend/privacy/blocking and Bonjour update regressions: **10 PASS**, repeated **10 PASS** (12.16 s). Initial four-project typecheck exposed missing diagnostic import; repaired, subsequent typechecks PASS. Initial full unit/integration **522 PASS**, 72 files (396.01 s); source changed during execution, so final frozen-source repetition is required.

Android native Gradle standalone QA builds PASS (49 s, 44 s). First new emulator background driver **FAIL** before pairing: emulator disappeared during UI navigation; no background success inferred. Disposable AVD restarted without wiping its data. Final source/native/background verification pending. Emulator reduced-motion setting is used for deterministic UI automation; hardware animations and OEM policies remain separately unverified.

Final native iOS cached simulator build-for-testing PASS; source was mirrored during the initial build after a relative-path invocation failed. A clean incremental build after mirror completion is required before final-source claims. No physical provisioning/IPA.

Inherited advisories: two high/two moderate, desktop data-at-rest encryption limitation. No new internet push/relay/TURN infrastructure. Real physical Windows↔Mac, Xiaomi background/locked calls, multi-router and Apple provisioning remain NOT TESTED. SFU media/remote consent regressions must pass; synthetic SDP invitation fixture tests notification/ringing only, never real audio/video media.

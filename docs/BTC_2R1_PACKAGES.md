# BTC-2R.1 isolated QA packaging

Baseline: BTC-2R 1152a28, application 3eab423. This phase produces TEST/UNVERIFIED packages for personal hardware validation, not BTC-2G or a public release.

Freeze one source commit after packaging configuration verification; inject it into desktop package metadata, Android clan-build.json, and generated iOS Info.plist. All platforms include the existing BTC-2 modules, subject to documented OS/hosting capabilities. No new feature expansion.

Desktop uses app.classroomlan.desktop.btc2r / CLAN BTC2R QA and separate default profile btc2r1-test; original production/TEST profiles and notifications remain unchanged. Android uses app.classroomlan.student.btc2r, versionCode 3 and the existing debug identity. iOS uses app.classroomlan.student.btc2r and an isolated share App Group; ordinary beta config remains unchanged. Fresh QA identities require new pairing/friendship consent. Do not copy private keys between profiles.

Windows builds on native Windows CI, checks bundled helpers, installs/starts/tests/uninstalls on a disposable runner, and preserves original firewall rules. Mac keeps Hardened Runtime and camera/audio entitlements, uses ad-hoc signing and a disposable installation smoke target. Android is standalone release-mode QA with bundled JS, native modules and debug signing. iOS ships an actual prepared Xcode workspace/source/dependencies, not an IPA; Apple Account/team provisioning and App Group/Hotspot capabilities remain required.

Delivery folder: ~/Desktop/CLAN BTC-2R - Updated Installers. Local BUILD-MANIFEST.md, SHA256SUMS.txt and TESTING-GUIDE.md record exact source, hashes, signing, test evidence and safe installation/upgrade instructions. Physical Windows↔Mac/Android and iPhone tests remain user-run. Inherited dependency advisories and desktop at-rest limitations remain unresolved. Original installers and installed apps are never replaced automatically.

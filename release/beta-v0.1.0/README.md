# CLAN v0.1.0 — closed beta release folder

Installers are git-ignored (they're attached to this folder locally); the text files here are committed.
Verify downloads with `shasum -a 256 -c SHA256SUMS`.

| File | Size (bytes) | SHA-256 | Status |
|---|---:|---|---|
| `CLAN-0.1.0-arm64.dmg` | 162,986,183 | `ce82897545e670a0e3ad6baa938462295ce7633bf37864432ec4f85c2ff3ee69` | BUILT · INSTALLED · TESTED on the build Mac (ad-hoc signed, not notarized) |
| `CLAN Setup 0.1.0.exe` | 166,022,872 | `b1da8cc751d5ef70ff6c083938ce63bb465a3c434e1b821f1a71c991480c3f45` | BUILT on macOS · **UNVERIFIED** (never run on Windows; unsigned) |
| `CLAN-0.1.0-android-arm64.apk` | 52,394,960 | `ef74df0f0520585ff620744615d13c984314c956af70759a02f797e8dbf3cbc9` | BUILT · INSTALLED · TESTED on the Android 16 emulator only (beta upload key) |
| iOS | — | — | NOT BUILT (no Xcode / Apple team) — see `docs/BETA_READINESS.md` › iOS handoff |

APK signing certificate SHA-256: `98:03:DC:D4:A4:6B:8F:23:76:8E:27:23:2F:47:CE:06:30:D2:0B:D0:94:72:13:1C:C1:79:60:6F:BF:C9:A6:0B`
(`CN=CLAN Beta Upload, O=CLAN`, APK Signature Scheme v2).

For testers: [SETUP.md](SETUP.md) · [RELEASE_NOTES.md](RELEASE_NOTES.md) · [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) ·
[STUDENT_CHECKLIST.md](STUDENT_CHECKLIST.md) · [TEACHER_CHECKLIST.md](TEACHER_CHECKLIST.md)

## How these were built (macOS arm64, from tag `clan-beta-v0.1.0`)
```sh
pnpm install --frozen-lockfile
cd apps/desktop && pnpm build
npx electron-builder --mac dmg --arm64 -c.mac.identity=-
npx electron-builder --win nsis --x64 -c.win.signAndEditExecutable=false
cd ../.. && NO_INSTALL=1 apps/mobile/scripts/android-dev.sh --prebuild --release
```
Native helpers and signing prerequisites: `docs/BUILDING.md` › Beta release builds. Each package passed
`apps/desktop/scripts/release-audit.sh` (no keys, env files, source maps, tests, dev URLs or foreign native binaries).
Nothing here contains credentials, signing keys or personal data.

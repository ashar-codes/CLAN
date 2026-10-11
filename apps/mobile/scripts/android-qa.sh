#!/bin/sh
# Internal standalone APK: release-mode dependencies, disposable debug signing, never the beta upload identity.
# Builds only; install on a disposable emulator explicitly. Does not read the login keychain or signing backup.
set -eu
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"
case "$SRC" in *' '*) echo 'Use an isolated space-free QA worktree.' >&2; exit 1;; esac
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
cd "$SRC/apps/mobile"
CLAN_INTERNAL_QA=1 CI=1 pnpm exec expo prebuild -p android --no-install
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
cd android
./gradlew :app:assembleQa -PreactNativeArchitectures="${ARCHS:-arm64-v8a}" --max-workers=2 --console=plain
printf 'TEST/UNVERIFIED debug-signed APK: %s\n' "$SRC/apps/mobile/android/app/build/outputs/apk/qa/app-qa.apk"

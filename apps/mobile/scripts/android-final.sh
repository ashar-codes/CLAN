#!/bin/sh
# Final TEST APK (app.classroomlan.student.finalqa / "CLAN QA"): release-mode bundled JS, debug-signed, installs beside
# existing CLAN apps. Optional FCM: CLAN_GOOGLE_SERVICES=/secure/google-services.json (never committed).
set -eu
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"
case "$SRC" in *' '*) echo 'Use an isolated space-free worktree.' >&2; exit 1;; esac
export CLAN_SOURCE_SHA="${CLAN_SOURCE_SHA:-$(git -C "$SRC" rev-parse HEAD)}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
cd "$SRC/apps/mobile"
CLAN_INTERNAL_QA=1 CLAN_FINAL_QA=1 CI=1 pnpm exec expo prebuild -p android --no-install
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
cd android
./gradlew --init-script ../scripts/final-qa.init.gradle :app:assembleQa -PreactNativeArchitectures="${ARCHS:-arm64-v8a}" --max-workers=3 --console=plain
printf 'TEST debug-signed APK (%s): %s\n' "$CLAN_SOURCE_SHA" "$SRC/apps/mobile/android/app/build/outputs/apk/qa/app-qa.apk"

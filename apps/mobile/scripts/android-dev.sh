#!/bin/sh
# Android dev build from a space-free APFS clone (ndk-build in react-native-zeroconf can't handle spaces in paths):
# mirrors sources to $CLAN_BUILD_DIR, builds the debug APK (arm64 by default) and installs it on the running emulator.
# Usage: apps/mobile/scripts/android-dev.sh [--prebuild] [--release]
set -e
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"; DST="${CLAN_BUILD_DIR:-$HOME/clan-build}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}" ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$DST" ] || cp -c -R "$SRC" "$DST"
rsync -a --delete --exclude node_modules --exclude .git --exclude apps/mobile/android --exclude apps/mobile/ios --exclude 'apps/desktop/dist' --exclude release "$SRC/" "$DST/"
rsync -a "$SRC/node_modules/" "$DST/node_modules/"
cd "$DST/apps/mobile"
case " $* " in *" --prebuild "*) CI=1 npx expo prebuild -p android --no-install >/dev/null; echo "sdk.dir=$ANDROID_HOME" > android/local.properties;; esac
cd android
case " $* " in *" --release "*) T=assembleRelease; APK=app/build/outputs/apk/release/app-release.apk;; *) T=assembleDebug; APK=app/build/outputs/apk/debug/app-debug.apk;; esac
./gradlew "$T" -PreactNativeArchitectures="${ARCHS:-arm64-v8a}" -q
"$ANDROID_HOME/platform-tools/adb" install -r "$APK"

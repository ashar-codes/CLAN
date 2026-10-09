#!/bin/sh
# Android dev build from a space-free APFS clone (ndk-build in react-native-zeroconf can't handle spaces in paths):
# mirrors sources to $CLAN_BUILD_DIR, builds the debug APK (arm64 by default) and installs it on the running emulator.
# Usage: apps/mobile/scripts/android-dev.sh [--prebuild] [--release]
set -e
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"; DST="${CLAN_BUILD_DIR:-$HOME/clan-build}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}" ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$DST" ] || cp -c -R "$SRC" "$DST"
rsync -a --delete --exclude node_modules --exclude 'apps/mobile/modules/*/android/build' --exclude .git --exclude apps/mobile/android --exclude apps/mobile/ios --exclude 'apps/desktop/dist' --exclude release "$SRC/" "$DST/"
rsync -a "$SRC/node_modules/" "$DST/node_modules/"
cd "$DST/apps/mobile"
# Upgrade tests only: CLAN_TEST_VERSION=0.1.1:2 builds that versionName/versionCode from the build copy (needs --prebuild).
[ -z "${CLAN_TEST_VERSION:-}" ] || node -e 'const f="app.json",c=JSON.parse(require("fs").readFileSync(f)),[v,n]=process.argv[1].split(":");c.expo.version=v;c.expo.android.versionCode=+n;require("fs").writeFileSync(f,JSON.stringify(c,null,2))' "$CLAN_TEST_VERSION"
case " $* " in *" --prebuild "*) CI=1 npx expo prebuild -p android --no-install >/dev/null; echo "sdk.dir=$ANDROID_HOME" > android/local.properties;; esac
cd android
# Release signing: the upload keystore stays outside the repo; its password comes from the login keychain (never a file).
case " $* " in *" --release "*)
  export ORG_GRADLE_PROJECT_CLAN_UPLOAD_STORE_FILE="${CLAN_UPLOAD_STORE_FILE:-$HOME/.clan-signing/clan-beta-upload.p12}" ORG_GRADLE_PROJECT_CLAN_UPLOAD_KEY_ALIAS="${CLAN_UPLOAD_KEY_ALIAS:-clan-beta}"
  [ -n "${ORG_GRADLE_PROJECT_CLAN_UPLOAD_STORE_PASSWORD:-}" ] || ORG_GRADLE_PROJECT_CLAN_UPLOAD_STORE_PASSWORD=$(security find-generic-password -s "CLAN Android upload key" -w)
  export ORG_GRADLE_PROJECT_CLAN_UPLOAD_STORE_PASSWORD ORG_GRADLE_PROJECT_CLAN_UPLOAD_KEY_PASSWORD="${ORG_GRADLE_PROJECT_CLAN_UPLOAD_KEY_PASSWORD:-$ORG_GRADLE_PROJECT_CLAN_UPLOAD_STORE_PASSWORD}";;
esac
case " $* " in *" --release "*) T=assembleRelease; APK=app/build/outputs/apk/release/app-release.apk;; *) T=assembleDebug; APK=app/build/outputs/apk/debug/app-debug.apk;; esac
./gradlew "$T" -PreactNativeArchitectures="${ARCHS:-arm64-v8a}" -q
[ -n "${NO_INSTALL:-}" ] || "$ANDROID_HOME/platform-tools/adb" install -r "$APK"

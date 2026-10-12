#!/bin/sh
# Isolated native compile. Simulator apps are ad-hoc signed for Keychain access; device checks remain unsigned.
# Xcode first launch/license + CocoaPods must already be ready. Existing profiles/signing settings are not changed.
set -eu
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"
DST="${CLAN_IOS_BUILD_DIR:-$HOME/clan-ios-build}"
case "$DST" in "$SRC"|"$SRC/"*|*' '*) echo 'Use a separate build directory without spaces.' >&2; exit 1;; esac
xcodebuild -version >/dev/null
command -v pod >/dev/null
mkdir -p "$DST"
rsync -a --delete --exclude .git --exclude node_modules --exclude apps/mobile/android --exclude apps/mobile/ios \
  --exclude '**/build' --exclude '**/.gradle' --exclude ios-derived --exclude apps/desktop/dist --exclude release \
  --exclude 'Installable Files' "$SRC/" "$DST/"
# APFS clone of the already installed dependencies: no duplicate downloads or package/version changes.
if [ ! -d "$DST/node_modules" ]; then cp -c -R "$SRC/node_modules" "$DST/node_modules"; fi
for deps in "$SRC"/apps/*/node_modules "$SRC"/packages/*/node_modules; do
  [ -d "$deps" ] || continue
  relative="${deps#"$SRC/"}"
  if [ ! -d "$DST/$relative" ]; then cp -c -R "$deps" "$DST/$relative"; fi
done
cd "$DST/apps/mobile"
CI=1 npx expo prebuild -p ios --no-install
pod install --project-directory=ios
SDK=iphonesimulator
DESTINATION='generic/platform=iOS Simulator'
SIGNING=YES
case "${1:-}" in --device-compile) SDK=iphoneos; DESTINATION='generic/platform=iOS'; SIGNING=NO;; '') ;; *) echo 'Usage: ios-build.sh [--device-compile]' >&2; exit 1;; esac
xcodebuild -workspace ios/CLAN.xcworkspace -scheme CLAN -configuration Release -sdk "$SDK" \
  -destination "$DESTINATION" -derivedDataPath "$DST/ios-derived" CODE_SIGNING_ALLOWED="$SIGNING" CODE_SIGN_IDENTITY=- build

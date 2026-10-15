#!/bin/sh
# Final TEST iPhone build: "CLAN QA" (app.classroomlan.student.finalqa), bundled JS (no Metro), signed for development
# with the Apple team in CLAN_APPLE_TEAM (a free Personal Team works: no Push, App Groups or Hotspot capabilities, and
# the profile expires after 7 days). Exports a real device .ipa. Never uploads anywhere.
set -eu
SRC="$(cd "$(dirname "$0")/../../.." && pwd)"
DST="${CLAN_IOS_BUILD_DIR:-$HOME/clan-ios-build}"
TEAM="${CLAN_APPLE_TEAM:?Set CLAN_APPLE_TEAM to your Apple team id}"
case "$DST" in "$SRC"|"$SRC/"*|*' '*) echo 'Use a separate build directory without spaces.' >&2; exit 1;; esac
export CLAN_SOURCE_SHA="${CLAN_SOURCE_SHA:-$(git -C "$SRC" rev-parse HEAD)}"
mkdir -p "$DST"
rsync -a --delete --exclude .git --exclude node_modules --exclude apps/mobile/android --exclude apps/mobile/ios \
  --exclude '**/build' --exclude '**/.gradle' --exclude ios-derived --exclude apps/desktop/dist --exclude 'apps/desktop/release*' \
  --exclude 'Installable Files' --exclude '*.xcarchive' --exclude ipa "$SRC/" "$DST/"
# always the current dependencies (APFS clone: no extra space); the build dir is disposable
rm -rf "$DST/node_modules"; cp -c -R "$SRC/node_modules" "$DST/node_modules"
cd "$DST/apps/mobile"
CLAN_FINAL_QA=1 CLAN_FREE_TEAM="${CLAN_FREE_TEAM:-1}" CI=1 npx expo prebuild -p ios --no-install --clean
# Pin the published Hermes prebuilt (checked against Maven's SHA-1) so a slow network cannot silently fall back to a
# from-source Hermes build. Set CLAN_HERMES_TARBALL to reuse a verified download.
if [ -n "${CLAN_HERMES_TARBALL:-}" ]; then export HERMES_ENGINE_TARBALL_PATH="$CLAN_HERMES_TARBALL"; fi
pod install --project-directory=ios
xcodebuild -workspace ios/CLANQA.xcworkspace -scheme CLANQA -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$DST/CLAN-QA.xcarchive" -derivedDataPath "$DST/ios-derived" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic archive
cat > "$DST/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>method</key><string>debugging</string><key>teamID</key><string>$TEAM</string>
<key>signingStyle</key><string>automatic</string><key>compileBitcode</key><false/></dict></plist>
PLIST
rm -rf "$DST/ipa"
xcodebuild -exportArchive -archivePath "$DST/CLAN-QA.xcarchive" -exportOptionsPlist "$DST/ExportOptions.plist" -exportPath "$DST/ipa" -allowProvisioningUpdates
ls -la "$DST/ipa"

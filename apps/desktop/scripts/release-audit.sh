#!/bin/sh
# Release audit of a packaged desktop app's resources dir (macOS: CLAN.app/Contents/Resources, Windows: win-unpacked/resources).
# Fails on: signing material, env files, source maps, test suites, other-platform native binaries, dev server URLs.
# Usage: sh apps/desktop/scripts/release-audit.sh <resources dir> <darwin|win32>
set -eu
R=$1; P=$2; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
npx --no-install asar extract "$R/app.asar" "$T/app"
cp -R "$R/app.asar.unpacked/." "$T/app/" 2>/dev/null || true
fail=0; bad() { echo "✗ $1"; fail=1; }
find "$T/app" -type f \( -name '*.p12' -o -name '*.jks' -o -name '*.keystore' -o -name '*.pem' -o -name '*.key' -o -name '.env*' \) | grep . && bad 'signing material / env files' || echo '✓ no keys, keystores or env files'
find "$T/app" -type f -name '*.map' | grep -q . && bad 'source maps shipped' || echo '✓ no source maps'
find "$T/app" -type d \( -name e2e -o -name __tests__ \) | grep . && bad 'test suites shipped' || echo '✓ no test suites'
grep -rIl -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$T/app" | grep . && bad 'private key in bundle' || echo '✓ no embedded private keys'
grep -rIlE 'sk-ant-[A-Za-z0-9]|sk-[A-Za-z0-9]{32,}' "$T/app" | grep . && bad 'API key pattern in bundle' || echo '✓ no API key patterns'
grep -rIl 'localhost:5173' "$T/app/dist" | grep . && bad 'dev server URL in bundle' || echo '✓ no dev server URL'
other=$([ "$P" = darwin ] && echo 'win32|linux' || echo 'darwin|linux|win32-arm64')
find "$T/app" -name '*.node' | grep -E "$other" && bad "other-platform native binaries for $P" || echo "✓ native binaries: $(find "$T/app" -name '*.node' -exec basename {} \; | tr '\n' ' ')"
exit $fail

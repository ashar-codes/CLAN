#!/bin/sh
# Bundled local SFU: LiveKit server v1.13.9 (Apache-2.0), placed in bin/<node platform>-<arch>/.
#   sh fetch.sh            # this machine's platform
#   sh fetch.sh win32-x64  # cross-fetch for packaging
# Windows/Linux use the official release archives, verified against pinned SHA-256s. LiveKit ships no macOS release
# binary, so macOS is built from the tagged source (needs Go ≥ 1.24; CGO is required for hwstats).
set -eu
V=1.13.9
cd "$(dirname "$0")"
T=${1:-$(node -p 'process.platform + "-" + process.arch')}
mkdir -p "bin/$T"
case "$T" in
  win32-x64)   A=livekit_${V}_windows_amd64.zip;   S=d5b5e44c197f613fdd6bdb2ae53e9d086d848156d43f614c688c6b595cd3f25e ;;
  linux-x64)   A=livekit_${V}_linux_amd64.tar.gz;  S=0b7fa208b662d09cfdeae8c06cf4c481aead0556086558b48250501e2e2d6e20 ;;
  linux-arm64) A=livekit_${V}_linux_arm64.tar.gz;  S=c5e4e5a6d6cf0a449651aa3178532ecc7a2bf2502538396ebe6e51ff13424056 ;;
  darwin-*)
    W=$(mktemp -d)
    git clone -q --depth 1 --branch "v$V" https://github.com/livekit/livekit "$W/src"
    (cd "$W/src" && CGO_ENABLED=1 go build -trimpath -ldflags "-s -w" -o "$OLDPWD/bin/$T/livekit-server" ./cmd/server)
    rm -rf "$W"; echo "built bin/$T/livekit-server"; exit 0 ;;
  *) echo "unsupported target $T" >&2; exit 1 ;;
esac
W=$(mktemp -d)
curl -fsSL -o "$W/$A" "https://github.com/livekit/livekit/releases/download/v$V/$A"
# Git Bash on Windows provides sha256sum rather than Perl's shasum.
if command -v sha256sum >/dev/null 2>&1; then
  echo "$S  $W/$A" | sha256sum -c -
else
  echo "$S  $W/$A" | shasum -a 256 -c -
fi
case "$A" in *.zip) unzip -q -o "$W/$A" livekit-server.exe -d "bin/$T" ;; *) tar -xzf "$W/$A" -C "bin/$T" livekit-server ;; esac
rm -rf "$W"; echo "fetched bin/$T"

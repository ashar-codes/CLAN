#!/bin/sh
set -eu
cd "$(dirname "$0")"
T=$(node -p 'process.platform+"-"+process.arch')
mkdir -p "bin/$T"
case "$T" in
 darwin-*) swiftc -O main.swift -o "bin/$T/clan-control"; codesign --force --sign - "bin/$T/clan-control" ;;
 win32-x64) dotnet publish CLAN.Control.csproj -c Release -r win-x64 --self-contained true -o "bin/$T" ;;
 *) echo 'Remote controlled-host adapter unavailable on this platform' >&2; exit 1 ;;
esac

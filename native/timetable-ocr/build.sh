#!/bin/sh
set -eu
cd "$(dirname "$0")"
T=$(node -p 'process.platform+"-"+process.arch')
case "$T" in darwin-*) mkdir -p "bin/$T";swiftc -O main.swift -o "bin/$T/clan-timetable-ocr";codesign --force --sign - "bin/$T/clan-timetable-ocr";; *) echo 'Local OCR adapter unavailable; manual review remains available' >&2;exit 1;;esac

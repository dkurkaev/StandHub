#!/bin/bash
# Собирает StandHub.app в build/StandHub.app — универсальный (Apple Silicon + Intel), с ad-hoc подписью.
# Нужны Xcode или Command Line Tools (swiftc) и Node.js (для иконки).
# SIGN_IDENTITY="Developer ID Application: …" — подписать своим сертификатом (для нотаризации).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/StandHub.app"
VERSION="$(sed -n "s/^const VERSION = '\(.*\)';/\1/p" "$ROOT/standhub.js")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "→ компилирую StandHub $VERSION (arm64 + x86_64)"
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" "$ROOT/macos/main.swift" -o "$TMP/StandHub-$arch"
done
lipo -create "$TMP/StandHub-arm64" "$TMP/StandHub-x86_64" -output "$APP/Contents/MacOS/StandHub"

sed "s/__VERSION__/$VERSION/g" "$ROOT/macos/Info.plist" > "$APP/Contents/Info.plist"
cp "$ROOT/standhub.js" "$ROOT/dashboard.html" "$APP/Contents/Resources/"

echo "→ рисую иконку"
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
node "$ROOT/macos/make-icon.js" 1024 "$ICONSET/icon_512x512@2x.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  echo "→ подписываю: $SIGN_IDENTITY"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
else
  codesign --force --sign - "$APP" >/dev/null 2>&1
fi
echo "✅ $APP"

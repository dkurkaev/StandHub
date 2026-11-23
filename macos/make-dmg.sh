#!/bin/bash
# Собирает StandHub.app и упаковывает его в build/StandHub-<версия>.dmg
# (внутри — приложение и ярлык «Applications», чтобы установить перетаскиванием).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/macos/build.sh"

VERSION="$(sed -n "s/^const VERSION = '\(.*\)';/\1/p" "$ROOT/standhub.js")"
DMG="$ROOT/build/StandHub-$VERSION.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "→ упаковываю в DMG"
ditto "$ROOT/build/StandHub.app" "$STAGE/StandHub.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "StandHub $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
fi
echo "✅ $DMG ($(du -h "$DMG" | cut -f1))"

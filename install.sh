#!/bin/bash
# Собирает StandHub.app, ставит его в /Applications и запускает.
# Старый вариант без приложения (агент launchd) при этом удаляется — работает только приложение.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
"$ROOT/macos/build.sh"

DEST="/Applications"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }

# остановить уже запущенный StandHub (приложение и/или старый агент)
pkill -x StandHub 2>/dev/null || true
launchctl bootout "gui/$(id -u)/local.standhub" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/local.standhub.plist"
rm -rf "$HOME/Library/Application Support/StandHub"
for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f 'standhub\.js' >/dev/null || break; sleep 0.3; done

rm -rf "$DEST/StandHub.app"
ditto "$ROOT/build/StandHub.app" "$DEST/StandHub.app"
# сразу после замены бандла LaunchServices иногда отвечает -600 — пробуем ещё раз
for _ in 1 2 3 4 5; do open "$DEST/StandHub.app" 2>/dev/null && break; sleep 1; done

for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "http://127.0.0.1:7777/api/state" 2>/dev/null && break
  sleep 0.5
done
echo "✅ StandHub установлен в $DEST и запущен — значок в Dock."
echo
node "$DEST/StandHub.app/Contents/Resources/standhub.js" urls

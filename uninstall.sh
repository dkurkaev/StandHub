#!/bin/bash
# Закрывает StandHub, убирает его из автозапуска и удаляет приложение.
# Папка с исходниками и настройки (~/.config/standhub) остаются.
set -uo pipefail
for APP in "/Applications/StandHub.app" "$HOME/Applications/StandHub.app"; do
  [ -d "$APP" ] || continue
  "$APP/Contents/MacOS/StandHub" --unregister-login-item 2>/dev/null || true
done
pkill -x StandHub 2>/dev/null || true
launchctl bootout "gui/$(id -u)/local.standhub" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/local.standhub.plist"
rm -rf "$HOME/Library/Application Support/StandHub" "/Applications/StandHub.app" "$HOME/Applications/StandHub.app"
echo "StandHub удалён. Настройки: ~/.config/standhub, лог: ~/Library/Logs/StandHub.log"

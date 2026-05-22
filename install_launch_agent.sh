#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.agentic-tool-usage-tracker.menubar"
PLIST_TEMPLATE="$ROOT/com.agentic-tool-usage-tracker.menubar.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"

mkdir -p "$TARGET_DIR" "$ROOT/logs"

# Substitute __ROOT__ placeholder with actual repo path
sed "s|__ROOT__|$ROOT|g" "$PLIST_TEMPLATE" > "$TARGET_PLIST"

if launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$GUI_DOMAIN" "$TARGET_PLIST" >/dev/null 2>&1 || true
fi

launchctl bootstrap "$GUI_DOMAIN" "$TARGET_PLIST"
launchctl enable "$GUI_DOMAIN/$LABEL"
launchctl kickstart -k "$GUI_DOMAIN/$LABEL"

echo "Installed $LABEL at $TARGET_PLIST"
echo "Manual restart: launchctl kickstart -k $GUI_DOMAIN/$LABEL"

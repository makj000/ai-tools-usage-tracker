#!/bin/zsh
set -euo pipefail

ROOT="/Users/kma/dev/ai-agent/agentic-tool-usage-tracker"
LABEL="com.kma.agentic-tool-usage-tracker-menubar"
SOURCE_PLIST="$ROOT/com.kma.agentic-tool-usage-tracker-menubar.plist"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/com.kma.agentic-tool-usage-tracker-menubar.plist"
GUI_DOMAIN="gui/$(id -u)"

mkdir -p "$TARGET_DIR" "$ROOT/logs"

if launchctl print "$GUI_DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$GUI_DOMAIN" "$TARGET_PLIST" >/dev/null 2>&1 || true
fi

cp "$SOURCE_PLIST" "$TARGET_PLIST"
launchctl bootstrap "$GUI_DOMAIN" "$TARGET_PLIST"
launchctl enable "$GUI_DOMAIN/$LABEL"
launchctl kickstart -k "$GUI_DOMAIN/$LABEL"

echo "Installed $LABEL at $TARGET_PLIST"
echo "Manual restart: launchctl kickstart -k $GUI_DOMAIN/$LABEL"

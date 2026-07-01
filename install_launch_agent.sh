#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$HOME/Library/LaunchAgents"
GUI_DOMAIN="gui/$(id -u)"

mkdir -p "$TARGET_DIR" "$ROOT/logs"

# Both launch agents: the menu bar app and the periodic accuracy inspector.
LABELS=(
  "com.ai-tools-usage-tracker.menubar"
  "com.ai-tools-usage-tracker.accuracy"
  "com.ai-tools-usage-tracker.advisor"
)

for LABEL in "${LABELS[@]}"; do
  PLIST_TEMPLATE="$ROOT/$LABEL.plist"
  TARGET_PLIST="$TARGET_DIR/$LABEL.plist"

  if [[ ! -f "$PLIST_TEMPLATE" ]]; then
    echo "Skipping $LABEL (no template at $PLIST_TEMPLATE)"
    continue
  fi

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
done

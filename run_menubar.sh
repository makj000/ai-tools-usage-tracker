#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# Override NODE_BIN if node is not at the default Homebrew path
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
SWIFT_BIN="/usr/bin/swift"
MENUBAR_BIN="$ROOT/menubar/.build/release/ClaudeMenuBar"

mkdir -p "$ROOT/logs"
cd "$ROOT"

if [[ ! -x "$MENUBAR_BIN" ]]; then
  "$SWIFT_BIN" build -c release --package-path menubar >/dev/null
fi

"$NODE_BIN" "$ROOT/claude/scripts/build.js" >/dev/null 2>&1 || true
"$NODE_BIN" "$ROOT/codex/scripts/build.js" >/dev/null 2>&1 || true

exec "$MENUBAR_BIN"

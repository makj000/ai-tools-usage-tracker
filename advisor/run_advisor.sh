#!/bin/zsh
# launchd entrypoint for the AI tool advisor.
# The plist fires this every 15 minutes; the script enforces the adaptive cadence
# set by the agent via state.json.nextRunAt, exiting early when not yet due.
# Pass --force to bypass the gate.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADV="$ROOT/advisor"
STATE="$ADV/state.json"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

mkdir -p "$ROOT/logs"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ $FORCE -eq 0 && -f "$STATE" ]]; then
  NOW_MS=$(( $(date +%s) * 1000 ))
  NEXT_MS=$("$NODE_BIN" -e \
    'try{const s=require(process.argv[1]);process.stdout.write(String(s.nextRunAt||0))}catch(e){process.stdout.write("0")}' \
    "$STATE" 2>/dev/null)
  if [[ -n "$NEXT_MS" && "$NEXT_MS" -gt 0 && "$NOW_MS" -lt "$NEXT_MS" ]]; then
    echo "[run_advisor] not due yet; skipping"
    exit 0
  fi
fi

cd "$ADV" || exit 1
exec "$NODE_BIN" advisor.js

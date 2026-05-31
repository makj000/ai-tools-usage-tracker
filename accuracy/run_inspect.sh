#!/bin/zsh
# launchd entrypoint for the accuracy inspector.
# The plist fires this on a fixed base interval (hourly); this script enforces
# the *adaptive* cadence by exiting early until state.json's nextRunAt is reached.
# Pass --force to bypass the gate (used by the menu bar's "Run accuracy check now").
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACC="$ROOT/accuracy"
STATE="$ACC/state.json"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"

# Put Homebrew + the user's PATH ahead so `node`, `claude`, and `curl` resolve
# the same way they do interactively (launchd starts with a minimal PATH).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Attach to the user's real Chrome over CDP (avoids bot-detection challenges that
# target Playwright's bundled Chromium). Bring up a headless debug Chrome if one
# isn't already listening; it reuses the logged-in profile at .chrome-cdp-profile.
export ACCURACY_BROWSER="${ACCURACY_BROWSER:-cdp}"
if [[ "$ACCURACY_BROWSER" == "cdp" ]]; then
  ACCURACY_HEADLESS=1 "$ACC/launch_chrome.sh" >/dev/null 2>&1 || true
fi

mkdir -p "$ROOT/logs"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ $FORCE -eq 0 && -f "$STATE" ]]; then
  NOW_MS=$(( $(date +%s) * 1000 ))
  NEXT_MS=$("$NODE_BIN" -e 'try{const s=require(process.argv[1]);process.stdout.write(String(s.nextRunAt||0))}catch(e){process.stdout.write("0")}' "$STATE" 2>/dev/null)
  if [[ -n "$NEXT_MS" && "$NEXT_MS" -gt 0 && "$NOW_MS" -lt "$NEXT_MS" ]]; then
    echo "[run_inspect] not due yet (now < nextRunAt); skipping"
    exit 0
  fi
fi

cd "$ACC" || exit 1
exec "$NODE_BIN" inspect.js --once

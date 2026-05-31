#!/bin/zsh
# Launch your real Google Chrome with a remote-debugging port so the accuracy
# scraper can attach over CDP (ACCURACY_BROWSER=cdp). Using genuine Chrome with
# a real, persistent profile avoids the "Verify you are human" / Turnstile
# challenges that target Playwright's bundled Chromium.
#
# A DEDICATED profile dir (accuracy/.chrome-cdp-profile) is used so this does not
# disturb your main Chrome and so the remote-debugging flag is actually honored
# (Chrome ignores it when attaching to an already-running default profile).
#
# Sign into claude.ai and chatgpt.com once in this window; the session persists.
#
#   ./accuracy/launch_chrome.sh            # headed (use for the one-time login)
#   ACCURACY_HEADLESS=1 ./accuracy/launch_chrome.sh   # headless (for scheduled runs)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$ROOT/accuracy/.chrome-cdp-profile"
PORT="${ACCURACY_CDP_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -x "$CHROME" ]]; then
  echo "Google Chrome not found at: $CHROME" >&2
  exit 1
fi

mkdir -p "$PROFILE"

# Already listening? Then a debug Chrome is up; nothing to do.
if curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "Chrome already exposing CDP on port $PORT — reusing it."
  exit 0
fi

HEADLESS_ARGS=()
if [[ "${ACCURACY_HEADLESS:-0}" == "1" ]]; then
  HEADLESS_ARGS=(--headless=new)
fi

echo "Launching Chrome with remote debugging on port ${PORT} (profile: ${PROFILE})"
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "${HEADLESS_ARGS[@]}" \
  "https://claude.ai/settings/usage" \
  "https://chatgpt.com/codex/settings/usage" \
  >/dev/null 2>&1 &

echo "Chrome launched (pid $!). Sign into both sites, then run:"
echo "  node accuracy/scrape.js --login   # confirms the session is ready"

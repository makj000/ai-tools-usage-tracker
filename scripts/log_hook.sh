#!/bin/bash
# Claude Code hook logger
# Reads JSON event from stdin, appends to events.jsonl
# Usage: Called by Claude Code hooks for PreToolUse/PostToolUse/UserPromptSubmit

TRACKER_DIR="$(dirname "$0")/.."
DATA_FILE="$TRACKER_DIR/data/events.jsonl"

mkdir -p "$TRACKER_DIR/data"

EVENT_TYPE="${1:-unknown}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EPOCH_MS=$(python3 -c "import time; print(int(time.time()*1000))")

# Read stdin JSON, add metadata, append to log
INPUT=$(cat)

if [ -z "$INPUT" ]; then
  exit 0
fi

python3 - <<EOF
import json, sys

try:
    data = json.loads('''$INPUT'''.replace("'", "'\"'\"'") if False else '')
except:
    import subprocess
    result = subprocess.run(['echo', '''$INPUT'''], capture_output=True, text=True)
    try:
        data = json.loads(result.stdout.strip())
    except:
        data = {"raw": '''$INPUT'''}

entry = {
    "event_type": "$EVENT_TYPE",
    "timestamp": "$TIMESTAMP",
    "epoch_ms": $EPOCH_MS,
    **data
}

with open("$DATA_FILE", "a") as f:
    f.write(json.dumps(entry) + "\n")
EOF

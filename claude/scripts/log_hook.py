#!/usr/bin/env python3
"""Claude Code hook event logger.
Reads JSON from stdin, appends enriched event to events.jsonl.
Rotates the file when it exceeds MAX_BYTES, then triggers a backgrounded
rebuild of data.js so refreshing the dashboard always shows fresh data.
Usage: echo '{...}' | python3 log_hook.py <event_type>
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

TRACKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(TRACKER_DIR, "data")
DATA_FILE = os.path.join(DATA_DIR, "events.jsonl")
BUILD_SCRIPT = os.path.join(TRACKER_DIR, "scripts", "build.js")

MAX_BYTES = 10 * 1024 * 1024  # 10 MB — rotate when current file exceeds this

os.makedirs(DATA_DIR, exist_ok=True)

event_type = sys.argv[1] if len(sys.argv) > 1 else "unknown"

raw = sys.stdin.read().strip()
if not raw:
    sys.exit(0)

try:
    data = json.loads(raw)
except json.JSONDecodeError:
    data = {"raw": raw}

# tool_response carries the full raw output of every tool call (entire file
# contents, full command output, etc.) — nothing in build.js or report.html
# ever reads it, but it dominated events.jsonl (individual entries seen over
# 2MB) and therefore data.js, which ballooned to 235MB. Drop it at the
# source instead of paying to write, rotate, re-read, and re-serialize it
# forever downstream.
data.pop("tool_response", None)

entry = {
    "event_type": event_type,
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "epoch_ms": int(time.time() * 1000),
    **data,
}

# Size-based rotation: if events.jsonl exceeds threshold, rename it with
# an ISO timestamp suffix. The new file is created on the next write.
try:
    if os.path.exists(DATA_FILE) and os.path.getsize(DATA_FILE) > MAX_BYTES:
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        rotated = os.path.join(DATA_DIR, f"events-{ts}.jsonl")
        os.rename(DATA_FILE, rotated)
except OSError:
    pass  # never block the hook on rotation failure

with open(DATA_FILE, "a") as f:
    f.write(json.dumps(entry) + "\n")

# Kick off a backgrounded rebuild of data.js so refreshing the dashboard
# always reflects the latest state. We don't wait for it.
#
# Guarded by pgrep: PreToolUse/PostToolUse fire on every tool call across
# every open session, and a rebuild walks the full ~/.claude/projects tree,
# so without this check concurrent hook events pile up dozens of overlapping
# node processes and exhaust system memory (seen: 71 concurrent instances,
# ~40GB RSS, triggering a Jetsam kill and a WindowServer-watchdog forced
# reset). Skip spawning if a rebuild is already in flight.
def _build_already_running():
    try:
        result = subprocess.run(
            ["pgrep", "-f", BUILD_SCRIPT],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return bool(result.stdout.strip())
    except Exception:
        return False

try:
    if os.path.exists(BUILD_SCRIPT) and not _build_already_running():
        with open(os.devnull, "wb") as devnull:
            subprocess.Popen(
                ["node", BUILD_SCRIPT],
                stdout=devnull,
                stderr=devnull,
                stdin=devnull,
                start_new_session=True,
            )
except Exception:
    pass  # never block the hook on build failure

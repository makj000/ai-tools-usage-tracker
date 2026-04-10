#!/usr/bin/env python3
"""Claude Code hook event logger.
Reads JSON from stdin, appends enriched event to events.jsonl.
Usage: echo '{...}' | python3 log_hook.py <event_type>
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

TRACKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(TRACKER_DIR, "data", "events.jsonl")

os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)

event_type = sys.argv[1] if len(sys.argv) > 1 else "unknown"

raw = sys.stdin.read().strip()
if not raw:
    sys.exit(0)

try:
    data = json.loads(raw)
except json.JSONDecodeError:
    data = {"raw": raw}

entry = {
    "event_type": event_type,
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "epoch_ms": int(time.time() * 1000),
    **data,
}

with open(DATA_FILE, "a") as f:
    f.write(json.dumps(entry) + "\n")

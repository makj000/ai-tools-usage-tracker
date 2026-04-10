#!/usr/bin/env python3
"""Fetch Claude/Anthropic credit usage and save a snapshot.
Reads ANTHROPIC_API_KEY from env or .env file.
Snapshots are saved to data/usage_snapshots.jsonl.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

TRACKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USAGE_FILE = os.path.join(TRACKER_DIR, "data", "usage_snapshots.jsonl")
ENV_FILE = os.path.join(TRACKER_DIR, ".env")

os.makedirs(os.path.dirname(USAGE_FILE), exist_ok=True)

# Load .env if present
if os.path.exists(ENV_FILE):
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

api_key = os.environ.get("ANTHROPIC_API_KEY", "")
label = sys.argv[1] if len(sys.argv) > 1 else "snapshot"

snapshot = {
    "label": label,
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "epoch_ms": int(time.time() * 1000),
    "api_key_set": bool(api_key),
    "usage": None,
    "error": None,
}

if not api_key:
    snapshot["error"] = "ANTHROPIC_API_KEY not set"
    print(f"[usage] No API key — set ANTHROPIC_API_KEY in {TRACKER_DIR}/.env", file=sys.stderr)
else:
    # Try known Anthropic usage endpoints
    endpoints = [
        "https://api.anthropic.com/v1/account/credits",
        "https://api.anthropic.com/v1/usage",
    ]
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    for url in endpoints:
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                snapshot["usage"] = json.loads(resp.read())
                snapshot["endpoint"] = url
                break
        except urllib.error.HTTPError as e:
            snapshot["last_http_error"] = f"{url}: HTTP {e.code}"
        except Exception as e:
            snapshot["last_error"] = str(e)

    if snapshot["usage"] is None:
        snapshot["error"] = snapshot.get("last_http_error") or snapshot.get("last_error") or "No usage endpoint available"
        print(f"[usage] Could not fetch usage: {snapshot['error']}", file=sys.stderr)
    else:
        print(f"[usage] {label}: {json.dumps(snapshot['usage'])}")

with open(USAGE_FILE, "a") as f:
    f.write(json.dumps(snapshot) + "\n")

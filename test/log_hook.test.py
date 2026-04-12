#!/usr/bin/env python3
"""Tests for scripts/log_hook.py.
Run: python3 test/log_hook.test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import shutil

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "log_hook.py")
passed = 0
failed = 0


def test(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print(f"  PASS  {name}")
    except Exception as e:
        failed += 1
        print(f"  FAIL  {name}")
        print(f"        {e}")


def run_hook(event_type, stdin_data, env_overrides=None):
    """Run log_hook.py with given input, return (exit_code, events_file_content)."""
    env = os.environ.copy()
    if env_overrides:
        env.update(env_overrides)
    result = subprocess.run(
        [sys.executable, SCRIPT, event_type],
        input=stdin_data,
        capture_output=True,
        text=True,
        env=env,
    )
    return result.returncode


def make_temp_tracker():
    """Create a temp directory mimicking the tracker structure, and patch log_hook
    to use it by running a modified copy."""
    tmpdir = tempfile.mkdtemp(prefix="tracker-test-")
    data_dir = os.path.join(tmpdir, "data")
    os.makedirs(data_dir, exist_ok=True)
    # Copy the script and patch TRACKER_DIR
    with open(SCRIPT) as f:
        source = f.read()
    patched = source.replace(
        'TRACKER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))',
        f'TRACKER_DIR = "{tmpdir}"',
    )
    # Remove the build trigger block entirely (we don't want to run node in tests)
    # Replace from "try:" before Popen through the final "except" block
    import re
    patched = re.sub(
        r'# Kick off a backgrounded rebuild.*',
        '# build trigger disabled for testing',
        patched,
        flags=re.DOTALL,
    )
    script_path = os.path.join(tmpdir, "log_hook_test.py")
    with open(script_path, "w") as f:
        f.write(patched)
    return tmpdir, data_dir, script_path


def run_patched_hook(script_path, event_type, stdin_data):
    result = subprocess.run(
        [sys.executable, script_path, event_type],
        input=stdin_data,
        capture_output=True,
        text=True,
    )
    return result.returncode


# ---- Tests ----
print("\nlog_hook.py - event writing")


def test_writes_event():
    tmpdir, data_dir, script = make_temp_tracker()
    try:
        code = run_patched_hook(script, "PreToolUse", '{"tool_name":"Bash"}')
        assert code == 0, f"exit code {code}"
        events_file = os.path.join(data_dir, "events.jsonl")
        assert os.path.exists(events_file), "events.jsonl not created"
        with open(events_file) as f:
            lines = [l for l in f.readlines() if l.strip()]
        assert len(lines) == 1, f"expected 1 line, got {len(lines)}"
        entry = json.loads(lines[0])
        assert entry["event_type"] == "PreToolUse"
        assert entry["tool_name"] == "Bash"
        assert "timestamp" in entry
        assert "epoch_ms" in entry
    finally:
        shutil.rmtree(tmpdir)


test("writes event to events.jsonl", test_writes_event)


def test_appends_multiple_events():
    tmpdir, data_dir, script = make_temp_tracker()
    try:
        run_patched_hook(script, "PreToolUse", '{"tool_name":"Read"}')
        run_patched_hook(script, "PostToolUse", '{"tool_name":"Read"}')
        run_patched_hook(script, "PreToolUse", '{"tool_name":"Edit"}')
        events_file = os.path.join(data_dir, "events.jsonl")
        with open(events_file) as f:
            lines = [l for l in f.readlines() if l.strip()]
        assert len(lines) == 3, f"expected 3 lines, got {len(lines)}"
        types = [json.loads(l)["event_type"] for l in lines]
        assert types == ["PreToolUse", "PostToolUse", "PreToolUse"]
    finally:
        shutil.rmtree(tmpdir)


test("appends multiple events", test_appends_multiple_events)


def test_handles_empty_stdin():
    tmpdir, data_dir, script = make_temp_tracker()
    try:
        code = run_patched_hook(script, "PreToolUse", "")
        assert code == 0, f"exit code {code}"
        events_file = os.path.join(data_dir, "events.jsonl")
        assert not os.path.exists(events_file), "should not write on empty input"
    finally:
        shutil.rmtree(tmpdir)


test("exits cleanly on empty stdin", test_handles_empty_stdin)


def test_handles_invalid_json():
    tmpdir, data_dir, script = make_temp_tracker()
    try:
        code = run_patched_hook(script, "PreToolUse", "not valid json")
        assert code == 0, f"exit code {code}"
        events_file = os.path.join(data_dir, "events.jsonl")
        with open(events_file) as f:
            entry = json.loads(f.readline())
        assert entry["raw"] == "not valid json"
        assert entry["event_type"] == "PreToolUse"
    finally:
        shutil.rmtree(tmpdir)


test("handles invalid JSON gracefully", test_handles_invalid_json)


def test_user_prompt_submit():
    tmpdir, data_dir, script = make_temp_tracker()
    try:
        code = run_patched_hook(script, "UserPromptSubmit", '{"prompt":"hello world"}')
        assert code == 0
        events_file = os.path.join(data_dir, "events.jsonl")
        with open(events_file) as f:
            entry = json.loads(f.readline())
        assert entry["event_type"] == "UserPromptSubmit"
        assert entry["prompt"] == "hello world"
    finally:
        shutil.rmtree(tmpdir)


test("handles UserPromptSubmit event", test_user_prompt_submit)


print("\nlog_hook.py - file rotation")


def test_rotation_under_threshold():
    tmpdir, data_dir, script = make_temp_tracker()
    try:
        # Write a small file — should NOT rotate
        events_file = os.path.join(data_dir, "events.jsonl")
        with open(events_file, "w") as f:
            f.write('{"old":"data"}\n')
        run_patched_hook(script, "PreToolUse", '{"tool_name":"Bash"}')
        # Should still be one file
        files = [f for f in os.listdir(data_dir) if f.startswith("events")]
        assert len(files) == 1, f"expected 1 file, got {files}"
        with open(events_file) as f:
            lines = f.readlines()
        assert len(lines) == 2, "should append to existing file"
    finally:
        shutil.rmtree(tmpdir)


test("no rotation when under threshold", test_rotation_under_threshold)


def test_rotation_over_threshold():
    tmpdir, data_dir, script = make_temp_tracker()
    try:
        # Patch the script to use a tiny threshold for testing
        with open(script) as f:
            source = f.read()
        source = source.replace("10 * 1024 * 1024", "50")  # 50 bytes
        with open(script, "w") as f:
            f.write(source)

        events_file = os.path.join(data_dir, "events.jsonl")
        # Write enough data to exceed 50 bytes
        with open(events_file, "w") as f:
            f.write('{"padding":"' + "x" * 100 + '"}\n')

        run_patched_hook(script, "PreToolUse", '{"tool_name":"Bash"}')

        files = sorted(os.listdir(data_dir))
        event_files = [f for f in files if f.startswith("events")]
        assert len(event_files) == 2, f"expected 2 files after rotation, got {event_files}"
        rotated = [f for f in event_files if f != "events.jsonl"]
        assert len(rotated) == 1, f"expected 1 rotated file, got {rotated}"
        assert rotated[0].startswith("events-") and rotated[0].endswith(".jsonl")
        # New events.jsonl should have only the new event
        with open(events_file) as f:
            lines = f.readlines()
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["tool_name"] == "Bash"
    finally:
        shutil.rmtree(tmpdir)


test("rotates when over threshold", test_rotation_over_threshold)


# ---- Summary ----
print(f"\n{passed + failed} tests: {passed} passed, {failed} failed\n")
sys.exit(1 if failed > 0 else 0)

/**
 * Shared paths, provider config, and small helpers for the accuracy subsystem.
 */
const os = require("os");
const path = require("path");

const ACCURACY_DIR = path.dirname(__dirname);
const REPO_ROOT = path.dirname(ACCURACY_DIR);
const SNAPSHOTS_DIR = path.join(ACCURACY_DIR, "snapshots");
const PROFILE_DIR = path.join(ACCURACY_DIR, ".browser-profile");
const STATE_PATH = path.join(ACCURACY_DIR, "state.json");
const HISTORY_PATH = path.join(ACCURACY_DIR, "history.jsonl");
const PROMPT_PATH = path.join(ACCURACY_DIR, "prompt.md");
const LATEST_PATH = path.join(SNAPSHOTS_DIR, "latest.json");

// Per-provider home dirs the Swift menu bar reads from (main.swift:552-557).
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const CODEX_DIR = path.join(os.homedir(), ".codex");

// Providers the inspector tracks. `usagePageURL` mirrors menubar/Sources/main.swift.
// `menubarJson` is the file the menu bar reads (the "data to show"); the inspector
// compares against exactly these numbers. `accuracyJson` is where the inspector
// writes its verdict, placed beside menubarJson so the menu bar can read it.
const PROVIDERS = [
  {
    key: "claude",
    label: "Claude Code",
    usagePageURL: "https://claude.ai/settings/usage",
    menubarJson: path.join(CLAUDE_DIR, "claude-tracker-menubar.json"),
    accuracyJson: path.join(CLAUDE_DIR, "claude-accuracy.json"),
    // Files the agent is allowed to edit when calibrating this provider.
    configPath: path.join(REPO_ROOT, "claude", "data", "config.json"),
    buildScript: path.join(REPO_ROOT, "claude", "scripts", "build.js"),
    buildCmd: "node claude/scripts/build.js",
    testCmd: "node claude/test/build.test.js",
  },
  {
    key: "codex",
    label: "Codex CLI",
    usagePageURL: "https://chatgpt.com/codex/settings/usage",
    menubarJson: path.join(CODEX_DIR, "codex-tracker-menubar.json"),
    accuracyJson: path.join(CODEX_DIR, "codex-accuracy.json"),
    configPath: null, // codex has no $ ceiling / seed config today
    buildScript: path.join(REPO_ROOT, "codex", "scripts", "build.js"),
    buildCmd: "node codex/scripts/build.js",
    testCmd: "node codex/test/build.test.js",
  },
];

// Adaptive cadence bounds (hours).
const MIN_HOURS = 2;
const MAX_HOURS = 168; // one week
const DEFAULT_HOURS = 24;

// A metric is "off" when the absolute percentage-point gap exceeds this.
const DISCREPANCY_THRESHOLD_PP = 5;

function providerByKey(key) {
  return PROVIDERS.find((p) => p.key === key) || null;
}

function clampHours(h) {
  if (!Number.isFinite(h)) return DEFAULT_HOURS;
  return Math.max(MIN_HOURS, Math.min(MAX_HOURS, h));
}

module.exports = {
  ACCURACY_DIR,
  REPO_ROOT,
  SNAPSHOTS_DIR,
  PROFILE_DIR,
  STATE_PATH,
  HISTORY_PATH,
  PROMPT_PATH,
  LATEST_PATH,
  CLAUDE_DIR,
  CODEX_DIR,
  PROVIDERS,
  MIN_HOURS,
  MAX_HOURS,
  DEFAULT_HOURS,
  DISCREPANCY_THRESHOLD_PP,
  providerByKey,
  clampHours,
};

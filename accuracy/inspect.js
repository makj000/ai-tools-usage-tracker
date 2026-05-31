#!/usr/bin/env node
/**
 * inspect.js — one accuracy cycle (and adaptive rescheduling).
 *
 *   node inspect.js --once             scrape → agent → record → reschedule
 *   node inspect.js --once --dry-run   agent analyzes only, makes no edits
 *   node inspect.js --once --no-scrape reuse the latest snapshots
 *   node inspect.js --once --mock-agent verdict.json   skip the CLI, inject a verdict
 *                                        (for testing the recording/cadence logic)
 *
 * The actual number-extraction and auto-fix is delegated to the local `claude`
 * CLI (agentic), instructed by accuracy/prompt.md. This orchestrator handles
 * scraping, invoking the agent, persisting the verdict, surfacing status to the
 * menu bar, and choosing the next interval (shorter when discrepancies are
 * frequent + large, longer when accurate).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  PROVIDERS, REPO_ROOT, SNAPSHOTS_DIR, STATE_PATH, HISTORY_PATH, PROMPT_PATH,
  LATEST_PATH, CLAUDE_DIR, MIN_HOURS, MAX_HOURS, DEFAULT_HOURS, clampHours,
  providerByKey,
} = require("./lib/paths");
const { expectedMetrics } = require("./expected");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const NO_SCRAPE = args.includes("--no-scrape");
const mockIdx = args.indexOf("--mock-agent");
const MOCK_AGENT = mockIdx >= 0 ? args[mockIdx + 1] : null;

function log(...a) { console.log("[inspect]", ...a); }

function readJsonSafe(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

// ---- scrape ---------------------------------------------------------------
function runScrape() {
  if (NO_SCRAPE) { log("--no-scrape: reusing latest snapshots"); return; }
  log("scraping official usage pages…");
  try {
    execFileSync(process.execPath, [path.join(__dirname, "scrape.js")], {
      stdio: "inherit", cwd: __dirname,
    });
  } catch (e) {
    log("scrape failed:", e.message, "— continuing with whatever snapshots exist");
  }
}

// ---- agent ----------------------------------------------------------------
function buildAgentPrompt(expected, latest) {
  const tmpl = fs.readFileSync(PROMPT_PATH, "utf8");
  const allowed = {};
  for (const p of PROVIDERS) {
    allowed[p.key] = {
      configPath: p.configPath ? path.relative(REPO_ROOT, p.configPath) : null,
      buildScript: path.relative(REPO_ROOT, p.buildScript),
      buildCmd: p.buildCmd,
      testCmd: p.testCmd,
    };
  }
  const snapshots = {};
  for (const p of PROVIDERS) {
    const s = latest?.providers?.[p.key];
    snapshots[p.key] = s ? {
      textFile: path.join(SNAPSHOTS_DIR, s.textFile),
      screenshot: path.join(SNAPSHOTS_DIR, s.screenshot),
      loginWall: s.loginWall,
      error: s.error,
    } : { missing: true };
  }
  const ctx = {
    MODE: DRY_RUN ? "dry-run" : "fix",
    EXPECTED_JSON: expected,
    SNAPSHOTS: snapshots,
    ALLOWED_EDITS: allowed,
    CALIBRATION_MEMORY: path.join(
      CLAUDE_DIR, "projects",
      "-Users-kma-dev-ai-ai-tools-usage-tracker", "memory",
      "project_weekly_calibration.md"
    ),
  };
  return `${tmpl}\n\n---\n## Run context\n\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\`\n`;
}

function extractJsonObject(text) {
  if (!text) return null;
  // Find the last balanced {...} block (the verdict).
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  for (let s = start; s >= 0 && s <= end; s = text.indexOf("{", s + 1)) {
    try { return JSON.parse(text.slice(s, end + 1)); } catch { /* try next */ }
  }
  return null;
}

function runAgent(prompt) {
  if (MOCK_AGENT) {
    log("--mock-agent: reading verdict from", MOCK_AGENT);
    return readJsonSafe(path.resolve(MOCK_AGENT));
  }
  const bin = process.env.ACCURACY_CLAUDE_BIN || "claude";
  // Unattended runs can't answer permission prompts, so we pass an explicit
  // allowlist instead of --dangerously-skip-permissions (scoped-allowlist mode).
  // Dry-run: read-only. Fix: read + edit the calibration files + run build/test
  // + revert via git — nothing broader. Override entirely with ACCURACY_CLAUDE_ARGS.
  const FIX_TOOLS = [
    "Read", "Glob", "Grep", "Edit", "Write",
    "Bash(node *)", "Bash(npm test*)", "Bash(npm run *)",
    "Bash(git checkout *)", "Bash(git diff*)", "Bash(git status*)",
  ].join(",");
  const extra = process.env.ACCURACY_CLAUDE_ARGS
    ? process.env.ACCURACY_CLAUDE_ARGS.split(" ").filter(Boolean)
    : DRY_RUN
      ? ["--allowedTools", "Read,Glob,Grep"]
      : ["--allowedTools", FIX_TOOLS];
  const cliArgs = ["-p", prompt, "--output-format", "json", ...extra];
  log(`invoking agent (${bin}, mode=${DRY_RUN ? "dry-run" : "fix"})…`);
  let raw;
  try {
    raw = execFileSync(bin, cliArgs, {
      cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      timeout: 1000 * 60 * 20,
    });
  } catch (e) {
    log("agent invocation failed:", e.message);
    return { error: `agent invocation failed: ${e.message}` };
  }
  // --output-format json wraps the result; the verdict is inside .result.
  const env = extractJsonObject(raw);
  const inner = env && typeof env.result === "string" ? extractJsonObject(env.result) : null;
  return inner || (env && env.providers ? env : { error: "could not parse agent verdict", raw: raw.slice(0, 2000) });
}

// ---- adaptive cadence -----------------------------------------------------
function readHistory(limit = 10) {
  try {
    return fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean)
      .slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// EWMA over recent max-abs-delta (percentage points). Higher recent error and a
// high "off" frequency pull the interval toward MIN; calm history pushes toward MAX.
function nextInterval(verdict, prevState) {
  const agentProposal = clampHours(verdict?.proposedNextIntervalHours ?? DEFAULT_HOURS);
  const history = readHistory(8);
  const samples = [...history, verdict].filter(Boolean);
  if (!samples.length) return agentProposal;

  let ewmaDelta = 0; let weight = 0; const alpha = 0.5;
  for (const s of samples) {
    const d = Number.isFinite(s.maxAbsDeltaPp) ? s.maxAbsDeltaPp : 0;
    ewmaDelta = weight === 0 ? d : alpha * d + (1 - alpha) * ewmaDelta;
    weight = 1;
  }
  const offRate = samples.filter((s) => s.anyOff).length / samples.length;

  // Map error severity → an interval. 0pp error & no offs → MAX; ≥15pp or
  // always-off → MIN; smooth in between.
  const severity = Math.min(1, ewmaDelta / 15) * 0.6 + offRate * 0.4;
  const severityInterval = MAX_HOURS - severity * (MAX_HOURS - MIN_HOURS);

  // Blend the agent's view with the history-derived view; lean on history.
  let blended = 0.4 * agentProposal + 0.6 * severityInterval;

  // If everything is calm, grow geometrically from the previous interval so we
  // back off gradually rather than jumping straight to a week.
  if (!verdict?.anyOff && (prevState?.intervalHours)) {
    blended = Math.min(blended, prevState.intervalHours * 1.5);
    blended = Math.max(blended, prevState.intervalHours); // never shrink when calm
  }
  return Math.round(clampHours(blended) * 10) / 10;
}

// ---- per-provider menu-bar status ----------------------------------------
function writeAccuracyStatus(verdict, intervalHours) {
  const now = new Date().toISOString();
  for (const p of PROVIDERS) {
    const pv = verdict?.providers?.[p.key] || {};
    const deltas = [pv?.deltaPp?.window, pv?.deltaPp?.weekly]
      .filter((d) => Number.isFinite(d)).map(Math.abs);
    const maxDelta = deltas.length ? Math.max(...deltas) : null;
    let status = "ok";
    if (verdict?.error) status = "error";
    else if (pv.needsLogin) status = "needs-login";
    else if (pv.off) status = DRY_RUN ? "off" : "fixing";
    const out = {
      checkedAt: now,
      status,                         // ok | off | fixing | needs-login | error | unknown
      maxDeltaPp: maxDelta,
      action: pv.action ?? null,
      testsPassed: pv.testsPassed ?? null,
      filesChanged: pv.filesChanged ?? [],
      notes: pv.notes ?? verdict?.error ?? null,
      nextCheckInHours: intervalHours,
    };
    try { fs.writeFileSync(p.accuracyJson, JSON.stringify(out, null, 2)); } catch (e) {
      log(`could not write ${p.accuracyJson}:`, e.message);
    }
  }
}

function appendHistory(record) {
  fs.appendFileSync(HISTORY_PATH, JSON.stringify(record) + "\n");
}

function writeState(intervalHours, verdict) {
  const nextRunAt = Date.now() + intervalHours * 3600 * 1000;
  const state = {
    updatedAt: new Date().toISOString(),
    intervalHours,
    nextRunAt,
    nextRunAtISO: new Date(nextRunAt).toISOString(),
    lastVerdict: {
      anyOff: !!verdict?.anyOff,
      maxAbsDeltaPp: verdict?.maxAbsDeltaPp ?? null,
      error: verdict?.error ?? null,
    },
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  return state;
}

// ---- main -----------------------------------------------------------------
function main() {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const prevState = readJsonSafe(STATE_PATH);

  runScrape();
  const expected = expectedMetrics();
  const latest = readJsonSafe(LATEST_PATH, { providers: {} });

  const prompt = buildAgentPrompt(expected, latest);
  const verdict = runAgent(prompt) || { error: "no verdict" };

  // Normalize the summary fields the cadence logic relies on.
  if (!Number.isFinite(verdict.maxAbsDeltaPp)) {
    const all = Object.values(verdict.providers || {}).flatMap((pv) =>
      [pv?.deltaPp?.window, pv?.deltaPp?.weekly].filter(Number.isFinite).map(Math.abs));
    verdict.maxAbsDeltaPp = all.length ? Math.max(...all) : 0;
  }
  if (typeof verdict.anyOff !== "boolean") {
    verdict.anyOff = Object.values(verdict.providers || {}).some((pv) => pv?.off);
  }

  const intervalHours = nextInterval(verdict, prevState);

  const record = {
    at: new Date().toISOString(),
    mode: DRY_RUN ? "dry-run" : "fix",
    anyOff: verdict.anyOff,
    maxAbsDeltaPp: verdict.maxAbsDeltaPp,
    intervalHours,
    error: verdict.error ?? null,
    providers: verdict.providers ?? null,
  };
  appendHistory(record);
  writeAccuracyStatus(verdict, intervalHours);
  const state = writeState(intervalHours, verdict);

  log(`verdict: anyOff=${verdict.anyOff} maxΔ=${verdict.maxAbsDeltaPp}pp ` +
      `→ next check in ${intervalHours}h (${state.nextRunAtISO})`);
  if (verdict.error) { log("error:", verdict.error); process.exitCode = 1; }
}

main();

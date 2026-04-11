#!/usr/bin/env node
/**
 * Build script: reads all data sources and writes data.js
 * Run: node scripts/build.js
 *      node scripts/build.js --watch    (re-run on file changes)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.dirname(__dirname);
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT = path.join(ROOT, "data.js");
const HISTORY_PATH = path.join(os.homedir(), ".claude", "history.jsonl");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

// Pricing per million tokens
const MODEL_PRICING = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-opus-4-6":   { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-haiku-4-5":  { input: 0.80, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  "default":           { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
};

function getPricing(model) {
  if (!model) return MODEL_PRICING.default;
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (key !== "default" && model.includes(key)) return price;
  }
  return MODEL_PRICING.default;
}

function calcCost(usage, model) {
  const p = getPricing(model);
  return (
    (usage.input_tokens || 0) * p.input +
    (usage.cache_creation_input_tokens || 0) * p.cacheWrite +
    (usage.cache_read_input_tokens || 0) * p.cacheRead +
    (usage.output_tokens || 0) * p.output
  ) / 1_000_000;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Read events.jsonl plus any rotated events-*.jsonl files in DATA_DIR.
// Returns merged events plus metadata about rotated files (including which
// are older than 6 months and eligible for cleanup).
function readAllEventFiles() {
  if (!fs.existsSync(DATA_DIR)) return { events: [], rotated: [], oldFiles: [] };
  const all = fs.readdirSync(DATA_DIR)
    .filter(f => f === "events.jsonl" || /^events-.*\.jsonl$/.test(f))
    .sort();

  const events = [];
  const rotated = [];
  const oldFiles = [];
  const cutoff = Date.now() - SIX_MONTHS_MS;

  for (const f of all) {
    const fp = path.join(DATA_DIR, f);
    const stat = fs.statSync(fp);
    events.push(...readJsonl(fp));
    if (f !== "events.jsonl") {
      const info = { name: f, sizeKB: Math.round(stat.size / 1024), mtime: stat.mtimeMs };
      rotated.push(info);
      if (stat.mtimeMs < cutoff) oldFiles.push(info);
    }
  }
  return { events, rotated, oldFiles };
}

// Atomic write: write to a temp file, then rename. Prevents corruption if
// two builds run concurrently (e.g. backgrounded by hook).
function writeAtomic(target, content) {
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function slugToPath(slug) { return slug.replace(/-/g, "/").replace(/^\//, ""); }
function zeroCounts() { return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, messages: 0, cost: 0 }; }
function addCounts(target, usage) {
  target.input_tokens += usage.input_tokens || 0;
  target.output_tokens += usage.output_tokens || 0;
  target.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  target.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  target.messages = (target.messages || 0) + 1;
}

function readAllTranscripts() {
  if (!fs.existsSync(PROJECTS_DIR)) return { sessions: {}, perDay: {}, perProject: {}, totals: zeroCounts() };

  const sessions = {};
  const perDay = {};
  const perProject = {};
  const totals = zeroCounts();

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

  for (const projectSlug of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectSlug);
    const projectName = "/" + slugToPath(projectSlug);
    const files = fs.readdirSync(projectPath).filter(f => f.endsWith(".jsonl"));

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = path.join(projectPath, file);
      try {
        const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry.type !== "assistant" || !entry.message?.usage) continue;
          const model = entry.message.model;
          if (!model || model === "<synthetic>") continue;

          const usage = entry.message.usage;
          const cost = calcCost(usage, model);
          const ts = entry.timestamp;
          const day = ts ? ts.slice(0, 10) : "unknown";

          if (!sessions[sessionId]) {
            sessions[sessionId] = { sessionId, project: projectName, model, counts: zeroCounts(), cost: 0, firstTs: ts, lastTs: ts };
          }
          addCounts(sessions[sessionId].counts, usage);
          sessions[sessionId].cost += cost;
          if (ts < sessions[sessionId].firstTs) sessions[sessionId].firstTs = ts;
          if (ts > sessions[sessionId].lastTs) sessions[sessionId].lastTs = ts;

          if (!perDay[day]) perDay[day] = { counts: zeroCounts(), cost: 0 };
          addCounts(perDay[day].counts, usage);
          perDay[day].cost += cost;

          if (!perProject[projectName]) perProject[projectName] = { counts: zeroCounts(), cost: 0 };
          addCounts(perProject[projectName].counts, usage);
          perProject[projectName].cost += cost;

          addCounts(totals, usage);
          totals.cost = (totals.cost || 0) + cost;
        }
      } catch { /* skip */ }
    }
  }

  return { sessions, perDay, perProject, totals };
}

function buildTokens() {
  const data = readAllTranscripts();
  const sessionList = Object.values(data.sessions)
    .sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""))
    .slice(0, 100);
  const projectList = Object.entries(data.perProject)
    .map(([project, d]) => ({ project, ...d }))
    .sort((a, b) => b.cost - a.cost);
  return { totals: data.totals, sessions: sessionList, perDay: data.perDay, projects: projectList };
}

function buildStats(events) {
  const history = readJsonl(HISTORY_PATH);

  const sessions = {};
  for (const h of history) {
    if (!h.sessionId) continue;
    if (!sessions[h.sessionId]) {
      sessions[h.sessionId] = { sessionId: h.sessionId, project: h.project, prompts: [], start: h.timestamp, end: h.timestamp };
    }
    sessions[h.sessionId].prompts.push(h.display);
    sessions[h.sessionId].start = Math.min(sessions[h.sessionId].start, h.timestamp);
    sessions[h.sessionId].end = Math.max(sessions[h.sessionId].end, h.timestamp);
  }

  const toolCounts = {};
  for (const e of events) {
    const tool = e.tool_name || e.toolName || "unknown";
    toolCounts[tool] = (toolCounts[tool] || 0) + 1;
  }

  const perDay = {};
  for (const h of history) {
    if (!h.timestamp) continue;
    const day = new Date(h.timestamp).toISOString().slice(0, 10);
    perDay[day] = (perDay[day] || 0) + 1;
  }

  return {
    totalPrompts: history.length,
    totalSessions: Object.keys(sessions).length,
    totalToolUses: events.filter(e => e.event_type === "PreToolUse").length,
    toolCounts,
    perDay,
    sessions: Object.values(sessions).sort((a, b) => b.end - a.end).slice(0, 50),
  };
}

function maybeCleanup(oldFiles) {
  if (!process.argv.includes("--cleanup")) return [];
  const removed = [];
  for (const info of oldFiles) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, info.name));
      removed.push(info.name);
      console.log(`[cleanup] removed ${info.name} (${info.sizeKB} KB)`);
    } catch (e) {
      console.warn(`[cleanup] failed to remove ${info.name}: ${e.message}`);
    }
  }
  return removed;
}

function build() {
  const t0 = Date.now();
  const eventData = readAllEventFiles();
  maybeCleanup(eventData.oldFiles);
  // Re-scan after cleanup so the report reflects the new state.
  const fresh = process.argv.includes("--cleanup") ? readAllEventFiles() : eventData;

  const data = {
    generatedAt: new Date().toISOString(),
    tokens: buildTokens(),
    stats: buildStats(fresh.events),
    history: readJsonl(HISTORY_PATH),
    events: fresh.events,
    maintenance: {
      eventFiles: fresh.rotated,
      oldFiles: fresh.oldFiles.map(f => f.name),
    },
  };
  const js = `// Generated by scripts/build.js — do not edit\nwindow.TRACKER_DATA = ${JSON.stringify(data)};\n`;
  writeAtomic(OUTPUT, js);
  const ms = Date.now() - t0;
  const kb = (js.length / 1024).toFixed(1);
  console.log(`[build] wrote data.js (${kb} KB) — $${data.tokens.totals.cost.toFixed(2)} equiv · ${data.tokens.totals.messages} turns · ${ms}ms`);
}

build();

if (process.argv.includes("--watch")) {
  console.log("[build] watching for changes... (Ctrl+C to stop)");
  let timer = null;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(build, 800); };
  // Watch projects dir, events file, history file
  try { fs.watch(PROJECTS_DIR, { recursive: true }, debounced); } catch (e) { console.warn("[build] cannot watch projects dir:", e.message); }
  try { if (fs.existsSync(EVENTS_FILE)) fs.watch(EVENTS_FILE, debounced); } catch {}
  try { if (fs.existsSync(HISTORY_PATH)) fs.watch(HISTORY_PATH, debounced); } catch {}
}

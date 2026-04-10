const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3737;

const DATA_DIR = path.join(__dirname, "data");
const HISTORY_PATH = path.join(os.homedir(), ".claude", "history.jsonl");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Pricing per million tokens
const MODEL_PRICING = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-opus-4-6":   { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  "claude-haiku-4-5":  { input: 0.80, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  "default":           { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
};

function getPricing(model) {
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (key !== "default" && model && model.includes(key)) return price;
    if (model === key) return price;
  }
  return MODEL_PRICING["default"];
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
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  return lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// Decode project slug back to path
function slugToPath(slug) {
  return slug.replace(/-/g, "/").replace(/^\//, "");
}

function readAllTranscripts() {
  if (!fs.existsSync(PROJECTS_DIR)) return { sessions: {}, perDay: {}, perProject: {}, totals: zeroCounts() };

  const sessions = {};
  const perDay = {};
  const perProject = {};
  const totals = zeroCounts();

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

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

          // Session
          if (!sessions[sessionId]) {
            sessions[sessionId] = { sessionId, project: projectName, model, counts: zeroCounts(), cost: 0, firstTs: ts, lastTs: ts };
          }
          addCounts(sessions[sessionId].counts, usage);
          sessions[sessionId].cost += cost;
          if (ts < sessions[sessionId].firstTs) sessions[sessionId].firstTs = ts;
          if (ts > sessions[sessionId].lastTs) sessions[sessionId].lastTs = ts;

          // Per day
          if (!perDay[day]) perDay[day] = { counts: zeroCounts(), cost: 0 };
          addCounts(perDay[day].counts, usage);
          perDay[day].cost += cost;

          // Per project
          if (!perProject[projectName]) perProject[projectName] = { counts: zeroCounts(), cost: 0 };
          addCounts(perProject[projectName].counts, usage);
          perProject[projectName].cost += cost;

          // Totals
          addCounts(totals, usage);
          totals.cost = (totals.cost || 0) + cost;
        }
      } catch { /* skip unreadable files */ }
    }
  }

  return { sessions, perDay, perProject, totals };
}

function zeroCounts() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, messages: 0, cost: 0 };
}

function addCounts(target, usage) {
  target.input_tokens += usage.input_tokens || 0;
  target.output_tokens += usage.output_tokens || 0;
  target.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  target.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  target.messages = (target.messages || 0) + 1;
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/history", (req, res) => {
  res.json(readJsonl(HISTORY_PATH));
});

app.get("/api/events", (req, res) => {
  res.json(readJsonl(EVENTS_FILE));
});

app.get("/api/tokens", (req, res) => {
  const data = readAllTranscripts();
  const sessionList = Object.values(data.sessions)
    .sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""))
    .slice(0, 100);

  const projectList = Object.entries(data.perProject)
    .map(([project, d]) => ({ project, ...d }))
    .sort((a, b) => b.cost - a.cost);

  res.json({
    totals: data.totals,
    sessions: sessionList,
    perDay: data.perDay,
    projects: projectList,
  });
});

app.get("/api/stats", (req, res) => {
  const history = readJsonl(HISTORY_PATH);
  const events = readJsonl(EVENTS_FILE);

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

  res.json({
    totalPrompts: history.length,
    totalSessions: Object.keys(sessions).length,
    totalToolUses: events.filter((e) => e.event_type === "PreToolUse").length,
    toolCounts,
    perDay,
    sessions: Object.values(sessions).sort((a, b) => b.end - a.end).slice(0, 50),
  });
});

app.listen(PORT, () => {
  console.log(`Claude Tracker running at http://localhost:${PORT}`);
});

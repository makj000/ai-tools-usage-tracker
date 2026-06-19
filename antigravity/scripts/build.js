#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.dirname(__dirname);
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT = path.join(DATA_DIR, "data.js");
const ANTIGRAVITY_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli");
const HISTORY_PATH = path.join(ANTIGRAVITY_DIR, "history.jsonl");
const CONVERSATIONS_DIR = path.join(ANTIGRAVITY_DIR, "conversations");
const LOG_DIR = path.join(ANTIGRAVITY_DIR, "log");
const MENUBAR_JSON_PATH = path.join(ANTIGRAVITY_DIR, "antigravity-tracker-menubar.json");
const TIME_ZONE = "America/Los_Angeles";
const MENUBAR_ONLY_FLAG = "--menubar-only";

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function dateKey(epochMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shortProjectName(workspace) {
  if (!workspace) return "unknown";
  const parts = workspace.replace(/\/$/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || workspace;
}

function buildProjects(history) {
  const projects = new Map();
  for (const entry of history) {
    if (!entry.workspace) continue;
    const bucket = projects.get(entry.workspace) || {
      workspace: entry.workspace,
      shortProject: shortProjectName(entry.workspace),
      prompts: 0,
      conversations: new Set(),
      lastActivityAtEpochMs: 0,
      lastPrompt: "",
    };
    bucket.prompts += 1;
    if (entry.conversationId) bucket.conversations.add(entry.conversationId);
    if (entry.timestamp > bucket.lastActivityAtEpochMs) {
      bucket.lastActivityAtEpochMs = entry.timestamp;
      bucket.lastPrompt = entry.display || "";
    }
    projects.set(entry.workspace, bucket);
  }
  return Array.from(projects.values())
    .map((project) => {
      const { conversations, ...fields } = project;
      return {
        ...fields,
        conversationCount: conversations.size,
        lastActivityAt: project.lastActivityAtEpochMs ? new Date(project.lastActivityAtEpochMs).toISOString() : null,
      };
    })
    .sort((a, b) => b.prompts - a.prompts || b.lastActivityAtEpochMs - a.lastActivityAtEpochMs);
}

function buildDaily(history) {
  const daily = new Map();
  for (const entry of history) {
    if (!Number.isFinite(entry.timestamp)) continue;
    const date = dateKey(entry.timestamp);
    const bucket = daily.get(date) || { date, prompts: 0, conversations: new Set() };
    bucket.prompts += 1;
    if (entry.conversationId) bucket.conversations.add(entry.conversationId);
    daily.set(date, bucket);
  }
  return Array.from(daily.values())
    .map((entry) => ({ date: entry.date, prompts: entry.prompts, conversations: entry.conversations.size }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function readConversationStorage(conversationsDir = CONVERSATIONS_DIR) {
  if (!fs.existsSync(conversationsDir)) return { databaseCount: 0, totalBytes: 0 };
  let databaseCount = 0;
  let totalBytes = 0;
  for (const entry of fs.readdirSync(conversationsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
    databaseCount += 1;
    try {
      totalBytes += fs.statSync(path.join(conversationsDir, entry.name)).size;
    } catch {}
  }
  return { databaseCount, totalBytes };
}

function parseDurationSeconds(text) {
  const match = text.match(/Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!match) return null;
  return (Number(match[1]) || 0) * 3600 + (Number(match[2]) || 0) * 60 + (Number(match[3]) || 0);
}

function parseLogEpochSeconds(fileName, line) {
  const yearMatch = fileName.match(/cli-(\d{4})/);
  const lineMatch = line.match(/^[A-Z](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\./);
  if (!yearMatch || !lineMatch) return null;
  const [, month, day, hour, minute, second] = lineMatch;
  const localDate = new Date(
    Number(yearMatch[1]),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  return Math.floor(localDate.getTime() / 1000);
}

function readQuotaState(logDir = LOG_DIR, nowSec = Math.floor(Date.now() / 1000)) {
  if (!fs.existsSync(logDir)) return { exhausted: false, resetEpoch: null, observedAt: null };
  let latest = null;
  for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^cli-\d{8}_\d{6}\.log$/.test(entry.name)) continue;
    let lines;
    try {
      lines = fs.readFileSync(path.join(logDir, entry.name), "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes("RESOURCE_EXHAUSTED") || !line.includes("Individual quota reached")) continue;
      const durationSeconds = parseDurationSeconds(line);
      const observedAt = parseLogEpochSeconds(entry.name, line);
      if (durationSeconds == null || observedAt == null) continue;
      if (!latest || observedAt > latest.observedAt) {
        latest = { observedAt, resetEpoch: observedAt + durationSeconds };
      }
    }
  }
  if (!latest || latest.resetEpoch <= nowSec) {
    return { exhausted: false, resetEpoch: null, observedAt: latest?.observedAt ?? null };
  }
  return { exhausted: true, resetEpoch: latest.resetEpoch, observedAt: latest.observedAt };
}

function buildMenubarData(quota) {
  const weekly = quota.exhausted ? {
    usage: 100,
    ceiling: 100,
    pct: 1,
    usageDisplay: "100% used",
    ceilingDisplay: null,
    detail: null,
    startEpoch: null,
    endEpoch: quota.resetEpoch,
    isRemaining: false,
  } : null;
  return {
    updatedAt: new Date().toISOString(),
    title: "Antigravity",
    reportPath: path.resolve(ROOT, "report.html"),
    primaryLabel: null,
    secondaryLabel: "weekly",
    primary: null,
    secondary: weekly,
    weekly,
  };
}

function loadTrackerData() {
  const history = readJsonl(HISTORY_PATH)
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp);
  const projects = buildProjects(history);
  const daily = buildDaily(history);
  const storage = readConversationStorage();
  const quota = readQuotaState();
  const conversationIds = new Set(history.map((entry) => entry.conversationId).filter(Boolean));
  const activeDays = new Set(history.map((entry) => dateKey(entry.timestamp)));
  return {
    generatedAt: new Date().toISOString(),
    provider: "antigravity",
    overview: {
      promptCount: history.length,
      conversationCount: Math.max(conversationIds.size, storage.databaseCount),
      projectCount: projects.length,
      activeDays: activeDays.size,
      databaseCount: storage.databaseCount,
      databaseBytes: storage.totalBytes,
    },
    quota,
    projects,
    daily,
    recentPrompts: history.slice(0, 100).map((entry) => ({
      text: entry.display || "",
      workspace: entry.workspace || "unknown",
      shortProject: shortProjectName(entry.workspace),
      conversationId: entry.conversationId || null,
      timestamp: new Date(entry.timestamp).toISOString(),
    })),
  };
}

function writeAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, target);
}

function main(argv = process.argv.slice(2)) {
  const menubarOnly = argv.includes(MENUBAR_ONLY_FLAG);
  const data = loadTrackerData();
  if (!menubarOnly) writeAtomic(OUTPUT, `window.TRACKER_DATA = ${JSON.stringify(data)};\n`);
  try {
    writeAtomic(MENUBAR_JSON_PATH, JSON.stringify(buildMenubarData(data.quota), null, 2));
  } catch (error) {
    if (menubarOnly) throw error;
    console.warn(`[antigravity build] could not write menubar data: ${error.message}`);
  }
  const target = menubarOnly ? MENUBAR_JSON_PATH : OUTPUT;
  console.log(`[antigravity build] wrote ${target} with ${data.overview.promptCount} prompts and ${data.overview.conversationCount} conversations`);
}

if (require.main === module) main();

module.exports = {
  buildDaily,
  buildMenubarData,
  buildProjects,
  loadTrackerData,
  parseDurationSeconds,
  parseLogEpochSeconds,
  readConversationStorage,
  readJsonl,
  readQuotaState,
  shortProjectName,
};

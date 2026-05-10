#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.dirname(__dirname);
const DATA_DIR = path.join(ROOT, "data");
const OUTPUT = path.join(DATA_DIR, "data.js");
const STATE_DB = path.join(os.homedir(), ".codex", "state_5.sqlite");
const HISTORY_PATH = path.join(os.homedir(), ".codex", "history.jsonl");
const TIME_ZONE = "America/Los_Angeles";

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

function execSql(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim();
  if (!output) return [];
  return JSON.parse(output);
}

function formatProjectLabel(cwd, homeDir) {
  if (!cwd) return "unknown";
  if (cwd === homeDir) return "~";
  if (cwd.startsWith(homeDir + path.sep)) return "~" + cwd.slice(homeDir.length);
  return cwd;
}

function shortProjectName(cwd) {
  if (!cwd) return "unknown";
  const clean = cwd.replace(/\/$/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join("/");
  return parts[0] || clean;
}

function formatDateParts(epochMs) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function laDate(epochMs) {
  const p = formatDateParts(epochMs);
  return `${p.year}-${p.month}-${p.day}`;
}

function isoFromEpoch(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString();
}

function groupPromptsBySession(history) {
  const grouped = new Map();
  for (const entry of history) {
    if (!entry || !entry.session_id || !entry.text) continue;
    const bucket = grouped.get(entry.session_id) || { count: 0, firstTs: null, lastTs: null, lastPrompt: "" };
    bucket.count += 1;
    if (bucket.firstTs == null || entry.ts < bucket.firstTs) bucket.firstTs = entry.ts;
    if (bucket.lastTs == null || entry.ts > bucket.lastTs) {
      bucket.lastTs = entry.ts;
      bucket.lastPrompt = entry.text;
    }
    grouped.set(entry.session_id, bucket);
  }
  return grouped;
}

function buildThreads(rawThreads, promptMap, homeDir) {
  return rawThreads.map((thread) => {
    const prompts = promptMap.get(thread.id) || { count: 0, lastPrompt: "" };
    return {
      id: thread.id,
      title: thread.title,
      cwd: thread.cwd,
      projectLabel: formatProjectLabel(thread.cwd, homeDir),
      shortProject: shortProjectName(thread.cwd),
      model: thread.model || "unknown",
      reasoningEffort: thread.reasoning_effort || "default",
      tokensUsed: thread.tokens_used || 0,
      promptCount: prompts.count,
      lastPrompt: prompts.lastPrompt,
      createdAt: isoFromEpoch(thread.created_at),
      updatedAt: isoFromEpoch(thread.updated_at),
      createdAtEpochMs: thread.created_at * 1000,
      updatedAtEpochMs: thread.updated_at * 1000,
    };
  });
}

function buildProjects(threads) {
  const projects = new Map();
  for (const thread of threads) {
    const bucket = projects.get(thread.cwd) || {
      cwd: thread.cwd,
      projectLabel: thread.projectLabel,
      shortProject: thread.shortProject,
      threadCount: 0,
      promptCount: 0,
      totalTokens: 0,
      lastUpdatedAt: thread.updatedAt,
      lastUpdatedAtEpochMs: thread.updatedAtEpochMs,
      models: new Set(),
    };
    bucket.threadCount += 1;
    bucket.promptCount += thread.promptCount;
    bucket.totalTokens += thread.tokensUsed;
    bucket.models.add(thread.model);
    if (thread.updatedAtEpochMs > bucket.lastUpdatedAtEpochMs) {
      bucket.lastUpdatedAt = thread.updatedAt;
      bucket.lastUpdatedAtEpochMs = thread.updatedAtEpochMs;
    }
    projects.set(thread.cwd, bucket);
  }
  return Array.from(projects.values())
    .map((project) => ({ ...project, models: Array.from(project.models).sort() }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.lastUpdatedAtEpochMs - a.lastUpdatedAtEpochMs);
}

function buildDailyActivity(threads, history) {
  const perDay = new Map();
  for (const thread of threads) {
    const date = laDate(thread.updatedAtEpochMs);
    const bucket = perDay.get(date) || { date, threads: 0, prompts: 0, tokens: 0 };
    bucket.threads += 1;
    bucket.tokens += thread.tokensUsed;
    perDay.set(date, bucket);
  }
  for (const prompt of history) {
    if (!prompt || !prompt.ts) continue;
    const date = laDate(prompt.ts * 1000);
    const bucket = perDay.get(date) || { date, threads: 0, prompts: 0, tokens: 0 };
    bucket.prompts += 1;
    perDay.set(date, bucket);
  }
  return Array.from(perDay.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function buildModelSummary(threads) {
  const models = new Map();
  for (const thread of threads) {
    const bucket = models.get(thread.model) || { model: thread.model, threads: 0, tokens: 0 };
    bucket.threads += 1;
    bucket.tokens += thread.tokensUsed;
    models.set(thread.model, bucket);
  }
  return Array.from(models.values()).sort((a, b) => b.tokens - a.tokens);
}

function buildOverview(threads, history, projects) {
  const totalTokens = threads.reduce((sum, thread) => sum + thread.tokensUsed, 0);
  const activeDays = new Set([
    ...threads.map((thread) => laDate(thread.updatedAtEpochMs)),
    ...history.filter((entry) => entry && entry.ts).map((entry) => laDate(entry.ts * 1000)),
  ]).size;
  return {
    threadCount: threads.length,
    projectCount: projects.length,
    promptCount: history.length,
    totalTokens,
    activeDays,
    avgTokensPerThread: threads.length ? Math.round(totalTokens / threads.length) : 0,
  };
}

function buildPromptFeed(history, threadsById, homeDir) {
  return history
    .filter((entry) => entry && entry.session_id && entry.text)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 200)
    .map((entry) => {
      const thread = threadsById.get(entry.session_id);
      return {
        sessionId: entry.session_id,
        text: entry.text,
        ts: new Date(entry.ts * 1000).toISOString(),
        title: thread ? thread.title : "Unknown thread",
        cwd: thread ? thread.cwd : null,
        projectLabel: thread ? formatProjectLabel(thread.cwd, homeDir) : "unknown",
      };
    });
}

function writeDataFile(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT, `window.TRACKER_DATA = ${JSON.stringify(data)};\n`);
}

function main() {
  const homeDir = os.homedir();
  const rawThreads = execSql(
    STATE_DB,
    "select id, title, cwd, model, reasoning_effort, tokens_used, created_at, updated_at from threads where archived = 0 order by updated_at desc"
  );
  const history = readJsonl(HISTORY_PATH);
  const promptMap = groupPromptsBySession(history);
  const threads = buildThreads(rawThreads, promptMap, homeDir);
  const projects = buildProjects(threads);
  const daily = buildDailyActivity(threads, history);
  const models = buildModelSummary(threads);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const data = {
    generatedAt: new Date().toISOString(),
    provider: "codex",
    overview: buildOverview(threads, history, projects),
    projects,
    threads: threads.slice(0, 500),
    recentPrompts: buildPromptFeed(history, threadsById, homeDir),
    daily,
    models,
  };
  writeDataFile(data);
  console.log(`[codex build] wrote ${OUTPUT} with ${threads.length} threads and ${history.length} prompts`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildDailyActivity,
  buildModelSummary,
  buildOverview,
  buildProjects,
  buildThreads,
  formatProjectLabel,
  groupPromptsBySession,
  laDate,
  shortProjectName,
};

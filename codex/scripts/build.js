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
const MENUBAR_JSON_PATH = path.join(os.homedir(), ".codex", "codex-tracker-menubar.json");
const OPENAI_CHAT_DIR = path.join(os.homedir(), "Library", "Application Support", "com.openai.chat");
const ACCURACY_LATEST_PATH = path.join(path.dirname(ROOT), "accuracy", "snapshots", "latest.json");
const ACCURACY_SNAPSHOTS_DIR = path.dirname(ACCURACY_LATEST_PATH);
const TIME_ZONE = "America/Los_Angeles";
const DAILY_CEILING_DAYS = 14;
const WEEKLY_SERIES_DAYS = 56;
const WEEKLY_CYCLE_DAYS = 7;
const FIVE_HOUR_WINDOW_SEC = 5 * 3600;
const RATE_LIMIT_CLOCK_SKEW_SEC = 5 * 60;
const OFFICIAL_USAGE_MAX_AGE_SEC = 2 * 3600;
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const MENUBAR_ONLY_FLAG = "--menubar-only";
const EXPENSIVE_MODEL_RE = /\b(opus|allpost)\b/i;
const MODEL_ALERT_RECENT_SEC = 2 * 3600;

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

function formatResetDetail(epochSeconds) {
  if (!Number.isInteger(epochSeconds)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(new Date(epochSeconds * 1000));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `resets ${values.month} ${values.day}, ${values.hour}:${values.minute} ${values.dayPeriod} ${values.timeZoneName}`;
}

function parseOfficialResetEpoch(text) {
  const match = String(text || "").match(/Resets\s+([A-Z][a-z]{2,8})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)/i);
  if (!match) return null;
  const months = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11,
  };
  const month = months[match[1].toLowerCase()];
  if (month == null) return null;
  let hour = Number(match[4]);
  if (match[6].toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (match[6].toUpperCase() === "AM" && hour === 12) hour = 0;
  const date = new Date(Number(match[3]), month, Number(match[2]), hour, Number(match[5]), 0);
  return Math.floor(date.getTime() / 1000);
}

function parseOfficialUsageBlock(text, heading) {
  const re = new RegExp(`${heading}\\s+([0-9]+)%\\s+(remaining|used)([\\s\\S]*?)(?=\\n\\s*(?:5 hour usage limit|Weekly usage limit|Credits remaining|Usage breakdown|Product activity)\\b|$)`, "i");
  const match = String(text || "").match(re);
  if (!match) return null;
  const pct = Number(match[1]);
  const direction = match[2].toLowerCase();
  const resetEpoch = parseOfficialResetEpoch(match[3]);
  return {
    pct,
    isRemaining: direction === "remaining",
    resetEpoch,
  };
}

function usedPctFromOfficial(block) {
  if (!block || typeof block.pct !== "number") return null;
  return block.isRemaining ? 100 - block.pct : block.pct;
}

function codexSnapshotCapturedAt(fileName) {
  const match = String(fileName || "").match(/^codex-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.txt$/);
  if (!match) return null;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function readOfficialUsageTextFile(fileName) {
  if (!fileName) return null;
  const capturedAt = codexSnapshotCapturedAt(fileName);
  if (!capturedAt) return null;
  let text = "";
  try {
    text = fs.readFileSync(path.join(ACCURACY_SNAPSHOTS_DIR, fileName), "utf8");
  } catch {
    return null;
  }
  const fiveHour = parseOfficialUsageBlock(text, "5 hour usage limit");
  const weekly = parseOfficialUsageBlock(text, "Weekly usage limit");
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly, capturedAt };
}

function readPreviousOfficialCodexUsage(currentTextFile, currentCapturedAt) {
  if (!currentTextFile || !currentCapturedAt) return null;
  const currentMs = Date.parse(currentCapturedAt);
  if (!Number.isFinite(currentMs)) return null;
  let files = [];
  try {
    files = fs.readdirSync(ACCURACY_SNAPSHOTS_DIR);
  } catch {
    return null;
  }
  return files
    .filter((fileName) => fileName !== currentTextFile && /^codex-.*\.txt$/.test(fileName))
    .map((fileName) => ({ fileName, capturedAt: codexSnapshotCapturedAt(fileName) }))
    .filter((entry) => entry.capturedAt && Date.parse(entry.capturedAt) < currentMs)
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
    .map((entry) => readOfficialUsageTextFile(entry.fileName))
    .find((usage) => usage?.fiveHour || usage?.weekly) || null;
}

function detectOfficialFiveHourReset(currentUsage, previousUsage) {
  const current = currentUsage?.fiveHour;
  const previous = previousUsage?.fiveHour;
  if (!current || !previous) return false;
  const currentUsed = usedPctFromOfficial(current);
  const previousUsed = usedPctFromOfficial(previous);
  if (currentUsed == null || previousUsed == null) return false;
  const currentCaptured = Date.parse(currentUsage.capturedAt || "");
  const previousCaptured = Date.parse(previousUsage.capturedAt || "");
  if (!Number.isFinite(currentCaptured) || !Number.isFinite(previousCaptured) || currentCaptured <= previousCaptured) return false;
  if (currentCaptured - previousCaptured > 24 * 3600 * 1000) return false;
  const usageDropped = previousUsed >= 10 && currentUsed <= Math.max(5, previousUsed - 25);
  const resetAdvanced = Number.isInteger(current.resetEpoch) &&
    Number.isInteger(previous.resetEpoch) &&
    current.resetEpoch > previous.resetEpoch + RATE_LIMIT_CLOCK_SKEW_SEC;
  return usageDropped || (resetAdvanced && currentUsed <= 10);
}

function detectOfficialWeeklyReset(currentUsage, previousUsage) {
  const current = currentUsage?.weekly;
  const previous = previousUsage?.weekly;
  if (!current || !previous) return false;
  const currentUsed = usedPctFromOfficial(current);
  const previousUsed = usedPctFromOfficial(previous);
  if (currentUsed == null || previousUsed == null) return false;
  const currentCaptured = Date.parse(currentUsage.capturedAt || "");
  const previousCaptured = Date.parse(previousUsage.capturedAt || "");
  if (!Number.isFinite(currentCaptured) || !Number.isFinite(previousCaptured) || currentCaptured <= previousCaptured) return false;
  const usageDropped = previousUsed >= 10 && currentUsed <= Math.max(5, previousUsed - 10);
  const resetAdvancedBeforeScheduledReset = Number.isInteger(current.resetEpoch) &&
    Number.isInteger(previous.resetEpoch) &&
    current.resetEpoch > previous.resetEpoch + RATE_LIMIT_CLOCK_SKEW_SEC &&
    currentCaptured < previous.resetEpoch * 1000;
  return usageDropped || resetAdvancedBeforeScheduledReset;
}

function readOfficialCodexUsage(options = {}) {
  if (options.officialUsage !== undefined) return options.officialUsage;
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAgeSec = options.officialUsageMaxAgeSec ?? OFFICIAL_USAGE_MAX_AGE_SEC;
  let latest;
  try {
    latest = JSON.parse(fs.readFileSync(ACCURACY_LATEST_PATH, "utf8"));
  } catch {
    return null;
  }
  const codex = latest?.providers?.codex;
  if (!codex || codex.loginWall || codex.error || !codex.textFile || !codex.capturedAt) return null;
  const capturedSec = Math.floor(Date.parse(codex.capturedAt) / 1000);
  if (!Number.isFinite(capturedSec) || nowSec - capturedSec > maxAgeSec) return null;
  let text = "";
  try {
    text = fs.readFileSync(path.join(ACCURACY_SNAPSHOTS_DIR, codex.textFile), "utf8");
  } catch {
    return null;
  }
  const fiveHour = parseOfficialUsageBlock(text, "5 hour usage limit");
  const weekly = parseOfficialUsageBlock(text, "Weekly usage limit");
  if (!fiveHour && !weekly) return null;
  const usage = { fiveHour, weekly, capturedAt: codex.capturedAt };
  const previousUsage = options.previousOfficialUsage === undefined
    ? readPreviousOfficialCodexUsage(codex.textFile, codex.capturedAt)
    : options.previousOfficialUsage;
  usage.fiveHourResetDetected = detectOfficialFiveHourReset(usage, previousUsage);
  usage.weeklyResetDetected = detectOfficialWeeklyReset(usage, previousUsage);
  return usage;
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
      rolloutPath: thread.rollout_path || null,
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

function readChatGPTDesktopActivity(baseDir = OPENAI_CHAT_DIR) {
  const empty = {
    workspaceCount: 0,
    blobCount: 0,
    lastActivityAt: null,
    lastActivityAtEpochMs: null,
    workspaces: [],
    daily: [],
  };
  if (!fs.existsSync(baseDir)) return empty;

  const workspaces = [];
  const daily = new Map();
  let blobCount = 0;
  let lastActivityAtEpochMs = null;

  const stack = [baseDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^conversations-v3-/.test(entry.name)) {
          let fileCount = 0;
          let workspaceLastActivityAtEpochMs = null;
          try {
            for (const item of fs.readdirSync(fullPath, { withFileTypes: true })) {
              if (!item.isFile() || !item.name.endsWith(".data")) continue;
              const itemPath = path.join(fullPath, item.name);
              const stat = fs.statSync(itemPath);
              fileCount += 1;
              blobCount += 1;
              const mtime = stat.mtimeMs;
              const date = laDate(mtime);
              daily.set(date, (daily.get(date) || 0) + 1);
              if (workspaceLastActivityAtEpochMs == null || mtime > workspaceLastActivityAtEpochMs) {
                workspaceLastActivityAtEpochMs = mtime;
              }
              if (lastActivityAtEpochMs == null || mtime > lastActivityAtEpochMs) {
                lastActivityAtEpochMs = mtime;
              }
            }
          } catch {
            continue;
          }

          workspaces.push({
            workspaceId: entry.name.replace(/^conversations-v3-/, ""),
            fileCount,
            lastActivityAt: workspaceLastActivityAtEpochMs ? new Date(workspaceLastActivityAtEpochMs).toISOString() : null,
            lastActivityAtEpochMs: workspaceLastActivityAtEpochMs,
          });
          continue;
        }
        stack.push(fullPath);
      }
    }
  }

  workspaces.sort((a, b) => (b.lastActivityAtEpochMs || 0) - (a.lastActivityAtEpochMs || 0) || b.fileCount - a.fileCount || a.workspaceId.localeCompare(b.workspaceId));
  const dailyActivity = Array.from(daily.entries())
    .map(([date, blobs]) => ({ date, blobs }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    workspaceCount: workspaces.length,
    blobCount,
    lastActivityAt: lastActivityAtEpochMs ? new Date(lastActivityAtEpochMs).toISOString() : null,
    lastActivityAtEpochMs,
    workspaces,
    daily: dailyActivity,
  };
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

function buildModelAlert(threads, options = {}) {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const recentSec = options.modelAlertRecentSec ?? MODEL_ALERT_RECENT_SEC;
  const expensive = (threads || [])
    .filter((thread) => EXPENSIVE_MODEL_RE.test(thread.model || ""))
    .sort((a, b) => (b.updatedAtEpochMs || 0) - (a.updatedAtEpochMs || 0));
  const latest = expensive[0];
  if (!latest) return null;
  const ageSec = Math.max(0, nowSec - Math.floor((latest.updatedAtEpochMs || 0) / 1000));
  if (ageSec > recentSec) return null;
  return {
    active: true,
    model: latest.model,
    project: latest.shortProject || latest.projectLabel || latest.cwd || "unknown",
    updatedAt: latest.updatedAt || null,
    detail: `Codex expensive model: ${latest.model} in ${latest.shortProject || latest.projectLabel || "unknown"}`,
  };
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
    desktopWorkspaceCount: 0,
    desktopBlobCount: 0,
    desktopLastActivityAt: null,
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

function compactNumber(value) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function dateOnlyDiffDays(startDateStr, endDateStr) {
  const start = new Date(startDateStr + "T12:00:00Z");
  const end = new Date(endDateStr + "T12:00:00Z");
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function shiftDateStr(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function buildWeeklyCycle(todayDateStr, resetEpoch) {
  if (!Number.isInteger(resetEpoch)) return null;
  const resetDate = new Date(resetEpoch * 1000);
  const resetDateStr = laDate(resetDate.getTime());
  const includesResetDate =
    resetDate.getHours() !== 0 ||
    resetDate.getMinutes() !== 0 ||
    resetDate.getSeconds() !== 0;
  const cycleEndDateStr = includesResetDate ? resetDateStr : shiftDateStr(resetDateStr, -1);
  const cycleStartDateStr = shiftDateStr(cycleEndDateStr, -(WEEKLY_CYCLE_DAYS - 1));
  const activeDots = Math.min(
    WEEKLY_CYCLE_DAYS,
    Math.max(1, dateOnlyDiffDays(cycleStartDateStr, todayDateStr) + 1)
  );
  return {
    totalDots: WEEKLY_CYCLE_DAYS,
    activeDots,
    resetEpoch,
  };
}

function latestRolloutPath() {
  let newestPath = null;
  let newestMtime = -1;

  if (fs.existsSync(CODEX_SESSIONS_DIR)) {
    const stack = [CODEX_SESSIONS_DIR];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!/^rollout-.*\.jsonl$/.test(entry.name)) continue;
        const mtime = fs.statSync(fullPath).mtimeMs;
        if (mtime > newestMtime) {
          newestMtime = mtime;
          newestPath = fullPath;
        }
      }
    }
  }

  if (fs.existsSync(STATE_DB)) {
    try {
      const rows = execSql(
        STATE_DB,
        "select coalesce(rollout_path, '') as rollout_path from threads order by updated_at_ms desc, updated_at desc limit 1"
      );
      const rollout = rows[0] && rows[0].rollout_path;
      if (rollout && fs.existsSync(rollout)) {
        const rolloutMtime = fs.statSync(rollout).mtimeMs;
        if (rolloutMtime >= newestMtime) return rollout;
      }
    } catch {}
  }
  return newestPath;
}

function readLatestRateLimits() {
  const rolloutPath = latestRolloutPath();
  if (!rolloutPath) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const lines = fs.readFileSync(rolloutPath, "utf8").split("\n").filter(Boolean);
  // Track the most recent 5h and weekly limits independently. Codex sometimes
  // returns the weekly 10080-minute limit under `primary`, so position alone is
  // not reliable.
  let bestFiveHour = null;
  let bestWeekly = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
      const rl = entry.payload?.rate_limits;
      if (!rl) continue;
      for (const [slot, limit] of [["primary", rl.primary], ["secondary", rl.secondary]]) {
        if (!limit || !Number.isInteger(limit.resets_at) || limit.resets_at <= nowSec) continue;
        if (limit.window_minutes === 300 || (limit.window_minutes == null && slot === "primary")) {
          bestFiveHour = limit;
        } else if (limit.window_minutes === 10080 || (limit.window_minutes == null && slot === "secondary")) {
          bestWeekly = limit;
        }
      }
    } catch {}
  }
  if (!bestFiveHour && !bestWeekly) return null;
  return { primary: bestFiveHour, secondary: bestWeekly };
}

function normalizeCodexRateLimits(rateLimits) {
  if (!rateLimits) return null;
  let fiveHour = null;
  let weekly = null;
  for (const [slot, limit] of [["primary", rateLimits.primary], ["secondary", rateLimits.secondary]]) {
    if (!limit) continue;
    if (limit.window_minutes === 300 || (limit.window_minutes == null && slot === "primary")) {
      fiveHour = limit;
    } else if (limit.window_minutes === 10080 || (limit.window_minutes == null && slot === "secondary")) {
      weekly = limit;
    }
  }
  return { primary: fiveHour, secondary: weekly };
}

function buildRecentDailySeries(daily, days, nowMs = Date.now()) {
  const perDay = new Map(daily.map((entry) => [entry.date, entry]));
  const series = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(nowMs - offset * 24 * 60 * 60 * 1000);
    const key = laDate(date.getTime());
    const bucket = perDay.get(key) || { date: key, threads: 0, prompts: 0, tokens: 0 };
    series.push(bucket);
  }
  return series;
}

function rollingSums(series, size, field) {
  const sums = [];
  for (let start = 0; start + size <= series.length; start += 1) {
    let total = 0;
    for (let i = start; i < start + size; i += 1) total += series[i][field] || 0;
    sums.push(total);
  }
  return sums;
}

function readLocalTokenEvents(threads, nowSec) {
  if (!Array.isArray(threads) || threads.length === 0) return [];
  const nowMs = nowSec * 1000;
  const windowMs = FIVE_HOUR_WINDOW_SEC * 1000;
  const cutoffMs = nowMs - 14 * 24 * 60 * 60 * 1000;
  const paths = Array.from(new Set(threads.map((thread) => thread.rolloutPath).filter(Boolean)));
  const events = [];
  for (const rolloutPath of paths) {
    if (!fs.existsSync(rolloutPath)) continue;
    let stat;
    try {
      stat = fs.statSync(rolloutPath);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoffMs - windowMs) continue;
    for (const line of fs.readFileSync(rolloutPath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
        const ts = Date.parse(entry.timestamp);
        if (!Number.isFinite(ts) || ts < cutoffMs || ts > nowMs) continue;
        const tokens = entry.payload?.info?.last_token_usage?.total_tokens;
        if (typeof tokens !== "number" || tokens <= 0) continue;
        const rl = entry.payload?.rate_limits;
        let fiveHourLimit = null;
        for (const limit of [rl?.primary, rl?.secondary]) {
          if (limit?.window_minutes === 300 && typeof limit.used_percent === "number" && Number.isInteger(limit.resets_at)) {
            fiveHourLimit = limit;
          }
        }
        events.push({ ts, tokens, fiveHourLimit });
      } catch {}
    }
  }
  return events;
}

function sumTokenEvents(events, startMs, endMs) {
  return events.reduce((sum, event) => {
    if (event.ts < startMs || event.ts > endMs) return sum;
    return sum + event.tokens;
  }, 0);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calibratedFiveHourCeiling(events) {
  const ceilings = [];
  for (const event of events) {
    const limit = event.fiveHourLimit;
    if (!limit || limit.used_percent <= 0 || limit.used_percent > 100) continue;
    const windowStartMs = (limit.resets_at - FIVE_HOUR_WINDOW_SEC) * 1000;
    const usageAtSample = sumTokenEvents(events, windowStartMs, event.ts);
    if (usageAtSample <= 0) continue;
    ceilings.push(usageAtSample / (limit.used_percent / 100));
  }
  return median(ceilings);
}

function buildLocalFiveHourEstimate(threads, nowSec, windowStartSec = null, windowEndSec = null) {
  const events = readLocalTokenEvents(threads, nowSec);
  if (events.length === 0) return null;
  const nowMs = nowSec * 1000;
  const windowMs = FIVE_HOUR_WINDOW_SEC * 1000;
  const windowCount = Math.ceil((14 * 24 * 60 * 60) / FIVE_HOUR_WINDOW_SEC);
  const currentStartMs = Number.isInteger(windowStartSec) ? windowStartSec * 1000 : nowMs - windowMs;
  const currentEndMs = Number.isInteger(windowEndSec) ? Math.min(windowEndSec * 1000, nowMs) : nowMs;
  const currentUsage = sumTokenEvents(events, currentStartMs, currentEndMs);
  if (currentUsage <= 0) return null;

  const historicalUsages = [];
  for (let idx = 1; idx <= windowCount; idx += 1) {
    const startMs = currentStartMs - idx * windowMs;
    const endMs = currentEndMs - idx * windowMs;
    const usage = sumTokenEvents(events, startMs, endMs);
    if (usage > 0) historicalUsages.push(usage);
  }

  if (historicalUsages.length === 0) return null;
  const calibratedCeiling = calibratedFiveHourCeiling(events);
  const baseCeiling = Math.max(1, calibratedCeiling ?? Math.max(...historicalUsages));
  const ceiling = Math.max(baseCeiling, currentUsage / 0.95);
  return {
    usage: currentUsage,
    ceiling,
    pct: Math.min(currentUsage / ceiling, 0.95),
  };
}

function readFiveHourResetAnchor(threads, nowSec) {
  if (!Array.isArray(threads) || threads.length === 0) return null;
  const paths = Array.from(new Set(threads.map((thread) => thread.rolloutPath).filter(Boolean)));
  let anchor = null;
  for (const rolloutPath of paths) {
    if (!fs.existsSync(rolloutPath)) continue;
    for (const line of fs.readFileSync(rolloutPath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
        const rl = entry.payload?.rate_limits;
        if (!rl) continue;
        for (const limit of [rl.primary, rl.secondary]) {
          if (!limit || limit.window_minutes !== 300 || !Number.isInteger(limit.resets_at)) continue;
          if (limit.resets_at > nowSec + FIVE_HOUR_WINDOW_SEC + RATE_LIMIT_CLOCK_SKEW_SEC) continue;
          if (anchor == null || limit.resets_at > anchor) anchor = limit.resets_at;
        }
      } catch {}
    }
  }
  return anchor;
}

// Codex has no per-turn dollar-cost ledger like Claude's — token_count
// events (from readLocalTokenEvents) are the closest equivalent timeline,
// so hourly "pace" here is token volume, not cost. maxedHours is inferred
// from the primary (5h) rate-limit snapshot attached to each event hitting
// ~100%, since Codex doesn't emit a distinct rate-limit-hit record the way
// Claude does. Only returns data when a real (official) weekly reset epoch
// is known, mirroring buildWeeklyCycle's own gating.
function buildWeeklySpark(threads, weeklyResetEpochSec, nowSec) {
  if (!Number.isInteger(weeklyResetEpochSec)) return null;
  const events = readLocalTokenEvents(threads, nowSec);
  if (!events.length) return null;

  const HOUR_MS = 60 * 60 * 1000;
  const windowEndMs = weeklyResetEpochSec * 1000;
  const windowStartMs = Math.floor((windowEndMs - 7 * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS;
  const nowMs = nowSec * 1000;

  const hourlyTokens = {};
  for (const event of events) {
    if (event.ts < windowStartMs || event.ts >= nowMs) continue;
    const hourEpoch = Math.floor(event.ts / HOUR_MS) * HOUR_MS;
    hourlyTokens[hourEpoch] = (hourlyTokens[hourEpoch] || 0) + event.tokens;
  }
  const hourly = [];
  for (let t = windowStartMs; t < windowEndMs && t < nowMs; t += HOUR_MS) {
    hourly.push({ epoch: Math.floor(t / 1000), cost: hourlyTokens[t] || 0 });
  }

  const maxedHours = [...new Set(
    events
      .filter((event) => event.ts >= windowStartMs && event.ts < nowMs && (event.fiveHourLimit?.used_percent ?? 0) >= 99)
      .map((event) => Math.floor((Math.floor(event.ts / HOUR_MS) * HOUR_MS) / 1000))
  )];

  return {
    windowStartEpoch: Math.floor(windowStartMs / 1000),
    windowEndEpoch: weeklyResetEpochSec,
    hourly,
    maxedHours,
  };
}

function buildMenubarData(daily, options = {}) {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const dailySeries = buildRecentDailySeries(daily, WEEKLY_SERIES_DAYS, nowSec * 1000);
  const last14 = dailySeries.slice(-DAILY_CEILING_DAYS);
  const today = dailySeries[dailySeries.length - 1] || { tokens: 0, prompts: 0 };
  const todayDate = today.date || laDate(nowSec * 1000);
  const officialUsage = readOfficialCodexUsage({ ...options, nowSec });
  const rawRateLimits = options.rateLimits === undefined ? readLatestRateLimits() : options.rateLimits;
  const rateLimits = normalizeCodexRateLimits(rawRateLimits);
  const todayUsage = today.tokens || 0;
  const todayPromptCount = today.prompts || 0;
  const dailyCeiling = Math.max(1, ...last14.map((entry) => entry.tokens || 0));
  const weeklyUsage = dailySeries.slice(-7).reduce((sum, entry) => sum + (entry.tokens || 0), 0);
  const weeklyPromptCount = dailySeries.slice(-7).reduce((sum, entry) => sum + (entry.prompts || 0), 0);
  const weeklyCeiling = Math.max(1, ...rollingSums(dailySeries, 7, "tokens"));
  const primaryUsedPercent = rateLimits?.primary?.used_percent;
  const secondaryUsedPercent = rateLimits?.secondary?.used_percent;
  const officialFiveHourPct = officialUsage?.fiveHour?.pct;
  const officialWeeklyPct = officialUsage?.weekly?.pct;
  const primaryResetFresh =
    Number.isInteger(rateLimits?.primary?.resets_at) &&
    rateLimits.primary.resets_at > nowSec &&
    rateLimits.primary.resets_at <= nowSec + FIVE_HOUR_WINDOW_SEC + RATE_LIMIT_CLOCK_SKEW_SEC;
  const secondaryResetFresh = Number.isInteger(rateLimits?.secondary?.resets_at) && rateLimits.secondary.resets_at > nowSec;
  const hasOfficialFiveHourUsage = typeof officialFiveHourPct === "number";
  const hasOfficialWeeklyUsage = typeof officialWeeklyPct === "number";
  const officialFiveHourResetDetected = hasOfficialFiveHourUsage && officialUsage?.fiveHourResetDetected === true;
  const officialWeeklyResetDetected = hasOfficialWeeklyUsage && officialUsage?.weeklyResetDetected === true;
  const officialResetFloorSec = !hasOfficialFiveHourUsage && officialWeeklyResetDetected && officialUsage?.capturedAt
    ? Math.floor(Date.parse(officialUsage.capturedAt) / 1000)
    : null;
  const hasPrimaryRateLimit = !hasOfficialFiveHourUsage && typeof primaryUsedPercent === "number" && primaryResetFresh;
  const hasSecondaryRateLimit = !hasOfficialWeeklyUsage && typeof secondaryUsedPercent === "number" && secondaryResetFresh;
  const hasOfficialRateLimit = rateLimits?.primary || rateLimits?.secondary;
  // Carry-forward: when today has no activity yet (e.g. just past midnight), show the most
  // recent active day so the bars don't reset to empty before the user opens Codex.
  const carryEntry = !hasPrimaryRateLimit && todayUsage === 0
    ? (dailySeries.slice(0, -1).reverse().find((d) => (d.tokens || 0) > 0) ?? null)
    : null;
  const displayDayUsage   = carryEntry ? (carryEntry.tokens  || 0) : todayUsage;
  const displayDayPrompts = carryEntry ? (carryEntry.prompts || 0) : todayPromptCount;
  const primaryLabelFallback = carryEntry
    ? (carryEntry.date === shiftDateStr(todayDate, -1) ? "Yesterday" : "Recent")
    : "Today";
  const primaryPct = hasPrimaryRateLimit ? Math.max(0, Math.min(1, primaryUsedPercent / 100)) : null;
  const secondaryPct = hasOfficialWeeklyUsage
    ? Math.max(0, Math.min(1, officialWeeklyPct / 100))
    : hasSecondaryRateLimit
      ? Math.max(0, Math.min(1, secondaryUsedPercent / 100))
      : Math.min(weeklyUsage / weeklyCeiling, 1);

  // Always compute a projected 5h window for the time-progress bar.
  // If the last known reset is still in the future, use it directly.
  // If it has expired, roll it forward by however many 5h intervals have elapsed.
  const fallbackFiveHourReset = Number.isInteger(options.fiveHourResetAnchor)
    ? options.fiveHourResetAnchor
    : readFiveHourResetAnchor(options.threads, nowSec);
  const lastPrimaryReset = Number.isInteger(rateLimits?.primary?.resets_at)
    ? rateLimits.primary.resets_at
    : fallbackFiveHourReset;
  let projectedWindowStart = null;
  let projectedWindowEnd = null;
  if (lastPrimaryReset !== null) {
    if (lastPrimaryReset > nowSec && lastPrimaryReset <= nowSec + FIVE_HOUR_WINDOW_SEC + RATE_LIMIT_CLOCK_SKEW_SEC) {
      projectedWindowStart = lastPrimaryReset - FIVE_HOUR_WINDOW_SEC;
      projectedWindowEnd = lastPrimaryReset;
    } else if (lastPrimaryReset <= nowSec) {
      const windowsElapsed = Math.floor((nowSec - lastPrimaryReset) / FIVE_HOUR_WINDOW_SEC) + 1;
      projectedWindowEnd = lastPrimaryReset + windowsElapsed * FIVE_HOUR_WINDOW_SEC;
      projectedWindowStart = projectedWindowEnd - FIVE_HOUR_WINDOW_SEC;
    }
  }
  if (hasOfficialFiveHourUsage && Number.isInteger(officialUsage?.fiveHour?.resetEpoch)) {
    projectedWindowEnd = officialUsage.fiveHour.resetEpoch;
    projectedWindowStart = projectedWindowEnd - FIVE_HOUR_WINDOW_SEC;
  }

  const hasLocalPrimaryUsage = displayDayUsage > 0 || displayDayPrompts > 0;
  const effectiveWindowStart = Number.isInteger(officialResetFloorSec) && projectedWindowStart !== null
    ? Math.max(projectedWindowStart, officialResetFloorSec)
    : projectedWindowStart;
  const localFiveHour = buildLocalFiveHourEstimate(options.threads, nowSec, effectiveWindowStart, projectedWindowEnd);
  const hasProjectedFiveHourWindow = projectedWindowEnd !== null;
  const localFallbackPct = localFiveHour?.pct ?? (hasProjectedFiveHourWindow ? 0 : null);
  const localFallbackUsage = localFiveHour?.usage ?? (hasProjectedFiveHourWindow ? 0 : displayDayUsage);
  const localFallbackCeiling = localFiveHour?.ceiling ?? (hasProjectedFiveHourWindow ? 100 : null);
  const officialFiveHourFraction = hasOfficialFiveHourUsage ? Math.max(0, Math.min(1, officialFiveHourPct / 100)) : null;
  const primaryMetric = hasOfficialFiveHourUsage || hasPrimaryRateLimit || projectedWindowEnd !== null || hasLocalPrimaryUsage || !hasOfficialRateLimit ? {
    usage: hasOfficialFiveHourUsage
      ? Math.round(officialFiveHourPct)
      : hasPrimaryRateLimit
        ? Math.round(primaryPct * 100)
        : localFallbackUsage,
    ceiling: hasOfficialFiveHourUsage || hasPrimaryRateLimit ? 100 : localFallbackCeiling,
    pct: hasOfficialFiveHourUsage ? officialFiveHourFraction : hasPrimaryRateLimit ? primaryPct : localFallbackPct,
    usageDisplay: hasOfficialFiveHourUsage
      ? `${Math.round(officialFiveHourPct)}% ${officialUsage.fiveHour.isRemaining ? "remaining" : "used"}`
      : hasPrimaryRateLimit
      ? `${Math.round(primaryPct * 100)}% used`
      : localFallbackPct != null
        ? `${Math.round(localFallbackPct * 100)}% est.`
        : `${compactNumber(displayDayUsage)} tok`,
    ceilingDisplay: hasOfficialFiveHourUsage || hasPrimaryRateLimit || localFallbackCeiling == null ? null : `${compactNumber(localFallbackCeiling)} tok est.`,
    detail: officialFiveHourResetDetected || officialWeeklyResetDetected
      ? "usage reset detected"
      : hasOfficialFiveHourUsage && Number.isInteger(officialUsage.fiveHour.resetEpoch)
      ? formatResetDetail(officialUsage.fiveHour.resetEpoch)
      : hasPrimaryRateLimit
      ? formatResetDetail(rateLimits?.primary?.resets_at)
      : carryEntry !== null
        ? `${displayDayPrompts} prompts (${carryEntry.date})`
        : projectedWindowEnd !== null
          ? formatResetDetail(projectedWindowEnd)
          : localFallbackPct != null
            ? "estimated from local 5h activity"
            : `${displayDayPrompts} prompts`,
    startEpoch: effectiveWindowStart,
    endEpoch: projectedWindowEnd,
    isRemaining: hasOfficialFiveHourUsage ? officialUsage.fiveHour.isRemaining : false,
    resetDetected: officialFiveHourResetDetected || officialWeeklyResetDetected,
  } : null;

  const weeklyResetEpoch = Number.isInteger(officialUsage?.weekly?.resetEpoch)
    ? officialUsage.weekly.resetEpoch
    : Number.isInteger(rateLimits?.secondary?.resets_at) && rateLimits.secondary.resets_at > nowSec
      ? rateLimits.secondary.resets_at
      : null;
  const weeklySpark = buildWeeklySpark(options.threads, weeklyResetEpoch, nowSec);

  return {
    updatedAt: new Date().toISOString(),
    title: "Codex",
    reportPath: path.resolve(ROOT, "report.html"),
    primaryLabel: hasOfficialFiveHourUsage || hasPrimaryRateLimit || projectedWindowEnd !== null || localFallbackPct != null ? "5h used" : primaryLabelFallback,
    secondaryLabel: hasOfficialWeeklyUsage || hasSecondaryRateLimit ? "Week used" : "7 Days",
    primary: primaryMetric,
    secondary: {
      usage: hasOfficialWeeklyUsage ? Math.round(officialWeeklyPct) : hasSecondaryRateLimit ? Math.round(secondaryPct * 100) : weeklyUsage,
      ceiling: hasOfficialWeeklyUsage || hasSecondaryRateLimit ? 100 : weeklyCeiling,
      pct: secondaryPct,
      usageDisplay: hasOfficialWeeklyUsage
        ? `${Math.round(officialWeeklyPct)}% ${officialUsage.weekly.isRemaining ? "remaining" : "used"}`
        : hasSecondaryRateLimit
          ? `${Math.round(secondaryPct * 100)}% used`
          : `${compactNumber(weeklyUsage)} tok`,
      ceilingDisplay: hasOfficialWeeklyUsage || hasSecondaryRateLimit ? null : `${compactNumber(weeklyCeiling)} tok`,
      detail: hasOfficialWeeklyUsage && Number.isInteger(officialUsage?.weekly?.resetEpoch)
        ? formatResetDetail(officialUsage.weekly.resetEpoch)
        : hasSecondaryRateLimit
          ? formatResetDetail(rateLimits?.secondary?.resets_at)
          : `${weeklyPromptCount} prompts`,
      endEpoch: Number.isInteger(officialUsage?.weekly?.resetEpoch)
        ? officialUsage.weekly.resetEpoch
        : Number.isInteger(rateLimits?.secondary?.resets_at) && rateLimits.secondary.resets_at > nowSec ? rateLimits.secondary.resets_at : null,
      isRemaining: hasOfficialWeeklyUsage ? officialUsage.weekly.isRemaining : false,
    },
    weeklyCycle: buildWeeklyCycle(todayDate, Number.isInteger(officialUsage?.weekly?.resetEpoch) ? officialUsage.weekly.resetEpoch : rateLimits?.secondary?.resets_at),
    weeklySpark,
    modelAlert: buildModelAlert(options.threads || [], { nowSec, modelAlertRecentSec: options.modelAlertRecentSec }),
  };
}

function writeMenubarJson(data) {
  try {
    fs.writeFileSync(MENUBAR_JSON_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.warn("[codex build] could not write menubar json:", error.message);
  }
}

function writeDataFile(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT, `window.TRACKER_DATA = ${JSON.stringify(data)};\n`);
}

function loadTrackerData() {
  const homeDir = os.homedir();
  const rawThreads = execSql(
    STATE_DB,
    "select id, title, cwd, model, reasoning_effort, tokens_used, created_at, updated_at, rollout_path from threads where archived = 0 order by updated_at desc"
  );
  const history = readJsonl(HISTORY_PATH);
  const promptMap = groupPromptsBySession(history);
  const desktop = readChatGPTDesktopActivity();
  const threads = buildThreads(rawThreads, promptMap, homeDir);
  const projects = buildProjects(threads);
  const daily = buildDailyActivity(threads, history);
  const models = buildModelSummary(threads);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const overview = buildOverview(threads, history, projects);
  overview.desktopWorkspaceCount = desktop.workspaceCount;
  overview.desktopBlobCount = desktop.blobCount;
  overview.desktopLastActivityAt = desktop.lastActivityAt;
  const data = {
    generatedAt: new Date().toISOString(),
    provider: "codex",
    overview,
    desktop,
    projects,
    threads: threads.slice(0, 500),
    recentPrompts: buildPromptFeed(history, threadsById, homeDir),
    daily,
    models,
  };
  return { data, daily, history, threads };
}

function main(argv = process.argv.slice(2)) {
  const menubarOnly = argv.includes(MENUBAR_ONLY_FLAG);
  const { data, daily, history, threads } = loadTrackerData();
  if (!menubarOnly) writeDataFile(data);
  writeMenubarJson(buildMenubarData(daily, { threads }));
  const target = menubarOnly ? MENUBAR_JSON_PATH : OUTPUT;
  console.log(`[codex build] wrote ${target} with ${threads.length} threads and ${history.length} prompts`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildDailyActivity,
  buildMenubarData,
  buildModelAlert,
  buildModelSummary,
  buildOverview,
  buildProjects,
  buildThreads,
  detectOfficialFiveHourReset,
  detectOfficialWeeklyReset,
  formatProjectLabel,
  groupPromptsBySession,
  laDate,
  loadTrackerData,
  readChatGPTDesktopActivity,
  shortProjectName,
};

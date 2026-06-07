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
const TIME_ZONE = "America/Los_Angeles";
const DAILY_CEILING_DAYS = 14;
const WEEKLY_SERIES_DAYS = 56;
const WEEKLY_CYCLE_DAYS = 7;
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
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
  // Track the most recent non-null primary/secondary with a future resets_at independently.
  // When the window limit is hit, OpenAI switches to a different limit_id (e.g. "premium")
  // that returns primary: null — if we just took the last event we'd lose the rate limit signal.
  let bestPrimary = null;
  let bestSecondary = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
      const rl = entry.payload?.rate_limits;
      if (!rl) continue;
      if (rl.primary && Number.isInteger(rl.primary.resets_at) && rl.primary.resets_at > nowSec) {
        bestPrimary = rl.primary;
      }
      if (rl.secondary && Number.isInteger(rl.secondary.resets_at) && rl.secondary.resets_at > nowSec) {
        bestSecondary = rl.secondary;
      }
    } catch {}
  }
  if (!bestPrimary && !bestSecondary) return null;
  return { primary: bestPrimary, secondary: bestSecondary };
}

function buildRecentDailySeries(daily, days) {
  const perDay = new Map(daily.map((entry) => [entry.date, entry]));
  const series = [];
  const now = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
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

function buildMenubarData(daily, options = {}) {
  const dailySeries = buildRecentDailySeries(daily, WEEKLY_SERIES_DAYS);
  const last14 = dailySeries.slice(-DAILY_CEILING_DAYS);
  const today = dailySeries[dailySeries.length - 1] || { tokens: 0, prompts: 0 };
  const todayDate = today.date || laDate(Date.now());
  const rateLimits = options.rateLimits === undefined ? readLatestRateLimits() : options.rateLimits;
  const todayUsage = today.tokens || 0;
  const todayPromptCount = today.prompts || 0;
  const dailyCeiling = Math.max(1, ...last14.map((entry) => entry.tokens || 0));
  const weeklyUsage = dailySeries.slice(-7).reduce((sum, entry) => sum + (entry.tokens || 0), 0);
  const weeklyPromptCount = dailySeries.slice(-7).reduce((sum, entry) => sum + (entry.prompts || 0), 0);
  const weeklyCeiling = Math.max(1, ...rollingSums(dailySeries, 7, "tokens"));
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const primaryUsedPercent = rateLimits?.primary?.used_percent;
  const secondaryUsedPercent = rateLimits?.secondary?.used_percent;
  const primaryResetFresh = Number.isInteger(rateLimits?.primary?.resets_at) && rateLimits.primary.resets_at > nowSec;
  const secondaryResetFresh = Number.isInteger(rateLimits?.secondary?.resets_at) && rateLimits.secondary.resets_at > nowSec;
  const hasPrimaryRateLimit = typeof primaryUsedPercent === "number" && primaryResetFresh;
  const hasSecondaryRateLimit = typeof secondaryUsedPercent === "number" && secondaryResetFresh;
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
  const primaryRemainingPct = hasPrimaryRateLimit ? Math.max(0, Math.min(1, 1 - primaryUsedPercent / 100)) : Math.min(displayDayUsage / dailyCeiling, 1);
  const secondaryRemainingPct = hasSecondaryRateLimit ? Math.max(0, Math.min(1, 1 - secondaryUsedPercent / 100)) : Math.min(weeklyUsage / weeklyCeiling, 1);

  // Always compute a projected 5h window for the time-progress bar.
  // If the last known reset is still in the future, use it directly.
  // If it has expired, roll it forward by however many 5h intervals have elapsed.
  const WINDOW_SEC = 5 * 3600;
  const lastPrimaryReset = Number.isInteger(rateLimits?.primary?.resets_at) ? rateLimits.primary.resets_at : null;
  let projectedWindowStart = null;
  let projectedWindowEnd = null;
  if (lastPrimaryReset !== null) {
    if (lastPrimaryReset > nowSec) {
      projectedWindowStart = lastPrimaryReset - WINDOW_SEC;
      projectedWindowEnd = lastPrimaryReset;
    } else {
      const windowsElapsed = Math.floor((nowSec - lastPrimaryReset) / WINDOW_SEC) + 1;
      projectedWindowEnd = lastPrimaryReset + windowsElapsed * WINDOW_SEC;
      projectedWindowStart = projectedWindowEnd - WINDOW_SEC;
    }
  }

  return {
    updatedAt: new Date().toISOString(),
    title: "Codex",
    reportPath: path.resolve(ROOT, "report.html"),
    primaryLabel: hasPrimaryRateLimit ? "5h left" : primaryLabelFallback,
    secondaryLabel: hasSecondaryRateLimit ? "Week left" : "7 Days",
    primary: {
      usage: hasPrimaryRateLimit ? Math.round(primaryRemainingPct * 100) : displayDayUsage,
      ceiling: hasPrimaryRateLimit ? 100 : dailyCeiling,
      pct: primaryRemainingPct,
      usageDisplay: hasPrimaryRateLimit ? `${Math.round(primaryRemainingPct * 100)}% left` : `${compactNumber(displayDayUsage)} tok`,
      ceilingDisplay: hasPrimaryRateLimit ? null : `${compactNumber(dailyCeiling)} tok`,
      detail: hasPrimaryRateLimit
        ? formatResetDetail(rateLimits?.primary?.resets_at)
        : carryEntry !== null
          ? `${displayDayPrompts} prompts (${carryEntry.date})`
          : projectedWindowEnd !== null
            ? formatResetDetail(projectedWindowEnd)
            : `${displayDayPrompts} prompts`,
      startEpoch: projectedWindowStart,
      endEpoch: projectedWindowEnd,
      isRemaining: hasPrimaryRateLimit || null,
    },
    secondary: {
      usage: hasSecondaryRateLimit ? Math.round(secondaryRemainingPct * 100) : weeklyUsage,
      ceiling: hasSecondaryRateLimit ? 100 : weeklyCeiling,
      pct: secondaryRemainingPct,
      usageDisplay: hasSecondaryRateLimit ? `${Math.round(secondaryRemainingPct * 100)}% left` : `${compactNumber(weeklyUsage)} tok`,
      ceilingDisplay: hasSecondaryRateLimit ? null : `${compactNumber(weeklyCeiling)} tok`,
      detail: hasSecondaryRateLimit ? formatResetDetail(rateLimits?.secondary?.resets_at) : `${weeklyPromptCount} prompts`,
      endEpoch: Number.isInteger(rateLimits?.secondary?.resets_at) && rateLimits.secondary.resets_at > nowSec ? rateLimits.secondary.resets_at : null,
      isRemaining: hasSecondaryRateLimit || null,
    },
    weeklyCycle: buildWeeklyCycle(todayDate, rateLimits?.secondary?.resets_at),
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
    "select id, title, cwd, model, reasoning_effort, tokens_used, created_at, updated_at from threads where archived = 0 order by updated_at desc"
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
  writeMenubarJson(buildMenubarData(daily));
  const target = menubarOnly ? MENUBAR_JSON_PATH : OUTPUT;
  console.log(`[codex build] wrote ${target} with ${threads.length} threads and ${history.length} prompts`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildDailyActivity,
  buildMenubarData,
  buildModelSummary,
  buildOverview,
  buildProjects,
  buildThreads,
  formatProjectLabel,
  groupPromptsBySession,
  laDate,
  loadTrackerData,
  readChatGPTDesktopActivity,
  shortProjectName,
};

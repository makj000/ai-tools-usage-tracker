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
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
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

// Decide whether a transcript `type:"user"` entry is a real new prompt
// (worth starting a new cost bucket) or just a tool_result / sidechain /
// compact-summary that should attach to the current bucket.
function isRealPrompt(entry) {
  if (entry.type !== "user") return false;
  if (entry.isSidechain) return false;
  if (entry.isCompactSummary) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content)) {
    // tool_result entries are model-facing plumbing, not user prompts
    return content.some(c => c && c.type !== "tool_result");
  }
  return false;
}

function extractPromptText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textPart = content.find(c => c && (c.type === "text" || typeof c.text === "string"));
    if (textPart?.text) return textPart.text;
  }
  return "";
}

// Collect all rate_limit hit timestamps across transcripts (first pass).
// Returns sorted array of epoch timestamps. Used by readAllTranscripts to
// classify each assistant turn as subscription-covered vs extra-credit.
function collectRateLimitEpochs() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const epochs = [];
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  for (const slug of dirs) {
    const dp = path.join(PROJECTS_DIR, slug);
    const files = fs.readdirSync(dp).filter(f => f.endsWith(".jsonl"));
    for (const f of files) {
      try {
        const data = fs.readFileSync(path.join(dp, f), "utf8");
        // Quick string check before parsing every line
        if (!data.includes("rate_limit")) continue;
        for (const line of data.split("\n")) {
          if (!line || !line.includes("rate_limit")) continue;
          try {
            const e = JSON.parse(line);
            if (e.error === "rate_limit" && e.timestamp) {
              epochs.push(new Date(e.timestamp).getTime());
            }
          } catch {}
        }
      } catch {}
    }
  }
  return epochs.sort((a, b) => a - b);
}

function readAllTranscripts() {
  if (!fs.existsSync(PROJECTS_DIR)) return { sessions: {}, perDay: {}, perProject: {}, totals: zeroCounts(), prompts: [], extraTotals: zeroCounts() };

  // Pre-collect rate_limit timestamps so we can classify turns as extra credit.
  const rateLimitEpochs = collectRateLimitEpochs();

  // For a given assistant turn epoch, check if it falls after a rate_limit hit
  // within the same window. If so, it's extra credit usage.
  // We cache window lookups since findWindowStart is somewhat expensive.
  const windowStartCache = new Map();
  function getWindowStart(epoch) {
    // Quantize to minute-level for caching
    const key = Math.floor(epoch / 60000);
    if (windowStartCache.has(key)) return windowStartCache.get(key);
    const ws = _findWindowStartForExtra(epoch);
    windowStartCache.set(key, ws);
    return ws;
  }

  function isExtraCredit(turnEpoch) {
    if (!rateLimitEpochs.length) return false;
    const winStart = getWindowStart(turnEpoch);
    // Is there a rate_limit hit in [winStart, turnEpoch)?
    // Binary search for first rate_limit >= winStart
    let lo = 0, hi = rateLimitEpochs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rateLimitEpochs[mid] < winStart) lo = mid + 1;
      else hi = mid;
    }
    // lo is now the first rate_limit >= winStart
    return lo < rateLimitEpochs.length && rateLimitEpochs[lo] < turnEpoch;
  }

  const sessions = {};
  const perDay = {};
  const perProject = {};
  const totals = zeroCounts();
  const extraTotals = zeroCounts();
  const extraPerDay = {};
  const extraPerProject = {};
  const prompts = [];

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);

  for (const projectSlug of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectSlug);
    const projectName = "/" + slugToPath(projectSlug);
    // Root-level .jsonl only — skips the `subagents/` subfolder so subagent
    // usage isn't double-counted (it already rolls up into the parent).
    const files = fs.readdirSync(projectPath).filter(f => f.endsWith(".jsonl"));

    for (const file of files) {
      const sessionId = file.replace(".jsonl", "");
      const filePath = path.join(projectPath, file);
      try {
        const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
        let currentPrompt = null; // resets per transcript file
        for (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }

          // Start a new per-prompt bucket whenever we see a real user prompt.
          if (isRealPrompt(entry)) {
            const text = extractPromptText(entry);
            currentPrompt = {
              sessionId,
              uuid: entry.uuid || null,
              ts: entry.timestamp || null,
              project: projectName,
              text,
              cost: 0,
              extraCost: 0,
              turns: 0,
              turnDetails: [],
              counts: zeroCounts(),
            };
            // messages counter in zeroCounts() is meant for assistant turns;
            // reset it so it reflects turns, not the 1 from initialization.
            currentPrompt.counts.messages = 0;
            prompts.push(currentPrompt);
            continue;
          }

          if (entry.type !== "assistant" || !entry.message?.usage) continue;
          const model = entry.message.model;
          if (!model || model === "<synthetic>") continue;

          const usage = entry.message.usage;
          const cost = calcCost(usage, model);
          const ts = entry.timestamp;
          const day = ts ? ts.slice(0, 10) : "unknown";
          const turnEpoch = ts ? new Date(ts).getTime() : 0;
          const extra = isExtraCredit(turnEpoch);

          if (!sessions[sessionId]) {
            sessions[sessionId] = { sessionId, project: projectName, model, counts: zeroCounts(), cost: 0, extraCost: 0, firstTs: ts, lastTs: ts };
          }
          addCounts(sessions[sessionId].counts, usage);
          sessions[sessionId].cost += cost;
          if (extra) sessions[sessionId].extraCost += cost;
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

          if (extra) {
            addCounts(extraTotals, usage);
            extraTotals.cost = (extraTotals.cost || 0) + cost;

            if (!extraPerDay[day]) extraPerDay[day] = { cost: 0 };
            extraPerDay[day].cost += cost;

            if (!extraPerProject[projectName]) extraPerProject[projectName] = { cost: 0 };
            extraPerProject[projectName].cost += cost;
          }

          // Attribute this assistant turn to the in-flight prompt bucket.
          if (currentPrompt) {
            addCounts(currentPrompt.counts, usage);
            currentPrompt.cost += cost;
            if (extra) currentPrompt.extraCost += cost;
            currentPrompt.turns += 1;
            currentPrompt.turnDetails.push({
              ts,
              model: model || 'unknown',
              cost,
              extra,
              in: usage.input_tokens || 0,
              out: usage.output_tokens || 0,
              cw: usage.cache_creation_input_tokens || 0,
              cr: usage.cache_read_input_tokens || 0,
            });
          }
        }
      } catch { /* skip */ }
    }
  }

  return { sessions, perDay, perProject, totals, prompts, extraTotals, extraPerDay, extraPerProject };
}

function buildTokens() {
  const data = readAllTranscripts();
  const sessionList = Object.values(data.sessions)
    .sort((a, b) => (b.lastTs || "").localeCompare(a.lastTs || ""))
    .slice(0, 100);
  const projectList = Object.entries(data.perProject)
    .map(([project, d]) => ({ project, ...d }))
    .sort((a, b) => b.cost - a.cost);
  return {
    totals: data.totals,
    extraTotals: data.extraTotals,
    extraPerDay: data.extraPerDay || {},
    extraPerProject: data.extraPerProject || {},
    sessions: sessionList,
    perDay: data.perDay,
    projects: projectList,
    // Expose raw prompts so enrichHistory() can attach costs to history.jsonl
    // entries. Not serialized to data.js — dropped before write.
    _prompts: data.prompts || [],
  };
}

// Attach per-prompt cost data to each history.jsonl entry by matching
// (sessionId, display text) → transcript prompt bucket. history.jsonl is
// authoritative for "what the user typed and when"; transcripts are
// authoritative for cost. This runs server-side so the browser doesn't need
// any matching logic, and we're not bounded by a serialization cap.
function enrichHistory(history, prompts) {
  // Build a (sessionId, textKey) → prompt index. When multiple prompts share
  // a key in a session (rare: same prompt sent twice), we queue them and
  // pop in chronological order so each history entry gets a distinct bucket.
  const buckets = new Map();
  const keyOf = (sessionId, text) => sessionId + "\0" + (text || "").slice(0, 200);
  const sortedPrompts = [...prompts].sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  for (const p of sortedPrompts) {
    const k = keyOf(p.sessionId, p.text);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }

  // history.jsonl is appended chronologically per session, so iterate in
  // order and shift from the queue for each match — this handles duplicate
  // prompt text within a session correctly.
  const sortedHistory = [...history].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let matched = 0, unmatched = 0;
  for (const h of sortedHistory) {
    const k = keyOf(h.sessionId || "", h.display || "");
    const queue = buckets.get(k);
    if (queue && queue.length) {
      const p = queue.shift();
      h.cost = p.cost;
      h.extraCost = p.extraCost || 0;
      h.turns = p.turns;
      h.tokenCounts = p.counts;
      h.turnDetails = p.turnDetails || [];
      matched++;
    } else {
      unmatched++;
    }
  }
  return { matched, unmatched };
}

// --- Rate-limit window helpers ---
// Known reset hours — derived from rate_limit messages. Cached after first
// call to buildWindowUsage(). For the initial pass (collectRateLimitEpochs →
// readAllTranscripts), we pre-derive them.
let _cachedResetHours = null;

function deriveResetHours() {
  if (_cachedResetHours) return _cachedResetHours;
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const hours = new Set();
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  for (const slug of dirs) {
    const dp = path.join(PROJECTS_DIR, slug);
    const files = fs.readdirSync(dp).filter(f => f.endsWith(".jsonl"));
    for (const f of files) {
      try {
        const data = fs.readFileSync(path.join(dp, f), "utf8");
        if (!data.includes("rate_limit")) continue;
        for (const line of data.split("\n")) {
          if (!line || !line.includes("rate_limit")) continue;
          try {
            const e = JSON.parse(line);
            if (e.error !== "rate_limit") continue;
            const content = e.message?.content;
            let text = "";
            if (Array.isArray(content)) { const t = content.find(c => c && c.type === "text"); if (t) text = t.text || ""; }
            else if (typeof content === "string") text = content;
            const m = text.match(/resets?\s+(\d+)(am|pm)/i);
            if (m) {
              let h = parseInt(m[1]);
              if (m[2].toLowerCase() === "pm" && h !== 12) h += 12;
              if (m[2].toLowerCase() === "am" && h === 12) h = 0;
              hours.add(h);
            }
          } catch {}
        }
      } catch {}
    }
  }
  _cachedResetHours = [...hours].sort((a, b) => a - b);
  return _cachedResetHours;
}

function _findWindowStartForExtra(epoch) {
  const resetHours = deriveResetHours();
  if (!resetHours.length) return 0;
  const la = toLADate(new Date(epoch).toISOString());
  let startHour = resetHours[resetHours.length - 1];
  let startDay = la.day, startMonth = la.month, startYear = la.year;
  for (let i = resetHours.length - 1; i >= 0; i--) {
    if (resetHours[i] <= la.hour) { startHour = resetHours[i]; break; }
  }
  if (startHour > la.hour) {
    const yesterday = new Date(epoch - 86400000);
    const yLA = toLADate(yesterday.toISOString());
    startDay = yLA.day; startMonth = yLA.month; startYear = yLA.year;
  }
  return laEpoch(startYear, startMonth, startDay, startHour);
}

// --- Rate-limit / window usage detection ---
// Scan all transcripts for `error:"rate_limit"` entries and assistant usage,
// then compute: (a) learned window boundaries, (b) historical ceiling at each
// limit hit, (c) current window usage, (d) estimated % of limit used.

function toLADate(isoStr) {
  // Convert ISO timestamp to LA-local date parts
  const d = new Date(isoStr);
  const la = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const p = {};
  for (const { type, value } of la) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    epoch: d.getTime(),
  };
}

function laEpoch(year, month, day, hour) {
  // Build a Date for the given LA-local hour, return epoch ms.
  // We use a trick: construct in UTC, then adjust by the TZ offset.
  const isoGuess = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}T${String(hour).padStart(2,"0")}:00:00`;
  // Use Intl to find the actual offset
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", timeZoneName: "shortOffset",
  });
  const guessDate = new Date(isoGuess + "Z");
  // Get LA time at guessDate to find offset
  const laParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(guessDate);
  const laH = +laParts.find(p => p.type === "hour").value % 24; // normalize 24→0 at midnight
  // Modulo-aware diff: pick the shortest path so hour=0 doesn't wrap to previous day
  let diff = ((laH - hour) % 24 + 24) % 24;
  if (diff > 12) diff -= 24;
  return guessDate.getTime() - diff * 3600000;
}

function buildWindowUsage() {
  if (!fs.existsSync(PROJECTS_DIR)) return null;

  // Pass 1: collect all assistant usage entries and rate_limit entries
  const usageEntries = [];   // { ts (ISO), epoch, cost }
  const rateLimitHits = [];  // { ts, epoch, resetHour }

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);

  for (const slug of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, slug);
    const files = fs.readdirSync(projectPath).filter(f => f.endsWith(".jsonl"));
    for (const file of files) {
      try {
        const lines = fs.readFileSync(path.join(projectPath, file), "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }

          // Rate limit hit
          if (entry.error === "rate_limit" && entry.timestamp) {
            let resetHour = null;
            const content = entry.message?.content;
            let text = "";
            if (Array.isArray(content)) {
              const t = content.find(c => c && c.type === "text");
              if (t) text = t.text || "";
            } else if (typeof content === "string") {
              text = content;
            }
            const m = text.match(/resets?\s+(\d+)(am|pm)/i);
            if (m) {
              let h = parseInt(m[1]);
              if (m[2].toLowerCase() === "pm" && h !== 12) h += 12;
              if (m[2].toLowerCase() === "am" && h === 12) h = 0;
              resetHour = h;
            }
            rateLimitHits.push({
              ts: entry.timestamp,
              epoch: new Date(entry.timestamp).getTime(),
              resetHour,
            });
            continue;
          }

          // Assistant usage
          if (entry.type === "assistant" && entry.message?.usage && entry.timestamp) {
            const model = entry.message.model;
            if (!model || model === "<synthetic>") continue;
            const cost = calcCost(entry.message.usage, model);
            usageEntries.push({
              ts: entry.timestamp,
              epoch: new Date(entry.timestamp).getTime(),
              cost,
            });
          }
        }
      } catch { /* skip */ }
    }
  }

  if (!rateLimitHits.length) return null;

  // Derive window boundaries from reset hours
  const resetHours = [...new Set(rateLimitHits.map(r => r.resetHour).filter(h => h !== null))].sort((a, b) => a - b);
  if (!resetHours.length) return null;

  // Sort usage by time for binary-search-like window sums
  usageEntries.sort((a, b) => a.epoch - b.epoch);

  // For a given epoch, find which window it falls in and the window start epoch
  function findWindowStart(epoch) {
    const la = toLADate(new Date(epoch).toISOString());
    // Find the most recent boundary hour that has passed
    let startHour = resetHours[resetHours.length - 1]; // wrap to previous day
    let startDay = la.day;
    let startMonth = la.month;
    let startYear = la.year;
    for (let i = resetHours.length - 1; i >= 0; i--) {
      if (resetHours[i] <= la.hour) {
        startHour = resetHours[i];
        break;
      }
    }
    if (startHour > la.hour) {
      // Wrapped to yesterday's last boundary
      const yesterday = new Date(epoch - 86400000);
      const yLA = toLADate(yesterday.toISOString());
      startDay = yLA.day;
      startMonth = yLA.month;
      startYear = yLA.year;
    }
    return laEpoch(startYear, startMonth, startDay, startHour);
  }

  // Sum usage cost between two epochs
  function sumCostBetween(startEpoch, endEpoch) {
    let total = 0;
    for (const u of usageEntries) {
      if (u.epoch >= startEpoch && u.epoch < endEpoch) total += u.cost;
    }
    return total;
  }

  // Compute ceiling at each rate_limit hit (usage from window start to hit time).
  // Deduplicate: multiple hits in the same window (user retried) count as one
  // data point — keep only the first hit per window start.
  const seenWindows = new Set();
  const ceilings = [];
  for (const hit of rateLimitHits) {
    const winStart = findWindowStart(hit.epoch);
    const winKey = String(winStart);
    if (seenWindows.has(winKey)) continue;
    seenWindows.add(winKey);
    const cost = sumCostBetween(winStart, hit.epoch);
    if (cost > 0) {
      ceilings.push({
        ts: hit.ts,
        resetHour: hit.resetHour,
        cost,
      });
    }
  }

  // Use median ceiling for robustness against outliers (e.g. a session with
  // a huge compaction/cache fill that inflates one window's equiv. cost).
  const sortedCosts = ceilings.map(c => c.cost).sort((a, b) => a - b);
  const medianCeiling = sortedCosts.length
    ? sortedCosts.length % 2 === 1
      ? sortedCosts[Math.floor(sortedCosts.length / 2)]
      : (sortedCosts[sortedCosts.length / 2 - 1] + sortedCosts[sortedCosts.length / 2]) / 2
    : null;

  // Current window
  const now = Date.now();
  const currentWindowStart = findWindowStart(now);
  const currentUsage = sumCostBetween(currentWindowStart, now);

  // Find next boundary for display
  const laNow = toLADate(new Date(now).toISOString());
  let nextBoundaryHour = resetHours.find(h => h > laNow.hour);
  if (nextBoundaryHour === undefined) nextBoundaryHour = resetHours[0]; // wraps to tomorrow
  const windowStartLA = toLADate(new Date(currentWindowStart).toISOString());

  // --- Daily / Weekly / Monthly ceilings ---
  // Helper: compute median of a number array
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 === 1
      ? s[Math.floor(s.length / 2)]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  // Build per-day cost map from usage entries — use LA date, not UTC
  const dailyCosts = {};
  for (const u of usageEntries) {
    const la = toLADate(u.ts);
    const day = `${la.year}-${String(la.month).padStart(2,"0")}-${String(la.day).padStart(2,"0")}`;
    dailyCosts[day] = (dailyCosts[day] || 0) + u.cost;
  }

  // Days that had at least one rate_limit hit → daily ceiling data points (LA date)
  const hitDays = new Set();
  for (const hit of rateLimitHits) {
    const la = toLADate(hit.ts);
    hitDays.add(`${la.year}-${String(la.month).padStart(2,"0")}-${String(la.day).padStart(2,"0")}`);
  }
  const dailyCeilingValues = [...hitDays].map(d => dailyCosts[d] || 0).filter(c => c > 0);
  const dailyCeiling = median(dailyCeilingValues);

  // Current day usage (LA date)
  const todayLA = `${laNow.year}-${String(laNow.month).padStart(2,"0")}-${String(laNow.day).padStart(2,"0")}`;
  const dailyUsage = dailyCosts[todayLA] || 0;

  // --- Weekly ---
  // Week key based on Thursday reset: weeks run Thu–Wed.
  // Returns the date string (YYYY-MM-DD) of the Thursday that started the week.
  function weekKey(dateStr) {
    const d = new Date(dateStr + "T12:00:00Z");
    // getUTCDay(): Sun=0, Mon=1, ..., Thu=4, ..., Wed=3
    // Distance back to most-recent Thursday: (day - 4 + 7) % 7
    const daysBack = (d.getUTCDay() - 4 + 7) % 7;
    d.setUTCDate(d.getUTCDate() - daysBack);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
  }

  // Per-week costs
  const weeklyCosts = {};
  for (const [day, cost] of Object.entries(dailyCosts)) {
    const wk = weekKey(day);
    weeklyCosts[wk] = (weeklyCosts[wk] || 0) + cost;
  }

  // Weeks with hits
  const hitWeeks = new Set();
  for (const d of hitDays) hitWeeks.add(weekKey(d));
  const weeklyCeilingValues = [...hitWeeks].map(w => weeklyCosts[w] || 0).filter(c => c > 0);
  const weeklyCeiling = median(weeklyCeilingValues);

  // Current week
  const currentWeek = weekKey(todayLA);
  const weeklyUsage = weeklyCosts[currentWeek] || 0;

  // Per-day breakdown for the current week (Thu–Wed, 7 days)
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(currentWeek + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
    return {
      date: dateStr,
      usage: +((dailyCosts[dateStr] || 0).toFixed(4)),
      isCurrent: dateStr === todayLA,
      isPast: dateStr < todayLA,
    };
  });

  // --- Monthly ---
  const monthlyCosts = {};
  for (const [day, cost] of Object.entries(dailyCosts)) {
    const mo = day.slice(0, 7);
    monthlyCosts[mo] = (monthlyCosts[mo] || 0) + cost;
  }

  const hitMonths = new Set();
  for (const d of hitDays) hitMonths.add(d.slice(0, 7));
  const monthlyCeilingValues = [...hitMonths].map(m => monthlyCosts[m] || 0).filter(c => c > 0);
  const monthlyCeiling = median(monthlyCeilingValues);

  const currentMonth = todayLA.slice(0, 7);
  const monthlyUsage = monthlyCosts[currentMonth] || 0;

  // Today's windows — one entry per reset-hour slot for today's LA date
  const todayWindows = resetHours.map((startHour, i) => {
    const endHour = resetHours[(i + 1) % resetHours.length];
    const startEpoch = laEpoch(laNow.year, laNow.month, laNow.day, startHour);
    // End epoch: if endHour <= startHour it wraps to tomorrow (the 23→0 window)
    const endDay = endHour <= startHour
      ? (() => { const d = new Date(startEpoch + 3600000); const la = toLADate(d.toISOString()); return { y: la.year, m: la.month, d: la.day }; })()
      : { y: laNow.year, m: laNow.month, d: laNow.day };
    const endEpoch = laEpoch(endDay.y, endDay.m, endDay.d, endHour) || (startEpoch + (endHour - startHour) * 3600000);
    const usage = sumCostBetween(startEpoch, Math.min(endEpoch, now));
    return {
      startHour,
      endHour,
      durationHours: endHour > startHour ? endHour - startHour : 24 - startHour + endHour,
      usage: +usage.toFixed(4),
      isCurrent: startEpoch <= now && now < endEpoch,
      isPast: endEpoch <= now,
    };
  });

  return {
    resetHours,
    windowStartHour: windowStartLA.hour,
    windowStartTs: new Date(currentWindowStart).toISOString(),
    nextResetHour: nextBoundaryHour,
    // Per-window
    currentUsage,
    medianCeiling,
    pctUsed: medianCeiling ? Math.min(currentUsage / medianCeiling, 1.5) : null,
    ceilings: ceilings.map(c => ({ ts: c.ts, cost: +c.cost.toFixed(4) })),
    totalHits: rateLimitHits.length,
    todayWindows,
    // Daily
    daily: {
      usage: dailyUsage,
      ceiling: dailyCeiling,
      pct: dailyCeiling ? Math.min(dailyUsage / dailyCeiling, 1.5) : null,
      dataPoints: dailyCeilingValues.length,
      date: todayLA,
    },
    // Weekly
    weekly: {
      usage: weeklyUsage,
      ceiling: weeklyCeiling,
      pct: weeklyCeiling ? Math.min(weeklyUsage / weeklyCeiling, 1.5) : null,
      dataPoints: weeklyCeilingValues.length,
      week: currentWeek,
      weekDays,
    },
    // Monthly
    monthly: {
      usage: monthlyUsage,
      ceiling: monthlyCeiling,
      pct: monthlyCeiling ? Math.min(monthlyUsage / monthlyCeiling, 1.5) : null,
      dataPoints: monthlyCeilingValues.length,
      month: currentMonth,
    },
  };
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

  const tokens = buildTokens();
  const history = readJsonl(HISTORY_PATH);
  const enrichResult = enrichHistory(history, tokens._prompts);
  delete tokens._prompts; // internal, don't ship

  const windowUsage = buildWindowUsage();

  const config = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
  if (config.extraSpentOverride != null) tokens.extraTotals.cost = config.extraSpentOverride;

  const data = {
    generatedAt: new Date().toISOString(),
    ...(config.extraPurchasedSeed != null ? { extraPurchasedSeed: config.extraPurchasedSeed } : {}),
    tokens,
    stats: buildStats(fresh.events),
    history,
    events: fresh.events,
    windowUsage,
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
  console.log(`[build] history costs attached: ${enrichResult.matched} matched, ${enrichResult.unmatched} unmatched`);
}

// Export internals for testing; skip build when required as a module.
if (typeof module !== "undefined" && module.exports && require.main !== module) {
  module.exports = {
    getPricing, calcCost, zeroCounts, addCounts, slugToPath,
    isRealPrompt, extractPromptText, enrichHistory, readJsonl, toLADate,
  };
} else {
  build();
}

if (require.main === module && process.argv.includes("--watch")) {
  console.log("[build] watching for changes... (Ctrl+C to stop)");
  let timer = null;
  const debounced = () => { clearTimeout(timer); timer = setTimeout(build, 800); };
  // Watch projects dir, events file, history file
  try { fs.watch(PROJECTS_DIR, { recursive: true }, debounced); } catch (e) { console.warn("[build] cannot watch projects dir:", e.message); }
  try { if (fs.existsSync(EVENTS_FILE)) fs.watch(EVENTS_FILE, debounced); } catch {}
  try { if (fs.existsSync(HISTORY_PATH)) fs.watch(HISTORY_PATH, debounced); } catch {}
}

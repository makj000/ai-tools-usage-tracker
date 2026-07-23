#!/usr/bin/env node
'use strict';

/**
 * AI Tool Advisor — watches usage across Claude Code, Codex, and Antigravity
 * and fires macOS notifications suggesting when to switch tools to balance load.
 *
 * Invoked by run_advisor.sh (via launchd) every 15 minutes. Self-throttles via
 * state.json.nextRunAt; the agent sets proposedNextCheckMinutes to adapt cadence.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const ROOT = path.resolve(__dirname, '..');
const ADVISOR_DIR = __dirname;
const STATE_PATH   = path.join(ADVISOR_DIR, 'state.json');
const HISTORY_PATH = path.join(ADVISOR_DIR, 'history.jsonl');
const PROMPT_PATH  = path.join(ADVISOR_DIR, 'prompt.md');
const LOG_PATH     = path.join(ROOT, 'logs', 'advisor.log');

// A session file must have been modified within this window to count as "active".
const ACTIVE_AGE_MS = 30 * 60 * 1000;

const DEFAULT_INTERVAL_MIN = 15;
const MIN_INTERVAL_MIN     = 5;
const MAX_INTERVAL_MIN     = 120;

// ---- providers ----------------------------------------------------------------

const PROVIDERS = [
  {
    name: 'Claude Code',
    menubarPath: path.join(HOME, '.claude/claude-tracker-menubar.json'),
    sessionDir:  path.join(HOME, '.claude/projects'),
    sessionMatch: name => name.endsWith('.jsonl'),
    readPrompts:  extractClaudePrompts,
  },
  {
    name: 'Codex',
    menubarPath: path.join(HOME, '.codex/codex-tracker-menubar.json'),
    sessionDir:  path.join(HOME, '.codex/sessions'),
    sessionMatch: name => /^rollout-.*\.jsonl$/.test(name),
    readPrompts:  extractCodexPrompts,
  },
  {
    name: 'Antigravity',
    menubarPath: path.join(HOME, '.gemini/antigravity-cli/antigravity-tracker-menubar.json'),
    sessionDir:  path.join(HOME, '.gemini/antigravity-cli/brain'),
    sessionMatch: name => name === 'transcript.jsonl',
    readPrompts:  extractAntigravityPrompts,
  },
];

// ---- logging ------------------------------------------------------------------

function log(...args) {
  const msg = `[advisor ${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(msg);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, msg + '\n');
  } catch {}
}

// ---- state --------------------------------------------------------------------

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readState()    { return readJson(STATE_PATH) || {}; }
function writeState(s)  { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
function appendHistory(e) {
  try { fs.appendFileSync(HISTORY_PATH, JSON.stringify(e) + '\n'); } catch {}
}

// ---- session file finder ------------------------------------------------------

function findMostRecentFile(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  let bestPath = null;
  let bestMtime = -1;
  const cutoff = Date.now() - ACTIVE_AGE_MS;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!predicate(entry.name)) continue;
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > bestMtime && mtime >= cutoff) { bestMtime = mtime; bestPath = full; }
      }
    } catch {}
  }
  return bestPath;
}

// ---- prompt extractors --------------------------------------------------------
// Each returns the last N user messages from the most recent session file.

function extractClaudePrompts(filePath, max = 3) {
  const prompts = [];
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.type !== 'user') continue;
        const c = e.message?.content;
        // Skip tool-result arrays; only take plain string prompts.
        if (typeof c === 'string' && c.length > 0) prompts.push(c.slice(0, 220));
      } catch {}
    }
  } catch {}
  return prompts.slice(-max);
}

function extractCodexPrompts(filePath, max = 3) {
  const prompts = [];
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.type !== 'event_msg' || e.payload?.type !== 'user_message') continue;
        const t = e.payload?.message;
        if (t && t.length > 0) prompts.push(t.slice(0, 220));
      } catch {}
    }
  } catch {}
  return prompts.slice(-max);
}

function extractAntigravityPrompts(filePath, max = 3) {
  const prompts = [];
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.type !== 'USER_INPUT') continue;
        const match = (e.content || '').match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        const t = match?.[1]?.trim();
        if (t && t.length > 0) prompts.push(t.slice(0, 220));
      } catch {}
    }
  } catch {}
  return prompts.slice(-max);
}

// ---- provider context ---------------------------------------------------------

function usedFraction(metric) {
  if (!metric || metric.pct == null) return null;
  return metric.isRemaining ? Math.max(0, 1 - metric.pct) : metric.pct;
}

function readProviderContext({ name, menubarPath, sessionDir, sessionMatch, readPrompts }) {
  const usage = readJson(menubarPath);
  if (!usage) return null;

  let recentPrompts = [];
  let sessionActive = false;
  try {
    const f = findMostRecentFile(sessionDir, sessionMatch);
    if (f) { recentPrompts = readPrompts(f); sessionActive = true; }
  } catch {}

  return {
    name,
    windowUsedPct:   usedFraction(usage.primary),
    weeklyUsedPct:   usedFraction(usage.secondary),
    windowLabel:     usage.primaryLabel || null,
    weeklyLabel:     usage.secondaryLabel || null,
    windowDetail:    usage.primary?.detail || null,
    weeklyDetail:    usage.secondary?.detail || null,
    windowResetEpoch: usage.primary?.endEpoch || null,
    weeklyResetEpoch: usage.secondary?.endEpoch || null,
    sessionActive,
    recentPrompts,
    dataUpdatedAt:   usage.updatedAt || null,
  };
}

// ---- agent invocation ---------------------------------------------------------

function extractJsonObject(text) {
  try {
    const m = text?.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

function runAgent(prompt) {
  const bin   = process.env.ADVISOR_CLAUDE_BIN   || 'claude';
  const model = process.env.ADVISOR_CLAUDE_MODEL  || 'claude-haiku-4-5-20251001';
  log(`invoking agent (${bin}, model=${model})…`);
  let raw;
  try {
    raw = execFileSync(bin, ['-p', prompt, '--output-format', 'json', '--model', model], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 90 * 1000,
    });
  } catch (e) {
    log('agent invocation failed:', e.message);
    return null;
  }
  const envelope = extractJsonObject(raw);
  const inner    = typeof envelope?.result === 'string' ? extractJsonObject(envelope.result) : null;
  return inner ?? envelope ?? null;
}

// ---- notification -------------------------------------------------------------

function fireNotification(title, body) {
  try {
    execFileSync('terminal-notifier', [
      '-title', title,
      '-message', body,
      '-group', 'ai-tool-advisor',
    ], { timeout: 5000 });
    log(`notified: "${title}" / "${body}"`);
  } catch (e) {
    log('terminal-notifier failed:', e.message);
  }
}

// ---- main ---------------------------------------------------------------------

function main() {
  const force = process.argv.includes('--force');
  const state = readState();
  const now   = Date.now();

  if (!force && state.nextRunAt && now < state.nextRunAt) {
    log(`not due yet — next at ${new Date(state.nextRunAt).toISOString()}`);
    return;
  }

  const providers = PROVIDERS.map(readProviderContext).filter(Boolean);
  if (providers.length === 0) {
    log('no provider data available');
    writeState({ ...state, nextRunAt: now + DEFAULT_INTERVAL_MIN * 60 * 1000 });
    return;
  }

  // Skip agent call when nothing is active — no point recommending.
  if (!providers.some(p => p.sessionActive)) {
    const idleMin = 30;
    log(`no active sessions — sleeping ${idleMin}min`);
    writeState({ ...state, nextRunAt: now + idleMin * 60 * 1000 });
    return;
  }

  const context = {
    currentTimeISO: new Date().toISOString(),
    lastNotifiedAt: state.lastNotifiedAt || null,
    providers,
  };

  const promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf8');
  const fullPrompt = `${promptTemplate}\n\n## Current Data\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\nRespond with a single JSON object only — no markdown fences, no other text.`;

  const verdict = runAgent(fullPrompt);

  if (!verdict) {
    log('no verdict — will retry next interval');
    writeState({ ...state, nextRunAt: now + DEFAULT_INTERVAL_MIN * 60 * 1000 });
    return;
  }

  log('verdict:', JSON.stringify(verdict));
  appendHistory({ timestamp: new Date().toISOString(), verdict, context });

  const intervalMin = Math.max(
    MIN_INTERVAL_MIN,
    Math.min(MAX_INTERVAL_MIN, verdict.proposedNextCheckMinutes ?? DEFAULT_INTERVAL_MIN)
  );
  const nextRunAt = now + intervalMin * 60 * 1000;

  if (verdict.action === 'notify') {
    fireNotification(
      verdict.notification_title || 'AI Tool Advisor',
      verdict.notification_body  || ''
    );
    writeState({ ...state, lastNotifiedAt: new Date().toISOString(), nextRunAt });
  } else {
    writeState({ ...state, nextRunAt });
    log(`no notification — next in ${intervalMin}min (${verdict.reasoning || ''})`);
  }
}

main();

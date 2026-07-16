# Claude Tracker — CLAUDE.md

## Versioning

- **Increment the patch version** (e.g. 2.2.0 -> 2.2.1) for each turn (each assistant response).
- **Increment the minor version** (e.g. 2.2.0 -> 2.3.0) for each command (each user prompt/request). Reset patch to 0 on minor bump.
- Version appears in two places — keep them in sync:
  - `package.json` `"version"` field
  - `claude/report.html` header span (the `v3.x.x` label)

## Project Overview

Claude Tracker is a self-hosted dashboard that tracks Claude Code usage, Claude Cowork scheduled-task activity, token consumption, and estimated API-equivalent costs. It runs entirely locally — a Python hook logs events, a Node.js build script processes Claude Code and Claude Cowork data, and a single HTML file renders everything in the browser.

## Architecture

```
~/.claude/settings.json   hooks: PreToolUse, PostToolUse, Notification, UserPromptSubmit
        |
        v
scripts/log_hook.py       Appends events to data/events.jsonl, triggers background rebuild
        |
        v
scripts/build.js          Reads transcripts + history + events, writes data.js
        |
        v
report.html + data.js     Static dashboard, open in any browser
```

### Data Flow

1. **Hooks** (`log_hook.py`): Claude Code fires hooks on tool use and prompt submission. The hook appends a JSON line to `data/events.jsonl` and kicks off `node scripts/build.js` in the background.
2. **Build** (`build.js`): Walks all Claude Code transcripts (`~/.claude/projects/*/sessions/*/transcript.jsonl`) and history (`~/.claude/history.jsonl`), and also reads Claude Cowork local-agent-mode session data from the desktop app's storage. Computes per-session, per-day, per-project token counts and costs. Detects rate limits and classifies extra-credit turns. Enriches history entries with cost data, merges Cowork runs into dashboard datasets, and synthesizes Cowork tool events for the Tool Usage tab. Outputs `data.js`.
3. **Dashboard** (`report.html`): Single-file HTML/CSS/JS. Loads `data.js` via script tag (cache-busted). Renders overview, token usage, and tool usage tabs, with Cowork scheduled tasks visually distinguished from Claude Code items.

## File Structure

```
claude-tracker/
  package.json              Version, scripts (build, watch, test)
  report.html               Single-file dashboard (HTML + CSS + JS)
  data.js                   Generated data file (gitignored)
  data/                     Runtime data directory
    config.json             Optional runtime config (extraPurchasedSeed, extraSpentOverride)
    events.jsonl            Hook event log (rotated at 10MB)
    events-*.jsonl          Rotated event files
  scripts/
    build.js                Build script — reads transcripts, writes data.js
    log_hook.py             Hook handler — logs events, triggers rebuild
    log_hook.sh             Legacy shell hook wrapper
  test/
    build.test.js           39 tests for build.js functions
    log_hook.test.py        7 tests for log_hook.py
  CLAUDE.md                 This file
```

## Key Design Decisions

### Dashboard Layout (report.html)

- **Header**: Title, version, absolute timestamp of data freshness, monthly cost total
- **Sidebar** (left, 280px):
  - Top Projects list — shows cost bar + `$X.XX` + `Xk in · Xk out` tokens (clickable: single-click = filter, double-click = jump to Token Usage tab); Claude Cowork projects are tinted and labeled `Scheduled`
  - Sessions list sorted by equiv. cost — shows cost, `Xk in · Xk out` tokens, and date (clickable = filter by session); Claude Cowork runs are tinted and labeled `Scheduled`
- **Main area** (right):
  - Filter bar (shown when any filter is active, with tag chips and reset button)
  - Three tabs: Overview, Token Usage, Tool Usage

#### Overview Tab

- **Top row** (two-column grid):
  - Left: Stat cards — Extra Credit Used, Today (equiv.), Input Tokens, Output Tokens, All-time Extra
  - Right: Usage Limits Estimate (window/daily/weekly/monthly bars) + Extra Credit Usage gauge
- **Chart**: Single dual-bar chart, last 14 days — amber bar = prompts (up), green bar = cost (up), red bar = extra credit (down from baseline); each series scaled independently to its own max; amber y-axis on the left, green y-axis on the right (top/mid/0 labels); red max label at bottom-left; clicking a day column filters by that day (whole column highlights, not individual bars)
- **Recent Prompts**: Searchable list with cost pills, turn counts, expand/collapse for per-turn details table; Claude Cowork scheduled tasks are labeled `Scheduled Task` and use a stronger purple treatment than standard Claude Code items

#### Token Usage Tab

- Token totals, per-project cost bars, per-day cost table; Cowork scheduled-task projects are labeled `Scheduled`

#### Tool Usage Tab

- Tool frequency grid, per-tool counts, and tool-event feed
- Includes synthesized Claude Cowork tool events from scheduled-task runs, labeled `Scheduled Task`

### Claude Cowork Integration

- `readCoworkSessions()` reads Claude Cowork scheduled-task runs from the desktop app's local-agent-mode storage
- Scheduled-task runs are merged into:
  - `history` for the main command feed
  - `tokens.sessions` for the sidebar session list
  - `tokens.projects` for project cost aggregation
  - `events` / `stats.toolCounts` via synthesized tool events for the Tool Usage tab
- Cowork items are identified with `isCowork` and rendered with `Scheduled` / `Scheduled Task` badges across the dashboard

### Timezone Handling

- All date/time logic uses **America/Los_Angeles** (PT) via `Intl.DateTimeFormat`
- `toLADate(isoStr)` — converts any ISO timestamp to LA date parts `{year, month, day, hour, ...}`; normalizes `hour: 24` (midnight quirk) to `0`
- `laEpoch(year, month, day, hour)` — converts an LA date+hour back to a UTC epoch ms; uses a modulo-aware diff `((laH - hour) % 24 + 24) % 24` (clamped to ±12h) to avoid the naive subtraction landing on the previous day when `hour = 0`
- `dailyCosts` and `hitDays` in `buildWindowUsage` use LA date (not UTC slice) to prevent post-5pm PT usage from leaking into the next calendar day
- `days` array and `todayKey` in `renderOverview` and `renderExtraGauge` use `laDateStr(new Date())` (client-side LA date) for the same reason

### Rate Limit Detection

- Scans transcripts for `error: "rate_limit"` entries
- Extracts window boundaries from reset-hour messages (e.g. "resets 1pm")
- Known reset hours: `[0, 4, 7, 13, 18, 23]` PT (derived from data)
- Uses binary search to classify turns as extra-credit (after a rate_limit hit in the same window)

### Usage Ceiling Estimation

- Collects cost-at-hit for each rate limit event per tier (window, daily, weekly, monthly)
- Uses **median** ceiling (robust against outliers like large compaction sessions)
- Deduplicates same-window retries
- **Window bar is segmented** — one slot per detected reset-hour for today (widths proportional to hours); fill = usage vs. median ceiling; past slots faded to 40%; current slot has blue outline + blue start-time label (`.win-current`); hover highlights start/end timestamps and shows usage % below each slot; falls back to plain `renderUsageBar` if `todayWindows` data is missing; **`isCurrent`/`isPast` computed client-side** (`winIsCurrent = ww.startHour === startHour`, `winIsPast = endHour !== 0 ? endHour <= nowHour : false`) so stale data.js never shows the wrong slot highlighted
- **Weekly window resets on Thursday mornings** — `weekKey()` in build.js groups dates into Thu–Wed weeks, keyed by the Thursday start date (YYYY-MM-DD format)
- **Weekly bar is segmented** — 7 equal slots (Thu–Wed), each showing that day's usage vs. the **daily ceiling** (not weekly); segment is full when the day's allotment is exhausted regardless of weekly budget remaining; current day has blue outline + label; past days faded to 40%; future days at 55%; overall weekly % shown in the header; tooltip shows `Day MM/DD: $X.XX / $Y.YY daily (Z%)`; **`isCurrent`/`isPast` computed client-side** (`wd.date === laDateStr(new Date())`) so stale data.js never highlights the wrong day
- **Daily bar is hidden** — daily estimated cap shown as inline text in the "Est. cap" row alongside the monthly spend
- **Monthly has no known ceiling** — shown as a plain number (no bar/percentage), blue text only

### Runtime Config (`data/config.json`)

Optional JSON file read by build.js on every build. Supported fields:
- `extraPurchasedSeed` — default purchased extra credit amount (number, USD); used as the `localStorage` fallback in `getExtraPurchased()` when the user hasn't set a value in the browser
- `extraSpentOverride` — override the transcript-derived `extraTotals.cost` (number, USD); useful when transcript detection undercounts actual extra credit charges
- `weeklyLimitSeed` — override the estimated weekly ceiling (number, USD); use to calibrate against the actual % shown on claude.ai's usage page: `weeklyLimitSeed = currentWeeklyUsage / claudeAiPct`; calibration history is tracked in memory (`project_weekly_calibration.md`) — always record old seed + weeklyUsage + claude.ai % before updating, to detect oscillation
- `windowLimitSeed` — override the median-derived per-window ceiling (number, USD); use when the median is stale (old rate-limit hits from when limits were higher): `windowLimitSeed = currentWindowUsage / claudeAiWindowPct`
- `fableWeeklyLimitSeed` — ceiling for the separate Fable 5 weekly limit (number, USD): `fableWeeklyLimitSeed = currentFableWeeklyUsage / claudeAiFablePct`; there is no rate-limit-derived estimate for this limit, so without a seed the dashboard shows only the $ figure. The official % from Claude Code's statusline cache (any `rate_limits` key containing `fable`) is preferred over the estimate wherever it's present and fresh

### Accuracy Inspector (`accuracy/`)

A self-rescheduling subsystem that keeps the menu-bar estimates honest against the official usage pages. Lives in the top-level `accuracy/` dir (parallel to `claude/`, `codex/`, `menubar/`).

Codex menu-bar 5h usage is percentage-first: use the official 5-hour usage-page value when present; otherwise show an estimated `% est.` value whenever a 5h window anchor can be derived. Do not show token-only text for the Codex 5h row when a 5h window exists.

Codex 菜单栏的 5 小时用量必须优先显示百分比：有官方 5 小时用量页数据时使用官方值；否则只要能推导出 5 小时窗口锚点，就显示估算的 `% est.`。当 5 小时窗口存在时，不要在 Codex 5h 行只显示 token 文本。

- `scrape.js` — Playwright persistent-context scraper. `--login` opens a headed window to sign into `claude.ai` + `chatgpt.com` once; thereafter headless. Captures visible text + full-page screenshot per provider into `accuracy/snapshots/`, sets a `loginWall` flag, writes `snapshots/latest.json`. It deliberately does **not** parse numbers — extraction is delegated to the agent so it survives page redesigns.
- `expected.js` — reads the per-provider menubar JSON the Swift app shows (`~/.claude/claude-tracker-menubar.json`, `~/.codex/codex-tracker-menubar.json`) and normalizes the displayed window/weekly metrics for comparison. Note Codex shows `% left` (remaining) vs Claude `% used`.
- `prompt.md` — agent instructions: normalize used-vs-remaining, compute per-metric `delta_pp`, flag `off` when `|delta| > 5`pp, prefer config-seed calibration over code edits, run tests and revert on failure, emit a strict JSON verdict.
- `inspect.js` — orchestrator: scrape → invoke local `claude` CLI headless (`-p … --output-format json`; `--dangerously-skip-permissions` in fix mode, read-only tools in `--dry-run`) → record verdict to `history.jsonl` → write per-provider `*-accuracy.json` (read by the menu bar) → adaptive reschedule into `state.json`. Flags: `--once`, `--dry-run`, `--no-scrape`, `--mock-agent <verdict.json>` (test hook).
- **Adaptive cadence**: blends the agent's `proposedNextIntervalHours` with an EWMA over recent `history.jsonl` discrepancy magnitude + off-rate; clamped to `[MIN_HOURS=2, MAX_HOURS=168]`. Calm runs grow the interval geometrically (≤1.5×, never shrinking); large/frequent gaps pull toward 2h. Bounds live in `accuracy/lib/paths.js`.
- **Scheduling**: `com.ai-tools-usage-tracker.accuracy.plist` fires `accuracy/run_inspect.sh` hourly; the script early-exits until `state.json.nextRunAt`, so the effective cadence is agent-chosen without rewriting the plist. `--force` bypasses the gate (used by the menu bar's "Run accuracy check now"). `install_launch_agent.sh` installs both this and the menubar agent.
- **Menu bar surface** (`menubar/Sources/main.swift`): `AccuracyStatus` decodes `*-accuracy.json`; each provider shows an `Accuracy: ✓/⚠/🔑 …` item + a "Run accuracy check now" action that shells `run_inspect.sh --force`.
- **Gitignored**: `accuracy/{node_modules,snapshots,state.json,history.jsonl,.browser-profile}`.

### History Enrichment (server-side)

- `enrichHistory()` matches `history.jsonl` entries to transcript prompt buckets by `(sessionId, textPrefix)`
- Attaches cost, turn count, token counts, turn-level details to each history entry
- Per-key queues handle duplicate prompt text within a session

### Filters

- Project, day, session filters — all persisted in localStorage
- Charts, prompts list, and sidebar all react to active filters

### Extra Credit Tracking

- Manual purchase entry via localStorage (`claude-tracker-extraPurchased`)
- Balance = purchased - consumed, with add/reset buttons
- Daily extra credit charges shown as downward red bars in the Activity & Cost chart (bottom half, 40px section); scaled independently to their own max; red max label on bottom-left y-axis

## Commands

```bash
npm run build     # One-shot build of data.js
npm run watch     # Rebuild on file changes
npm test          # Run all tests (39 JS + 7 Python)
```

## Testing

- `test/build.test.js`: Tests for getPricing, calcCost, zeroCounts/addCounts, slugToPath, isRealPrompt, extractPromptText, enrichHistory, readJsonl
- `test/log_hook.test.py`: Tests for event writing, appending, empty stdin, invalid JSON, UserPromptSubmit, file rotation

Both test files use lightweight custom test harnesses (no external dependencies).

## Exports (build.js)

When required as a module (not run as main), build.js exports:
`getPricing, calcCost, zeroCounts, addCounts, slugToPath, isRealPrompt, extractPromptText, enrichHistory, readJsonl, toLADate`

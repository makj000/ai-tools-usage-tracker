# Claude Tracker — CLAUDE.md

## Versioning

- **Increment the patch version** (e.g. 2.2.0 -> 2.2.1) for each turn (each assistant response).
- **Increment the minor version** (e.g. 2.2.0 -> 2.3.0) for each command (each user prompt/request). Reset patch to 0 on minor bump.
- Version appears in two places — keep them in sync:
  - `package.json` `"version"` field
  - `report.html` header span (the `v2.x.x` label)

## Project Overview

Claude Tracker is a self-hosted dashboard that tracks Claude Code usage, token consumption, and estimated API-equivalent costs. It runs entirely locally — a Python hook logs events, a Node.js build script processes Claude Code transcripts, and a single HTML file renders everything in the browser.

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
2. **Build** (`build.js`): Walks all Claude Code transcripts (`~/.claude/projects/*/sessions/*/transcript.jsonl`) and history (`~/.claude/history.jsonl`). Computes per-session, per-day, per-project token counts and costs. Detects rate limits and classifies extra-credit turns. Enriches history entries with cost data. Outputs `data.js`.
3. **Dashboard** (`report.html`): Single-file HTML/CSS/JS. Loads `data.js` via script tag (cache-busted). Renders overview, token usage, and tool usage tabs.

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
  - Top Projects list — shows cost bar + `$X.XX` + `Xk in · Xk out` tokens (clickable: single-click = filter, double-click = jump to Token Usage tab)
  - Sessions list sorted by equiv. cost — shows cost, `Xk in · Xk out` tokens, and date (clickable = filter by session)
- **Main area** (right):
  - Filter bar (shown when any filter is active, with tag chips and reset button)
  - Three tabs: Overview, Token Usage, Tool Usage

#### Overview Tab

- **Top row** (two-column grid):
  - Left: Stat cards — Extra Credit Used, Today (equiv.), Input Tokens, Output Tokens, All-time Extra
  - Right: Usage Limits Estimate (window/daily/weekly/monthly bars) + Extra Credit Usage gauge with sparkline
- **Chart**: Single dual-bar chart, last 14 days — amber bar = prompts, green bar = cost; each series scaled independently to its own max; amber y-axis on the left, green y-axis on the right (top/mid/0 labels); clicking a day column filters by that day (whole column highlights, not individual bars)
- **Recent Prompts**: Searchable list with cost pills, turn counts, expand/collapse for per-turn details table

#### Token Usage Tab

- Token totals, per-project cost bars, per-day cost table

#### Tool Usage Tab

- Tool frequency grid, per-tool counts

### Timezone Handling

- All date/time logic uses **America/Los_Angeles** (PT) via `Intl.DateTimeFormat`
- `toLADate(isoStr)` — converts any ISO timestamp to LA date parts `{year, month, day, hour, ...}`; normalizes `hour: 24` (midnight quirk) to `0`
- `laEpoch(year, month, day, hour)` — converts an LA date+hour back to a UTC epoch ms; uses a modulo-aware diff `((laH - hour) % 24 + 24) % 24` (clamped to ±12h) to avoid the naive subtraction landing on the previous day when `hour = 0`
- `dailyCosts` and `hitDays` in `buildWindowUsage` use LA date (not UTC slice) to prevent post-5pm PT usage from leaking into the next calendar day

### Rate Limit Detection

- Scans transcripts for `error: "rate_limit"` entries
- Extracts window boundaries from reset-hour messages (e.g. "resets 1pm")
- Known reset hours: `[0, 4, 7, 13, 18, 23]` PT (derived from data)
- Uses binary search to classify turns as extra-credit (after a rate_limit hit in the same window)

### Usage Ceiling Estimation

- Collects cost-at-hit for each rate limit event per tier (window, daily, weekly, monthly)
- Uses **median** ceiling (robust against outliers like large compaction sessions)
- Deduplicates same-window retries
- **Window bar is segmented** — one slot per detected reset-hour for today (widths proportional to hours); fill = usage vs. median ceiling; past slots faded to 40%; current at full opacity; hover highlights start/end timestamps and shows usage % below each slot; falls back to plain `renderUsageBar` if `todayWindows` data is missing
- **Weekly window resets on Thursday mornings** — `weekKey()` in build.js groups dates into Thu–Wed weeks, keyed by the Thursday start date (YYYY-MM-DD format)
- **Weekly bar is segmented** — 7 equal slots (Thu–Wed), each showing that day's usage vs. the **daily ceiling** (not weekly); segment is full when the day's allotment is exhausted regardless of weekly budget remaining; current day has blue outline + label; past days faded to 40%; future days at 55%; overall weekly % shown in the header; tooltip shows `Day MM/DD: $X.XX / $Y.YY daily (Z%)`
- **Daily bar is hidden** — daily estimated cap shown as inline text in the "Est. cap" row alongside the monthly spend
- **Monthly has no known ceiling** — shown as a plain number (no bar/percentage), blue text only

### Runtime Config (`data/config.json`)

Optional JSON file read by build.js on every build. Supported fields:
- `extraPurchasedSeed` — default purchased extra credit amount (number, USD); used as the `localStorage` fallback in `getExtraPurchased()` when the user hasn't set a value in the browser
- `extraSpentOverride` — override the transcript-derived `extraTotals.cost` (number, USD); useful when transcript detection undercounts actual extra credit charges

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
- Monthly sparkline of daily extra charges

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

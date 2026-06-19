# Agentic Tool Usage Tracker

A self-hosted dashboard that tracks Claude Code, OpenAI Codex, and Google Antigravity activity. It processes local transcripts, histories, quota signals, token consumption, and estimated API-equivalent costs.

Also includes a native macOS menu bar app showing live usage bars for all providers.

<img width="1400" alt="Claude Tracker — Overview tab" src="screenshots/claude-overview.png">

## Features

- Per-session and per-project token/cost breakdown
- Rate limit detection and usage window estimation
- Extra credit tracking
- Tool usage frequency (Claude Code)
- Claude Cowork scheduled-task integration
- Antigravity prompt, conversation, project, storage, and weekly quota tracking
- Native macOS menu bar widget with usage bars for Claude, Codex, and Antigravity
- Self-calibrating accuracy inspector that checks estimates against the official usage pages and auto-corrects drift

## Screenshots

### Claude Dashboard

<img width="1400" alt="Claude Tracker — Cost &amp; Tokens tab" src="screenshots/claude-cost-tokens.png">

<img width="1400" alt="Claude Tracker — Tool Usage tab" src="screenshots/claude-tool-usage.png">

### Codex Dashboard

<img width="1400" alt="Codex Tracker dashboard" src="screenshots/codex-overview.png">

### Menu Bar

<img width="400" alt="Menu bar app — Claude and Codex usage" src="screenshots/menubar-dropdown.png">

## Prerequisites

- macOS (menu bar app requires macOS 13+)
- [Node.js](https://nodejs.org/) (v18+) — `brew install node`
- Python 3 — included with macOS or `brew install python`
- Swift toolchain — included with Xcode or `xcode-select --install` (menu bar only)
- Claude Code CLI

## Installation

### 1. Clone the repo

```bash
git clone https://github.com/your-username/ai-tools-usage-tracker.git
cd ai-tools-usage-tracker
```

### 2. Wire up Claude Code hooks

Add the following to `~/.claude/settings.json` (merge with any existing hooks):

```json
{
  "hooks": {
    "PreToolUse":      [{"matcher": "", "hooks": [{"type": "command", "command": "python3 /path/to/ai-tools-usage-tracker/claude/scripts/log_hook.py"}]}],
    "PostToolUse":     [{"matcher": "", "hooks": [{"type": "command", "command": "python3 /path/to/ai-tools-usage-tracker/claude/scripts/log_hook.py"}]}],
    "Notification":    [{"matcher": "", "hooks": [{"type": "command", "command": "python3 /path/to/ai-tools-usage-tracker/claude/scripts/log_hook.py"}]}],
    "UserPromptSubmit":[{"matcher": "", "hooks": [{"type": "command", "command": "python3 /path/to/ai-tools-usage-tracker/claude/scripts/log_hook.py"}]}]
  }
}
```

Replace `/path/to/ai-tools-usage-tracker` with the actual path.

### 3. Build the dashboard data

```bash
npm run build
```

Then open `claude/report.html`, `codex/report.html`, or `antigravity/report.html` in your browser.

### 4. (Optional) Build and run the menu bar app

```bash
npm run menubar:build
npm run menubar
```

Or install as a launch agent so it starts automatically at login:

```bash
./install_launch_agent.sh
```

## Usage

```bash
npm run build          # One-shot build of all dashboards
npm run watch:claude   # Auto-rebuild Claude dashboard on file changes
npm test               # Run all tests
npm run menubar        # Start menu bar app (must be built first)
npm run menubar:build  # Build menu bar app
npm run menubar:restart # Restart the launchd-managed menu bar app
```

Open any provider's `report.html` in a browser after building.

## Configuration

Copy the example config (optional) to tune estimates:

```bash
cp claude/data/config.example.json claude/data/config.json
```

```json
{
  "plan": "pro",
  "extraPurchasedSeed": null,
  "extraSpentOverride": null,
  "weeklyLimitSeed": null,
  "windowLimitSeed": null
}
```

| Field | Description |
|---|---|
| `plan` | Your Claude plan: `"pro"`, `"max5x"`, or `"max20x"` — sets default usage ceilings |
| `extraPurchasedSeed` | Default extra credit purchased (USD), used as browser localStorage fallback |
| `extraSpentOverride` | Override transcript-derived extra credit spend (USD) |
| `weeklyLimitSeed` | Override estimated weekly ceiling (USD) — the [accuracy inspector](#accuracy-inspector-auto-calibration) can set this automatically |
| `windowLimitSeed` | Override estimated per-window ceiling (USD) — auto-calibrated too |

## Accuracy inspector (auto-calibration)

The menu-bar numbers are *estimates* derived from local transcripts. The `accuracy/`
subsystem periodically checks them against the **official** usage pages
(`claude.ai/settings/usage`, `chatgpt.com/codex/settings/usage`) and auto-corrects drift.

How it works:

1. A headless browser (Playwright, using a persistent logged-in profile) screenshots and
   captures the official usage pages into `accuracy/snapshots/`.
2. The local `claude` CLI is invoked headlessly to read those snapshots, extract the real
   percentages, compare them to what the tracker shows, and — if they diverge by more than a
   few points — **auto-fix**: first by recalibrating `weeklyLimitSeed`/`windowLimitSeed` in
   `claude/data/config.json`, and only for systematic errors by editing the bounded
   `PLAN_CEILINGS`/reset-hour regions of `claude/scripts/build.js`. Any code edit is reverted
   if `npm test` fails.
3. The check **reschedules itself adaptively** — frequent/large discrepancies shorten the
   interval (down to 2h), sustained accuracy lengthens it (up to a week).
4. The current verdict is surfaced in the menu bar ("Accuracy: ✓ in sync" / "⚠ off —
   auto-fixing" / "🔑 needs sign-in"), with a **Run accuracy check now** action.

One-time setup:

```bash
cd accuracy
npm i -D playwright
npx playwright install chromium
node scrape.js --login        # headed: sign into claude.ai and chatgpt.com once
cd ..
./install_launch_agent.sh     # installs the menu-bar AND accuracy launch agents
```

Run a check manually:

```bash
node accuracy/inspect.js --once --dry-run   # analyze + report only, no edits
node accuracy/inspect.js --once             # full check with auto-fix
```

The launch agent (`com.ai-tools-usage-tracker.accuracy`) fires hourly;
`accuracy/run_inspect.sh` skips runs until the adaptive `nextRunAt` is reached.

## Architecture

```
~/.claude/settings.json   hooks: PreToolUse, PostToolUse, Notification, UserPromptSubmit
        |
        v
claude/scripts/log_hook.py    Appends events to data/events.jsonl, triggers rebuild
        |
        v
claude/scripts/build.js       Reads transcripts + history + events, writes data.js
        |
        v
claude/report.html + data.js  Static dashboard, open in any browser
```

## Tests

```bash
npm test
```

39 JS tests (`claude/test/build.test.js`) + 7 Python tests (`claude/test/log_hook.test.py`).

## License

MIT

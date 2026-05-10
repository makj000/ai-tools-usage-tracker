Structure:
  ai-tracker/
    package.json              ← root scripts for both providers
    menubar/                  ← shared Swift app (Claude + Codex bars)
    claude/
      scripts/
        build.js
        log_hook.py
      data/                   ← events.jsonl, config.json, data.js
      report.html
      test/
    codex/
      scripts/
        build.js
      data/                   ← data.js
      report.html             ← new Codex dashboard
    CLAUDE.md


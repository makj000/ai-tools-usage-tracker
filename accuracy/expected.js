#!/usr/bin/env node
/**
 * expected.js — the numbers the tracker currently SHOWS in the menu bar.
 *
 * Reads the same per-provider menubar JSON the Swift app reads
 * (~/.claude/<provider>-tracker-menubar.json) so the accuracy comparison is
 * apples-to-apples with what the user actually sees. Emits a normalized object:
 *
 *   { claude: { window: {pct, usageDisplay, label, ceilingDisplay},
 *               weekly: {...} }, codex: { ... } }
 *
 * Run directly to print JSON; require() to get expectedMetrics().
 */
const fs = require("fs");
const { PROVIDERS } = require("./lib/paths");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function normMetric(m) {
  if (!m) return null;
  return {
    // pct is 0..1 in the menubar json; expose as 0..100 percentage points.
    pct: typeof m.pct === "number" ? +(m.pct * 100).toFixed(2) : null,
    usage: typeof m.usage === "number" ? m.usage : null,
    ceiling: typeof m.ceiling === "number" ? m.ceiling : null,
    usageDisplay: m.usageDisplay ?? null,
    ceilingDisplay: m.ceilingDisplay ?? null,
  };
}

function expectedMetrics() {
  const out = {};
  for (const p of PROVIDERS) {
    const data = readJson(p.menubarJson);
    out[p.key] = {
      label: p.label,
      source: p.menubarJson,
      updatedAt: data?.updatedAt ?? null,
      window: data ? normMetric(data.primary ?? data.window) : null,
      weekly: data ? normMetric(data.secondary ?? data.weekly) : null,
      windowLabel: data?.primaryLabel ?? "5h used",
      weeklyLabel: data?.secondaryLabel ?? "Week used",
      available: !!data,
    };
  }
  return out;
}

if (require.main === module) {
  console.log(JSON.stringify(expectedMetrics(), null, 2));
}

module.exports = { expectedMetrics };

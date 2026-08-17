#!/usr/bin/env node
/**
 * Tests for scripts/build.js internals.
 * Run: node test/build.test.js
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const {
  getPricing, calcCost, zeroCounts, addCounts, slugToPath,
  isRealPrompt, extractPromptText, enrichHistory, readJsonl,
  buildMenubarData, applyUsageConfig, buildModelAlert,
} = require("../scripts/build.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

// ---- getPricing ----
console.log("\ngetPricing");

test("returns sonnet pricing for sonnet model", () => {
  const p = getPricing("claude-sonnet-4-6-20260401");
  assert.strictEqual(p.input, 3.0);
  assert.strictEqual(p.output, 15.0);
});

test("returns opus pricing for opus model", () => {
  const p = getPricing("claude-opus-4-6-20260401");
  assert.strictEqual(p.input, 15.0);
  assert.strictEqual(p.output, 75.0);
});

test("returns fable pricing for fable model", () => {
  const p = getPricing("claude-fable-5");
  assert.strictEqual(p.input, 10.0);
  assert.strictEqual(p.output, 50.0);
  assert.strictEqual(p.cacheWrite, 12.50);
  assert.strictEqual(p.cacheRead, 1.00);
});

test("returns haiku pricing for haiku model", () => {
  const p = getPricing("claude-haiku-4-5-20251001");
  assert.strictEqual(p.input, 0.80);
});

test("returns default pricing for unknown model", () => {
  const p = getPricing("claude-mystery-99");
  assert.strictEqual(p.input, 3.0);
});

test("returns default pricing for null model", () => {
  const p = getPricing(null);
  assert.strictEqual(p.input, 3.0);
});

console.log("\nbuildModelAlert");

test("alerts for recent Claude expensive models", () => {
  const nowSec = Math.floor(Date.parse("2026-08-17T18:00:00.000Z") / 1000);
  const alert = buildModelAlert([
    {
      model: "claude-opus-4-6-20260401",
      project: "ai/tracker",
      lastTs: "2026-08-17T17:45:00.000Z",
    },
  ], { nowSec });

  assert.strictEqual(alert.active, true);
  assert.strictEqual(alert.model, "claude-opus-4-6-20260401");
  assert.strictEqual(alert.project, "ai/tracker");
});

test("ignores stale Claude expensive models", () => {
  const nowSec = Math.floor(Date.parse("2026-08-17T18:00:00.000Z") / 1000);
  const alert = buildModelAlert([
    {
      model: "claude-fable-5",
      project: "ai/tracker",
      lastTs: "2026-08-17T12:00:00.000Z",
    },
  ], { nowSec });

  assert.strictEqual(alert, null);
});

// ---- calcCost ----
console.log("\ncalcCost");

test("calculates cost correctly for sonnet", () => {
  const usage = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const cost = calcCost(usage, "claude-sonnet-4-6");
  // (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1e6 = 0.0105
  assert.strictEqual(Math.round(cost * 1e6), 10500);
});

test("calculates cost with cache tokens", () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000 };
  const cost = calcCost(usage, "claude-sonnet-4-6");
  // 1M * 3.75 + 2M * 0.30 = 3.75 + 0.60 = 4.35
  assert.strictEqual(Math.round(cost * 100), 435);
});

test("handles missing usage fields gracefully", () => {
  const cost = calcCost({}, "claude-sonnet-4-6");
  assert.strictEqual(cost, 0);
});

test("handles zero tokens", () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  assert.strictEqual(calcCost(usage, "claude-sonnet-4-6"), 0);
});

// ---- zeroCounts / addCounts ----
console.log("\nzeroCounts / addCounts");

test("zeroCounts returns all zeros", () => {
  const c = zeroCounts();
  assert.strictEqual(c.input_tokens, 0);
  assert.strictEqual(c.output_tokens, 0);
  assert.strictEqual(c.cache_creation_input_tokens, 0);
  assert.strictEqual(c.cache_read_input_tokens, 0);
  assert.strictEqual(c.messages, 0);
});

test("addCounts accumulates usage", () => {
  const target = zeroCounts();
  addCounts(target, { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 });
  assert.strictEqual(target.input_tokens, 10);
  assert.strictEqual(target.output_tokens, 20);
  assert.strictEqual(target.cache_creation_input_tokens, 30);
  assert.strictEqual(target.cache_read_input_tokens, 40);
  assert.strictEqual(target.messages, 1);
});

test("addCounts accumulates multiple calls", () => {
  const target = zeroCounts();
  addCounts(target, { input_tokens: 5, output_tokens: 10 });
  addCounts(target, { input_tokens: 3, output_tokens: 7 });
  assert.strictEqual(target.input_tokens, 8);
  assert.strictEqual(target.output_tokens, 17);
  assert.strictEqual(target.messages, 2);
});

test("addCounts handles missing fields", () => {
  const target = zeroCounts();
  addCounts(target, {});
  assert.strictEqual(target.input_tokens, 0);
  assert.strictEqual(target.messages, 1);
});

// ---- slugToPath ----
console.log("\nslugToPath");

test("converts slug to path", () => {
  assert.strictEqual(slugToPath("-Users-kma-dev-project"), "Users/kma/dev/project");
});

test("handles single segment", () => {
  assert.strictEqual(slugToPath("-foo"), "foo");
});

// ---- isRealPrompt ----
console.log("\nisRealPrompt");

test("accepts user entry with string content", () => {
  assert.strictEqual(isRealPrompt({ type: "user", message: { content: "hello" } }), true);
});

test("rejects empty string content", () => {
  assert.strictEqual(isRealPrompt({ type: "user", message: { content: "" } }), false);
});

test("rejects non-user type", () => {
  assert.strictEqual(isRealPrompt({ type: "assistant", message: { content: "hello" } }), false);
});

test("rejects sidechain entries", () => {
  assert.strictEqual(isRealPrompt({ type: "user", isSidechain: true, message: { content: "hello" } }), false);
});

test("rejects compact summary entries", () => {
  assert.strictEqual(isRealPrompt({ type: "user", isCompactSummary: true, message: { content: "hello" } }), false);
});

test("rejects tool_result array content", () => {
  const entry = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "x", content: "output" }] },
  };
  assert.strictEqual(isRealPrompt(entry), false);
});

test("accepts array content with text type", () => {
  const entry = {
    type: "user",
    message: { content: [{ type: "text", text: "hello world" }] },
  };
  assert.strictEqual(isRealPrompt(entry), true);
});

test("accepts mixed array with text and tool_result", () => {
  const entry = {
    type: "user",
    message: { content: [
      { type: "tool_result", tool_use_id: "x", content: "output" },
      { type: "text", text: "continue" },
    ]},
  };
  assert.strictEqual(isRealPrompt(entry), true);
});

test("rejects entry with no message", () => {
  assert.strictEqual(isRealPrompt({ type: "user" }), false);
});

test("rejects entry with null content", () => {
  assert.strictEqual(isRealPrompt({ type: "user", message: { content: null } }), false);
});

// ---- extractPromptText ----
console.log("\nextractPromptText");

test("extracts string content", () => {
  assert.strictEqual(extractPromptText({ message: { content: "hello" } }), "hello");
});

test("extracts text from array content", () => {
  const entry = { message: { content: [{ type: "text", text: "world" }] } };
  assert.strictEqual(extractPromptText(entry), "world");
});

test("extracts text part from mixed array", () => {
  const entry = { message: { content: [
    { type: "tool_result", content: "output" },
    { type: "text", text: "follow up" },
  ]}};
  assert.strictEqual(extractPromptText(entry), "follow up");
});

test("returns empty string for tool_result only array", () => {
  const entry = { message: { content: [{ type: "tool_result", content: "x" }] } };
  assert.strictEqual(extractPromptText(entry), "");
});

test("returns empty string for missing message", () => {
  assert.strictEqual(extractPromptText({}), "");
});

// ---- enrichHistory ----
console.log("\nenrichHistory");

test("matches history to prompts by sessionId and text", () => {
  const history = [
    { sessionId: "s1", display: "hello", timestamp: 1000 },
    { sessionId: "s1", display: "world", timestamp: 2000 },
  ];
  const prompts = [
    { sessionId: "s1", text: "hello", ts: "2026-01-01T00:00:00Z", cost: 0.05, turns: 3, counts: zeroCounts() },
    { sessionId: "s1", text: "world", ts: "2026-01-01T00:01:00Z", cost: 0.10, turns: 5, counts: zeroCounts() },
  ];
  const result = enrichHistory(history, prompts);
  assert.strictEqual(result.matched, 2);
  assert.strictEqual(result.unmatched, 0);
  assert.strictEqual(history[0].cost, 0.05);
  assert.strictEqual(history[0].turns, 3);
  assert.strictEqual(history[1].cost, 0.10);
  assert.strictEqual(history[1].turns, 5);
});

test("unmatched history entries have no cost", () => {
  const history = [
    { sessionId: "s1", display: "orphan", timestamp: 1000 },
  ];
  const prompts = [];
  const result = enrichHistory(history, prompts);
  assert.strictEqual(result.matched, 0);
  assert.strictEqual(result.unmatched, 1);
  assert.strictEqual(history[0].cost, undefined);
});

test("handles duplicate prompt text in same session", () => {
  const history = [
    { sessionId: "s1", display: "yes", timestamp: 1000 },
    { sessionId: "s1", display: "yes", timestamp: 2000 },
  ];
  const prompts = [
    { sessionId: "s1", text: "yes", ts: "2026-01-01T00:00:00Z", cost: 0.01, turns: 1, counts: zeroCounts() },
    { sessionId: "s1", text: "yes", ts: "2026-01-01T00:01:00Z", cost: 0.02, turns: 2, counts: zeroCounts() },
  ];
  const result = enrichHistory(history, prompts);
  assert.strictEqual(result.matched, 2);
  // First "yes" gets the earlier prompt (0.01), second gets the later (0.02)
  assert.strictEqual(history[0].cost, 0.01);
  assert.strictEqual(history[1].cost, 0.02);
});

test("does not cross-match between sessions", () => {
  const history = [
    { sessionId: "s1", display: "hello", timestamp: 1000 },
    { sessionId: "s2", display: "hello", timestamp: 2000 },
  ];
  const prompts = [
    { sessionId: "s1", text: "hello", ts: "2026-01-01T00:00:00Z", cost: 0.05, turns: 1, counts: zeroCounts() },
  ];
  const result = enrichHistory(history, prompts);
  assert.strictEqual(result.matched, 1);
  assert.strictEqual(result.unmatched, 1);
  assert.strictEqual(history[0].cost, 0.05);
  assert.strictEqual(history[1].cost, undefined);
});

test("matches using first 200 chars of text", () => {
  const longText = "a".repeat(300);
  const history = [{ sessionId: "s1", display: longText, timestamp: 1000 }];
  const prompts = [{ sessionId: "s1", text: longText, ts: "2026-01-01T00:00:00Z", cost: 0.1, turns: 2, counts: zeroCounts() }];
  const result = enrichHistory(history, prompts);
  assert.strictEqual(result.matched, 1);
  assert.strictEqual(history[0].cost, 0.1);
});

// ---- readJsonl ----
console.log("\nreadJsonl");

test("returns empty array for non-existent file", () => {
  assert.deepStrictEqual(readJsonl("/tmp/nonexistent_test_file_" + Date.now() + ".jsonl"), []);
});

test("reads valid jsonl file", () => {
  const tmp = path.join(os.tmpdir(), `test-readjsonl-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, '{"a":1}\n{"b":2}\n');
  try {
    const result = readJsonl(tmp);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], { a: 1 });
    assert.deepStrictEqual(result[1], { b: 2 });
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("skips malformed lines", () => {
  const tmp = path.join(os.tmpdir(), `test-readjsonl-bad-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, '{"a":1}\nnot json\n{"b":2}\n');
  try {
    const result = readJsonl(tmp);
    assert.strictEqual(result.length, 2);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("handles empty file", () => {
  const tmp = path.join(os.tmpdir(), `test-readjsonl-empty-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, '');
  try {
    assert.deepStrictEqual(readJsonl(tmp), []);
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ---- buildMenubarData ----
console.log("\nbuildMenubarData");

test("keeps reset times when 5h and weekly windows have usage", () => {
  const nowSec = Math.floor(Date.parse("2026-06-19T16:00:00.000Z") / 1000);
  const fiveHourReset = nowSec + 90 * 60;
  const weeklyReset = nowSec + 3 * 24 * 60 * 60;
  const data = buildMenubarData(null, { cost: 12.34567 }, 20, {
    nowSec,
    rateLimits: {
      five_hour: { used_percentage: 34, resets_at: fiveHourReset },
      seven_day: { used_percentage: 57, resets_at: weeklyReset },
    },
  });

  assert.strictEqual(data.primaryLabel, "5h used");
  assert.strictEqual(data.primary.usageDisplay, "34% used");
  assert.strictEqual(data.primary.pct, 0.34);
  assert.strictEqual(data.primary.startEpoch, fiveHourReset - 5 * 3600);
  assert.strictEqual(data.primary.endEpoch, fiveHourReset);
  assert.match(data.primary.detail, /^resets /);
  assert.strictEqual(data.primary.isRemaining, false);
  assert.strictEqual(data.secondaryLabel, "Week used");
  assert.strictEqual(data.secondary.usageDisplay, "57% used");
  assert.strictEqual(data.secondary.pct, 0.57);
  assert.strictEqual(data.secondary.endEpoch, weeklyReset);
  assert.match(data.secondary.detail, /^resets /);
  assert.strictEqual(data.secondary.isRemaining, false);
  assert.strictEqual(data.weeklyCycle.totalDots, 7);
  assert(data.weeklyCycle.activeDots >= 1);
  assert.strictEqual(data.weeklyCycle.resetEpoch, weeklyReset);
  assert.strictEqual(data.extraSpent, 12.3457);
  assert.strictEqual(data.extraPurchased, 20);
});

test("passes through usageCreditsBalance and usageCreditsUrl when set", () => {
  const data = buildMenubarData(null, { cost: 0 }, null, {
    nowSec: 1_000_000,
    usageCreditsBalance: 101.7234,
    usageCreditsUrl: "https://claude.ai/settings/usage",
  });
  assert.strictEqual(data.usageCreditsBalance, 101.7234);
  assert.strictEqual(data.usageCreditsUrl, "https://claude.ai/settings/usage");
});

test("falls back to reconciliationUrl for existing configs", () => {
  const data = buildMenubarData(null, { cost: 0 }, null, {
    nowSec: 1_000_000,
    usageCreditsBalance: 101.7234,
    reconciliationUrl: "https://claude.ai/code/artifact/example",
  });
  assert.strictEqual(data.usageCreditsUrl, "https://claude.ai/code/artifact/example");
});

test("omits usageCreditsBalance and usageCreditsUrl when unset", () => {
  const data = buildMenubarData(null, { cost: 0 }, null, { nowSec: 1_000_000 });
  assert.strictEqual(data.usageCreditsBalance, null);
  assert.strictEqual(data.usageCreditsUrl, null);
});

// ---- Summary ----
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

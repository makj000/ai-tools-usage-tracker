#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildDaily,
  buildMenubarData,
  buildProjects,
  parseDurationSeconds,
  readConversationStorage,
  readQuotaState,
} = require("../scripts/build.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

console.log("\nactivity");

test("groups prompts by project and day", () => {
  const history = [
    { display: "one", timestamp: Date.parse("2026-06-10T16:00:00Z"), workspace: "/tmp/a", conversationId: "c1" },
    { display: "two", timestamp: Date.parse("2026-06-10T17:00:00Z"), workspace: "/tmp/a", conversationId: "c1" },
    { display: "three", timestamp: Date.parse("2026-06-11T17:00:00Z"), workspace: "/tmp/b", conversationId: "c2" },
  ];
  const projects = buildProjects(history);
  const daily = buildDaily(history);
  assert.strictEqual(projects.length, 2);
  assert.strictEqual(projects[0].prompts, 2);
  assert.strictEqual(projects[0].conversationCount, 1);
  assert.strictEqual(daily.length, 2);
  assert.strictEqual(daily[0].prompts, 2);
});

console.log("\nquota");

test("parses reset durations", () => {
  assert.strictEqual(parseDurationSeconds("Resets in 103h15m12s."), 371712);
  assert.strictEqual(parseDurationSeconds("Resets in 45m2s."), 2702);
});

test("reads the latest active quota exhaustion", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-log-"));
  const file = path.join(dir, "cli-20260611_100000.log");
  fs.writeFileSync(file, [
    "E0611 10:16:28.123005 1 log.go:398] RESOURCE_EXHAUSTED: Individual quota reached. Resets in 103h15m12s.",
    "E0611 10:16:49.055667 1 log.go:398] RESOURCE_EXHAUSTED: Individual quota reached. Resets in 103h14m51s.",
  ].join("\n"));
  const nowSec = Math.floor(new Date(2026, 5, 11, 10, 17, 0).getTime() / 1000);
  const quota = readQuotaState(dir, nowSec);
  assert.strictEqual(quota.exhausted, true);
  assert.strictEqual(quota.resetEpoch, Math.floor(new Date(2026, 5, 15, 17, 31, 40).getTime() / 1000));
});

console.log("\nbuildMenubarData");

test("shows weekly reset and omits 5h metric for weekly-only quota", () => {
  const resetEpoch = Math.floor(new Date(2026, 5, 15, 17, 31, 40).getTime() / 1000);
  const data = buildMenubarData({
    exhausted: true,
    resetEpoch,
    observedAt: Math.floor(new Date(2026, 5, 11, 10, 16, 49).getTime() / 1000),
  });

  assert.strictEqual(data.primaryLabel, null);
  assert.strictEqual(data.primary, null);
  assert.strictEqual(data.secondaryLabel, "weekly");
  assert.strictEqual(data.secondary.usageDisplay, "100% used");
  assert.strictEqual(data.secondary.pct, 1);
  assert.strictEqual(data.secondary.endEpoch, resetEpoch);
  assert.strictEqual(data.secondary.isRemaining, false);
  assert.deepStrictEqual(data.secondary, data.weekly);
});

test("shows no weekly metric before a quota reset is known", () => {
  const data = buildMenubarData({ exhausted: false, resetEpoch: null, observedAt: null });
  assert.strictEqual(data.primary, null);
  assert.strictEqual(data.secondary, null);
  assert.strictEqual(data.weekly, null);
});

console.log("\nstorage");

test("counts conversation databases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-db-"));
  fs.writeFileSync(path.join(dir, "a.db"), "1234");
  fs.writeFileSync(path.join(dir, "b.db"), "12");
  fs.writeFileSync(path.join(dir, "ignore.txt"), "x");
  assert.deepStrictEqual(readConversationStorage(dir), { databaseCount: 2, totalBytes: 6 });
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

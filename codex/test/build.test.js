#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildDailyActivity,
  buildMenubarData,
  buildProjects,
  buildOverview,
  formatProjectLabel,
  groupPromptsBySession,
  readChatGPTDesktopActivity,
  shortProjectName,
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

console.log("\nformatProjectLabel");

test("formats home-relative cwd", () => {
  assert.strictEqual(formatProjectLabel("/Users/kma/dev/ai-agent", "/Users/kma"), "~/dev/ai-agent");
});

test("formats home directory as tilde", () => {
  assert.strictEqual(formatProjectLabel("/Users/kma", "/Users/kma"), "~");
});

console.log("\nshortProjectName");

test("uses the last two path segments", () => {
  assert.strictEqual(shortProjectName("/Users/kma/dev/tools-bots/claude-tracker"), "tools-bots/claude-tracker");
});

console.log("\ngroupPromptsBySession");

test("groups prompts and tracks the last prompt", () => {
  const grouped = groupPromptsBySession([
    { session_id: "a", ts: 100, text: "first" },
    { session_id: "a", ts: 120, text: "second" },
    { session_id: "b", ts: 90, text: "other" },
  ]);
  assert.strictEqual(grouped.get("a").count, 2);
  assert.strictEqual(grouped.get("a").lastPrompt, "second");
  assert.strictEqual(grouped.get("b").count, 1);
});

console.log("\nbuildProjects");

test("aggregates threads by cwd", () => {
  const projects = buildProjects([
    {
      cwd: "/tmp/a",
      projectLabel: "~/tmp/a",
      shortProject: "tmp/a",
      model: "gpt-5.4",
      tokensUsed: 100,
      promptCount: 2,
      updatedAt: "2026-05-01T00:00:00.000Z",
      updatedAtEpochMs: 1000,
    },
    {
      cwd: "/tmp/a",
      projectLabel: "~/tmp/a",
      shortProject: "tmp/a",
      model: "gpt-5.5",
      tokensUsed: 150,
      promptCount: 1,
      updatedAt: "2026-05-02T00:00:00.000Z",
      updatedAtEpochMs: 2000,
    },
  ]);
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].threadCount, 2);
  assert.strictEqual(projects[0].promptCount, 3);
  assert.strictEqual(projects[0].totalTokens, 250);
  assert.deepStrictEqual(projects[0].models, ["gpt-5.4", "gpt-5.5"]);
});

console.log("\nbuildDailyActivity / buildOverview");

test("computes daily counts and overview totals", () => {
  const threads = [
    { updatedAtEpochMs: Date.parse("2026-05-01T12:00:00Z"), tokensUsed: 100 },
    { updatedAtEpochMs: Date.parse("2026-05-02T12:00:00Z"), tokensUsed: 300 },
  ];
  const history = [
    { ts: Math.floor(Date.parse("2026-05-01T13:00:00Z") / 1000), text: "hello" },
    { ts: Math.floor(Date.parse("2026-05-02T13:00:00Z") / 1000), text: "world" },
  ];
  const daily = buildDailyActivity(threads, history);
  const overview = buildOverview(threads, history, [{}, {}]);
  assert.strictEqual(daily.length, 2);
  assert.strictEqual(overview.threadCount, 2);
  assert.strictEqual(overview.projectCount, 2);
  assert.strictEqual(overview.promptCount, 2);
  assert.strictEqual(overview.totalTokens, 400);
});

console.log("\nreadChatGPTDesktopActivity");

test("summarizes desktop conversation blobs by workspace and day", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-desktop-"));
  const firstWorkspace = path.join(baseDir, "conversations-v3-workspace-a");
  const nestedRoot = path.join(baseDir, "project-g-p-123");
  const secondWorkspace = path.join(nestedRoot, "conversations-v3-workspace-b");
  fs.mkdirSync(firstWorkspace, { recursive: true });
  fs.mkdirSync(secondWorkspace, { recursive: true });

  const fileA = path.join(firstWorkspace, "a.data");
  const fileB = path.join(firstWorkspace, "b.data");
  const fileC = path.join(secondWorkspace, "c.data");
  fs.writeFileSync(fileA, "alpha");
  fs.writeFileSync(fileB, "beta");
  fs.writeFileSync(fileC, "gamma");

  const morning = new Date("2026-05-04T16:00:00.000Z");
  const evening = new Date("2026-05-05T16:00:00.000Z");
  fs.utimesSync(fileA, morning, morning);
  fs.utimesSync(fileB, evening, evening);
  fs.utimesSync(fileC, evening, evening);

  const summary = readChatGPTDesktopActivity(baseDir);
  assert.strictEqual(summary.workspaceCount, 2);
  assert.strictEqual(summary.blobCount, 3);
  assert.strictEqual(summary.daily.length, 2);
  assert.strictEqual(summary.workspaces[0].workspaceId, "workspace-a");
  assert.strictEqual(summary.workspaces[0].fileCount, 2);
  assert.strictEqual(summary.workspaces[0].lastActivityAt, evening.toISOString());
  assert.strictEqual(summary.lastActivityAt, evening.toISOString());
});

console.log("\nbuildMenubarData");

test("shows 5h and weekly window ends when current usage is zero", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const primaryResetEpoch = nowSec + 2 * 60 * 60;
  const secondaryResetEpoch = nowSec + 4 * 24 * 60 * 60;
  const data = buildMenubarData([], {
    nowSec,
    rateLimits: {
      primary: { used_percent: 0, resets_at: primaryResetEpoch },
      secondary: { used_percent: 0, resets_at: secondaryResetEpoch },
    },
  });

  assert.strictEqual(data.primaryLabel, "5h left");
  assert.strictEqual(data.primary.usageDisplay, "100% left");
  assert.strictEqual(data.primary.pct, 1);
  assert.strictEqual(data.primary.endEpoch, primaryResetEpoch);
  assert.match(data.primary.detail, /^resets /);
  assert.strictEqual(data.secondaryLabel, "Week left");
  assert.strictEqual(data.secondary.usageDisplay, "100% left");
  assert.strictEqual(data.secondary.pct, 1);
  assert.strictEqual(data.secondary.endEpoch, secondaryResetEpoch);
  assert.match(data.secondary.detail, /^resets /);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

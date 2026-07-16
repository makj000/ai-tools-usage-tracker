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
    officialUsage: null,
    rateLimits: {
      primary: { used_percent: 0, resets_at: primaryResetEpoch },
      secondary: { used_percent: 0, resets_at: secondaryResetEpoch },
    },
  });

  assert.strictEqual(data.primaryLabel, "5h used");
  assert.strictEqual(data.primary.usageDisplay, "0% used");
  assert.strictEqual(data.primary.pct, 0);
  assert.strictEqual(data.primary.endEpoch, primaryResetEpoch);
  assert.match(data.primary.detail, /^resets /);
  assert.strictEqual(data.primary.isRemaining, false);
  assert.strictEqual(data.secondaryLabel, "Week used");
  assert.strictEqual(data.secondary.usageDisplay, "0% used");
  assert.strictEqual(data.secondary.pct, 0);
  assert.strictEqual(data.secondary.endEpoch, secondaryResetEpoch);
  assert.match(data.secondary.detail, /^resets /);
  assert.strictEqual(data.secondary.isRemaining, false);
});

test("keeps reset times when 5h and weekly windows have nonzero usage", () => {
  const nowSec = Math.floor(Date.parse("2026-06-19T16:00:00.000Z") / 1000);
  const primaryResetEpoch = nowSec + 90 * 60;
  const secondaryResetEpoch = nowSec + 3 * 24 * 60 * 60;
  const data = buildMenubarData([], {
    nowSec,
    officialUsage: null,
    rateLimits: {
      primary: { used_percent: 34, resets_at: primaryResetEpoch },
      secondary: { used_percent: 57, resets_at: secondaryResetEpoch },
    },
  });

  assert.strictEqual(data.primaryLabel, "5h used");
  assert.strictEqual(data.primary.usageDisplay, "34% used");
  assert(Math.abs(data.primary.pct - 0.34) < 0.000001);
  assert.strictEqual(data.primary.endEpoch, primaryResetEpoch);
  assert.match(data.primary.detail, /^resets /);
  assert.strictEqual(data.primary.isRemaining, false);
  assert.strictEqual(data.secondaryLabel, "Week used");
  assert.strictEqual(data.secondary.usageDisplay, "57% used");
  assert(Math.abs(data.secondary.pct - 0.57) < 0.000001);
  assert.strictEqual(data.secondary.endEpoch, secondaryResetEpoch);
  assert.match(data.secondary.detail, /^resets /);
  assert.strictEqual(data.secondary.isRemaining, false);
});

test("projects a stale 5h reset forward so the menu still has a window end", () => {
  const nowSec = Math.floor(Date.parse("2026-06-19T16:30:00.000Z") / 1000);
  const staleResetEpoch = Math.floor(Date.parse("2026-06-19T12:00:00.000Z") / 1000);
  const data = buildMenubarData([], {
    nowSec,
    officialUsage: null,
    rateLimits: {
      primary: { used_percent: 44, resets_at: staleResetEpoch },
      secondary: null,
    },
  });

  assert.strictEqual(data.primary.endEpoch, Math.floor(Date.parse("2026-06-19T17:00:00.000Z") / 1000));
  assert.strictEqual(data.primary.startEpoch, Math.floor(Date.parse("2026-06-19T12:00:00.000Z") / 1000));
  assert.match(data.primary.detail, /^resets /);
});

test("ignores impossible future primary reset for the 5h window", () => {
  const nowSec = Math.floor(Date.parse("2026-07-14T05:40:00.000Z") / 1000);
  const impossibleResetEpoch = nowSec + 134 * 60 * 60;
  const data = buildMenubarData([], {
    nowSec,
    officialUsage: null,
    rateLimits: {
      primary: { used_percent: 67, resets_at: impossibleResetEpoch },
      secondary: null,
    },
  });

  assert.strictEqual(data.primaryLabel, "Today");
  assert.strictEqual(data.primary, null);
});

test("treats 10080-minute primary limit as weekly and leaves 5h empty", () => {
  const nowSec = Math.floor(Date.parse("2026-07-14T05:40:00.000Z") / 1000);
  const weeklyResetEpoch = nowSec + 134 * 60 * 60;
  const data = buildMenubarData([], {
    nowSec,
    officialUsage: null,
    rateLimits: {
      primary: { used_percent: 67, window_minutes: 10080, resets_at: weeklyResetEpoch },
      secondary: null,
    },
  });

  assert.strictEqual(data.primary, null);
  assert.strictEqual(data.secondaryLabel, "Week used");
  assert.strictEqual(data.secondary.usageDisplay, "67% used");
  assert.strictEqual(data.secondary.endEpoch, weeklyResetEpoch);
  assert.match(data.secondary.detail, /^resets /);
});

test("falls back to local today usage when only a weekly official limit is present and no 5h window exists", () => {
  const nowSec = Math.floor(Date.parse("2026-07-14T19:40:00.000Z") / 1000);
  const weeklyResetEpoch = nowSec + 134 * 60 * 60;
  const data = buildMenubarData([
    { date: "2026-07-14", threads: 2, prompts: 8, tokens: 1200 },
  ], {
    nowSec,
    officialUsage: null,
    rateLimits: {
      primary: { used_percent: 67, window_minutes: 10080, resets_at: weeklyResetEpoch },
      secondary: null,
    },
  });

  assert.strictEqual(data.primaryLabel, "Today");
  assert.strictEqual(data.primary.usageDisplay, "1.2K tok");
  assert.strictEqual(data.primary.pct, null);
  assert.strictEqual(data.primary.ceiling, null);
  assert.strictEqual(data.primary.detail, "8 prompts");
  assert.strictEqual(data.secondaryLabel, "Week used");
  assert.strictEqual(data.secondary.usageDisplay, "67% used");
});

test("estimates 5h percent from local recent thread activity", () => {
  const nowSec = Math.floor(Date.parse("2026-07-14T19:40:00.000Z") / 1000);
  const weeklyResetEpoch = nowSec + 134 * 60 * 60;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
  const rolloutPath = path.join(tmpDir, "rollout-test.jsonl");
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: new Date((nowSec - 60 * 60) * 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 200 } },
      },
    }),
    JSON.stringify({
      timestamp: new Date((nowSec - 6 * 60 * 60) * 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 400 } },
      },
    }),
  ].join("\n") + "\n");
  const data = buildMenubarData([
    { date: "2026-07-14", threads: 2, prompts: 8, tokens: 1200 },
  ], {
    nowSec,
    officialUsage: null,
    threads: [
      { rolloutPath },
    ],
    rateLimits: {
      primary: { used_percent: 67, window_minutes: 10080, resets_at: weeklyResetEpoch },
      secondary: null,
    },
  });

  assert.strictEqual(data.primaryLabel, "5h used");
  assert.strictEqual(data.primary.usage, 200);
  assert.strictEqual(data.primary.ceiling, 400);
  assert.strictEqual(data.primary.pct, 0.5);
  assert.strictEqual(data.primary.usageDisplay, "50% est.");
  assert.strictEqual(data.primary.detail, "estimated from local 5h activity");
});

test("keeps Codex 5h percentage output when only a projected window exists", () => {
  const nowSec = Math.floor(Date.parse("2026-07-14T19:40:00.000Z") / 1000);
  const staleFiveHourReset = Math.floor(Date.parse("2026-07-14T17:00:00.000Z") / 1000);
  const weeklyResetEpoch = nowSec + 134 * 60 * 60;
  const data = buildMenubarData([
    { date: "2026-07-14", threads: 2, prompts: 8, tokens: 1200 },
  ], {
    nowSec,
    officialUsage: null,
    fiveHourResetAnchor: staleFiveHourReset,
    threads: [],
    rateLimits: {
      primary: { used_percent: 67, window_minutes: 10080, resets_at: weeklyResetEpoch },
      secondary: null,
    },
  });

  assert.strictEqual(data.primaryLabel, "5h used");
  assert.strictEqual(data.primary.usageDisplay, "0% est.");
  assert.strictEqual(data.primary.pct, 0);
  assert.strictEqual(data.primary.ceiling, 100);
  assert.strictEqual(data.primary.startEpoch, Math.floor(Date.parse("2026-07-14T17:00:00.000Z") / 1000));
  assert.strictEqual(data.primary.endEpoch, Math.floor(Date.parse("2026-07-14T22:00:00.000Z") / 1000));
  assert.match(data.primary.detail, /^resets /);
});

test("projects a 5h reset window for estimated local usage", () => {
  const nowSec = Math.floor(Date.parse("2026-07-14T19:40:00.000Z") / 1000);
  const staleFiveHourReset = Math.floor(Date.parse("2026-07-14T17:00:00.000Z") / 1000);
  const weeklyResetEpoch = nowSec + 134 * 60 * 60;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
  const rolloutPath = path.join(tmpDir, "rollout-test.jsonl");
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: new Date((nowSec - 60 * 60) * 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 200 } },
        rate_limits: {
          primary: { used_percent: 12, window_minutes: 300, resets_at: staleFiveHourReset },
        },
      },
    }),
  ].join("\n") + "\n");
  const data = buildMenubarData([
    { date: "2026-07-14", threads: 2, prompts: 8, tokens: 1200 },
  ], {
    nowSec,
    officialUsage: null,
    threads: [
      { rolloutPath },
    ],
    rateLimits: {
      primary: { used_percent: 67, window_minutes: 10080, resets_at: weeklyResetEpoch },
      secondary: null,
    },
  });

  assert.strictEqual(data.primary.startEpoch, Math.floor(Date.parse("2026-07-14T17:00:00.000Z") / 1000));
  assert.strictEqual(data.primary.endEpoch, Math.floor(Date.parse("2026-07-14T22:00:00.000Z") / 1000));
  assert.match(data.primary.detail, /^resets /);
});

test("calibrates estimated 5h percent from historical official samples", () => {
  const nowSec = Math.floor(Date.parse("2026-07-14T19:40:00.000Z") / 1000);
  const priorResetEpoch = nowSec - 4 * 60 * 60;
  const weeklyResetEpoch = nowSec + 134 * 60 * 60;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
  const rolloutPath = path.join(tmpDir, "rollout-test.jsonl");
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: new Date((nowSec - 6 * 60 * 60) * 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 200 } },
        rate_limits: {
          primary: { used_percent: 20, window_minutes: 300, resets_at: priorResetEpoch },
        },
      },
    }),
    JSON.stringify({
      timestamp: new Date((nowSec - 60 * 60) * 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 500 } },
      },
    }),
  ].join("\n") + "\n");
  const data = buildMenubarData([
    { date: "2026-07-14", threads: 2, prompts: 8, tokens: 1200 },
  ], {
    nowSec,
    officialUsage: null,
    threads: [
      { rolloutPath },
    ],
    rateLimits: {
      primary: { used_percent: 67, window_minutes: 10080, resets_at: weeklyResetEpoch },
      secondary: null,
    },
  });

  assert.strictEqual(data.primary.usage, 500);
  assert.strictEqual(data.primary.ceiling, 1000);
  assert.strictEqual(data.primary.pct, 0.5);
  assert.strictEqual(data.primary.usageDisplay, "50% est.");
});

test("prefers official usage page 5h remaining over local estimates", () => {
  const nowSec = Math.floor(Date.parse("2026-07-14T19:40:00.000Z") / 1000);
  const fiveHourReset = nowSec + 2 * 60 * 60;
  const weeklyReset = nowSec + 4 * 24 * 60 * 60;
  const data = buildMenubarData([
    { date: "2026-07-14", threads: 2, prompts: 8, tokens: 1200 },
  ], {
    nowSec,
    officialUsage: {
      fiveHour: { pct: 94, isRemaining: true, resetEpoch: fiveHourReset },
      weekly: { pct: 88, isRemaining: true, resetEpoch: weeklyReset },
    },
    rateLimits: null,
  });

  assert.strictEqual(data.primaryLabel, "5h used");
  assert.strictEqual(data.primary.usageDisplay, "94% remaining");
  assert.strictEqual(data.primary.pct, 0.94);
  assert.strictEqual(data.primary.isRemaining, true);
  assert.strictEqual(data.primary.startEpoch, fiveHourReset - 5 * 60 * 60);
  assert.strictEqual(data.primary.endEpoch, fiveHourReset);
  assert.strictEqual(data.secondaryLabel, "Week used");
  assert.strictEqual(data.secondary.usageDisplay, "88% remaining");
  assert.strictEqual(data.secondary.pct, 0.88);
  assert.strictEqual(data.secondary.isRemaining, true);
  assert.strictEqual(data.secondary.endEpoch, weeklyReset);
});

test("caps estimated 5h percent below 100 when calibration is exceeded", () => {
  const nowSec = Math.floor(Date.parse("2026-07-14T19:40:00.000Z") / 1000);
  const priorResetEpoch = nowSec - 4 * 60 * 60;
  const weeklyResetEpoch = nowSec + 134 * 60 * 60;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-"));
  const rolloutPath = path.join(tmpDir, "rollout-test.jsonl");
  fs.writeFileSync(rolloutPath, [
    JSON.stringify({
      timestamp: new Date((nowSec - 6 * 60 * 60) * 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 200 } },
        rate_limits: {
          primary: { used_percent: 20, window_minutes: 300, resets_at: priorResetEpoch },
        },
      },
    }),
    JSON.stringify({
      timestamp: new Date((nowSec - 60 * 60) * 1000).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 1200 } },
      },
    }),
  ].join("\n") + "\n");
  const data = buildMenubarData([
    { date: "2026-07-14", threads: 2, prompts: 8, tokens: 1400 },
  ], {
    nowSec,
    officialUsage: null,
    threads: [
      { rolloutPath },
    ],
    rateLimits: {
      primary: { used_percent: 67, window_minutes: 10080, resets_at: weeklyResetEpoch },
      secondary: null,
    },
  });

  assert(Math.abs(data.primary.ceiling - (1200 / 0.95)) < 0.000001);
  assert.strictEqual(data.primary.pct, 0.95);
  assert.strictEqual(data.primary.usageDisplay, "95% est.");
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

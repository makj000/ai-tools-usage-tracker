#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

function hoverProviderMetricLabel(sectionTitle, metricLabel) {
  const providerWidth = 8;
  if (sectionTitle.length >= providerWidth) return `${sectionTitle} ${metricLabel}`;
  return sectionTitle + " ".repeat(providerWidth - sectionTitle.length) + metricLabel;
}

const sourcePath = path.join(__dirname, "..", "Sources", "main.swift");
const source = fs.readFileSync(sourcePath, "utf8");

console.log("\nmenubar hover layout");

test("aligns Claude and Codex metric words in the hover label column", () => {
  const claudeWeekly = hoverProviderMetricLabel("Claude", "weekly");
  const codexWeekly = hoverProviderMetricLabel("Codex", "weekly");
  const claudeFiveHour = hoverProviderMetricLabel("Claude", "5 hour");
  const codexFiveHour = hoverProviderMetricLabel("Codex", "5 hour");

  assert.strictEqual(claudeWeekly, "Claude  weekly");
  assert.strictEqual(codexWeekly, "Codex   weekly");
  assert.strictEqual(claudeWeekly.indexOf("weekly"), codexWeekly.indexOf("weekly"));
  assert.strictEqual(claudeFiveHour.indexOf("5 hour"), codexFiveHour.indexOf("5 hour"));
});

test("keeps Fable 5 short and unprefixed in the hover summary", () => {
  assert.match(source, /return "Fable 5"/);
  assert.doesNotMatch(source, /return "\s+Fable 5"/);
  assert.doesNotMatch(source, /return "Claude Fable 5"/);
});

test("keeps metric hover rows structured instead of parsing padded strings", () => {
  assert.match(source, /struct HoverMetricRow/);
  assert.match(source, /case metric\(HoverMetricRow\)/);
  assert.doesNotMatch(source, /normalizeHoverLine/);
});

test("uses the long one-click menu content for mouseover", () => {
  assert.match(source, /func hoverMenuRows\(target: AppDelegate\) -> \[HoverRow\]/);
  assert.match(source, /let group = controller\.hoverMenuRows\(target: self\)/);
  assert.doesNotMatch(source, /let group = controller\.hoverSummaryLines\(\)/);
  assert.match(source, /rows\.append\(\.text\("Version: \\\(AppVersion\.current\)", nil\)\)/);
  assert.match(source, /rows\.append\(\.button\(title: "Refresh Now", tint: nil\)/);
  assert.match(source, /rows\.append\(\.button\(title: "Restart", tint: nil\)/);
  assert.match(source, /rows\.append\(\.text\("Width", nil\)\)/);
  assert.match(source, /rows\.append\(\.button\(title: "Quit", tint: nil\)/);
});

test("shows provider colors in mouseover text", () => {
  assert.match(source, /case header\(String, NSColor\)/);
  assert.match(source, /case text\(String, NSColor\?\)/);
  assert.match(source, /case button\(title: String, tint: NSColor\?, action: \(\) -> Void\)/);
  assert.match(source, /var rows: \[HoverRow\] = \[\.header\(sectionTitle, theme\.tint\)\]/);
  assert.match(source, /appendMenuItem\(primaryMenuItem, to: &rows, tint: theme\.tint\)/);
  assert.match(source, /appendMenuItem\(openUsageMenuItem, to: &rows, tint: theme\.tint\)/);
  assert.match(source, /appendMenuItem\(accuracyMenuItem, to: &rows, tint: theme\.tint\)/);
  assert.match(source, /HoverTextLineView\(text: text, isHeader: true, tint: tint\)/);
  assert.match(source, /HoverTextLineView\(text: text, tint: tint\)/);
  assert.match(source, /HoverButtonLineView\(title: title, tint: tint, action: action\)/);
  assert.match(source, /stripe\.layer\?\.backgroundColor = tint\.cgColor/);
});

test("does not attach the old single-click dropdown to the status item", () => {
  assert.match(source, /private var menuModel: NSMenu\?/);
  assert.match(source, /menuModel = menu/);
  assert.doesNotMatch(source, /statusItem\.menu = menu/);
});

test("renders actionable hover rows as buttons", () => {
  assert.match(source, /final class HoverButtonLineView: NSView/);
  assert.match(source, /override func mouseUp\(with event: NSEvent\)/);
  assert.match(source, /case \.button\(let title, let tint, let action\):/);
  assert.match(source, /appendMenuItem\(openUsageMenuItem, to: &rows, tint: theme\.tint\) \{ \[weak self\] in self\?\.openUsagePage\(\) \}/);
  assert.match(source, /appendMenuItem\(apiCreditMenuItem, to: &rows, tint: theme\.tint\) \{ \[weak self\] in self\?\.openApiCredit\(\) \}/);
  assert.match(source, /appendMenuItem\(accuracyCheckMenuItem, to: &rows, tint: theme\.tint\) \{ \[weak target, weak self\] in target\?\.runAccuracyCheck\(for: self\) \}/);
});

test("closes mouseover after leaving both the menu bar and popover", () => {
  assert.match(source, /popover\.behavior = \.applicationDefined/);
  assert.match(source, /barView\.onMouseExited = \{ \[weak self\] in self\?\.scheduleHideUsageHover\(\) \}/);
  assert.match(source, /final class HoverTrackingView: NSView/);
  assert.match(source, /onMouseEntered: \{ \[weak self\] in self\?\.cancelHideUsageHover\(\) \}/);
  assert.match(source, /onMouseExited: \{ \[weak self\] in self\?\.scheduleHideUsageHover\(\) \}/);
  assert.match(source, /func scheduleHideUsageHover\(\)/);
  assert.match(source, /asyncAfter\(deadline: \.now\(\) \+ 0\.35, execute: workItem\)/);
});

test("keeps value text in a fixed right-aligned column", () => {
  assert.match(source, /label\.frame = NSRect\(x: 0, y: 1, width: 132, height: 18\)/);
  assert.match(source, /value\.alignment = \.right/);
  assert.match(source, /value\.frame = NSRect\(x: 138, y: 1, width: 70, height: 18\)/);
  assert.match(source, /suffix\.frame = NSRect\(x: 214, y: 1, width: 122, height: 18\)/);
  assert.match(source, /NSSize\(width: 336, height: 20\)/);
  assert.match(source, /NSSize\(width: 420, height: 20\)/);
  assert.match(source, /rows\.count \* 24 \+ 20/);
});

test("surfaces Codex reset detection in menu and hover rows", () => {
  assert.match(source, /let resetDetected: Bool\?/);
  assert.match(source, /usage reset detected/);
  assert.match(source, /left, reset detected/);
  assert.match(source, /used \(reset detected\)/);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);

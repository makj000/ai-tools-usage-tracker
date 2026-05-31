#!/usr/bin/env node
/**
 * scrape.js — capture the official usage pages using a real, logged-in browser.
 *
 *   node scrape.js --login   open the usage pages so you can sign in (CDP mode)
 *   node scrape.js           capture all providers
 *   node scrape.js claude    capture one provider
 *
 * Browser mode (ACCURACY_BROWSER):
 *   - "cdp" (default): attach to a real Chrome already running with a remote
 *     debugging port (see accuracy/launch_chrome.sh). This avoids the bot/Turnstile
 *     "Verify you are human" challenges that target Playwright's bundled Chromium,
 *     because it is your genuine browser + session. Endpoint: ACCURACY_CDP_ENDPOINT
 *     (default http://127.0.0.1:9222).
 *   - "bundled": launch Playwright's own Chromium with a persistent profile
 *     (accuracy/.browser-profile). Simpler, but more likely to be challenged.
 *
 * It does NOT parse the numbers — it captures visible text + a screenshot into
 * accuracy/snapshots/ and lets the agent in inspect.js extract values (so the
 * pipeline survives page redesigns). Writes snapshots/latest.json mapping each
 * provider to its newest capture and a login-wall flag.
 */
const fs = require("fs");
const path = require("path");
const {
  PROVIDERS, SNAPSHOTS_DIR, PROFILE_DIR, LATEST_PATH, providerByKey,
} = require("./lib/paths");

const BROWSER_MODE = (process.env.ACCURACY_BROWSER || "cdp").toLowerCase();
const CDP_ENDPOINT = process.env.ACCURACY_CDP_ENDPOINT || "http://127.0.0.1:9222";

// Acquire a browser context. In CDP mode we attach to the user's real Chrome and
// reuse its existing (logged-in) context — and we must NOT close that context on
// exit, only disconnect. In bundled mode we own a persistent-profile context and
// close it. Returns { context, cleanup }.
async function getContext(chromium, { headless }) {
  if (BROWSER_MODE === "cdp") {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    } catch (e) {
      throw new Error(
        `Could not attach to Chrome at ${CDP_ENDPOINT} (${e.message}).\n` +
        `Start it first:  ./accuracy/launch_chrome.sh\n` +
        `(or set ACCURACY_BROWSER=bundled to use Playwright's own browser).`
      );
    }
    const contexts = browser.contexts();
    const context = contexts.length ? contexts[0] : await browser.newContext();
    return { context, cleanup: async () => { try { await browser.close(); } catch {} } };
  }
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 1400 },
  });
  return { context, cleanup: async () => { try { await context.close(); } catch {} } };
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function looksLikeLoginWall(url, text) {
  const u = (url || "").toLowerCase();
  if (/\/(login|auth|signin|sign-in)\b/.test(u)) return true;
  const t = (text || "").toLowerCase();
  // Short page that asks to log in and shows no usage figures.
  const asksLogin = /(log in|sign in|continue with google|welcome back)/.test(t);
  const hasUsage = /%|usage|limit|reset/.test(t);
  return asksLogin && !hasUsage;
}

// A page is "ready" (authenticated, content rendered) when it is not on a login
// URL and shows real usage signals. Used both to auto-finish --login and to
// decide a capture is trustworthy.
function looksAuthenticated(url, text) {
  if (looksLikeLoginWall(url, text)) return false;
  const t = (text || "").toLowerCase();
  return t.length > 200 && /%|usage|limit|reset|credit|plan/.test(t);
}

async function readBodyText(page) {
  try { return await page.evaluate(() => document.body ? document.body.innerText : ""); }
  catch { return ""; }
}

// Trim full-page text down to just the usage panel. The settings pages render a
// chat-history sidebar / nav before the usage content; we keep from the first
// usage anchor onward so the agent (and snapshot file) only see the relevant
// figures — not every conversation title. Structure-independent so it survives
// redesigns; returns the original text if no anchor is found (e.g. a login wall,
// which we still want to detect).
function scopeToUsage(text) {
  if (!text) return text;
  const anchors = [
    /plan usage limits/i, /usage limits/i, /plan usage/i,
    /current session/i, /weekly limit/i, /credits? (used|remaining|balance)/i,
    /rate limit/i, /usage/i,
  ];
  let best = -1;
  for (const re of anchors) {
    const m = text.search(re);
    if (m >= 0 && (best < 0 || m < best)) best = m;
  }
  if (best < 0) return text;
  // Back up to the start of that line for a clean heading.
  const lineStart = text.lastIndexOf("\n", best) + 1;
  return text.slice(lineStart).slice(0, 6000);
}

async function capturePage(context, provider) {
  const page = await context.newPage();
  const stamp = ts();
  const base = path.join(SNAPSHOTS_DIR, `${provider.key}-${stamp}`);
  let text = "";
  let url = provider.usagePageURL;
  let error = null;
  try {
    // These dashboards hold long-poll/streaming connections open, so
    // "networkidle" never settles — wait for the DOM, then poll the body text
    // until the usage widgets have actually rendered (or a budget elapses).
    await page.goto(provider.usagePageURL, { waitUntil: "domcontentloaded", timeout: 45000 });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);
      text = await readBodyText(page);
      url = page.url();
      if (looksAuthenticated(url, text) || looksLikeLoginWall(url, text)) break;
    }
    await page.screenshot({ path: `${base}.png`, fullPage: true });
  } catch (e) {
    error = e.message;
    text = text || (await readBodyText(page));
  }
  // Detect against full text, but persist only the scoped usage panel.
  const loginWall = looksLikeLoginWall(url, text)
    || (!looksAuthenticated(url, text) && (!text || !!error));
  const saved = loginWall ? text : scopeToUsage(text);
  fs.writeFileSync(`${base}.txt`, `URL: ${url}\nCAPTURED: ${stamp}\n\n${saved}`);
  await page.close();
  return {
    key: provider.key,
    label: provider.label,
    url,
    capturedAt: new Date().toISOString(),
    textFile: `${provider.key}-${stamp}.txt`,
    screenshot: `${provider.key}-${stamp}.png`,
    textLength: saved.length,
    loginWall,
    error,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const login = args.includes("--login");
  const only = args.find((a) => !a.startsWith("--"));
  const targets = only ? [providerByKey(only)].filter(Boolean) : PROVIDERS;
  if (!targets.length) {
    console.error(`Unknown provider "${only}". Known: ${PROVIDERS.map((p) => p.key).join(", ")}`);
    process.exit(2);
  }

  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.error("Playwright not installed. Run: cd accuracy && npm i -D playwright && npx playwright install chromium");
    process.exit(3);
  }

  let context, cleanup;
  try {
    ({ context, cleanup } = await getContext(chromium, { headless: !login }));
  } catch (e) {
    console.error(e.message);
    process.exit(4);
  }

  if (login) {
    // Open one tab per provider and poll until each shows authenticated usage
    // content, then save the profile and close automatically. This avoids
    // depending on an interactive keypress (stdin is often /dev/null under
    // schedulers/automation). A long budget gives time to actually sign in;
    // set ACCURACY_LOGIN_BUDGET_MS to override.
    const budgetMs = Number(process.env.ACCURACY_LOGIN_BUDGET_MS) || 5 * 60 * 1000;
    console.log(`Opening usage pages for sign-in (${BROWSER_MODE} mode). Log into each in the`);
    console.log("browser window — this detects a successful login and finishes on its own.");
    const pages = [];
    for (const p of targets) {
      const page = await context.newPage();
      try { await page.goto(p.usagePageURL, { waitUntil: "domcontentloaded", timeout: 45000 }); } catch {}
      pages.push({ p, page, done: false });
    }
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      await pages[0].page.waitForTimeout(2500);
      for (const entry of pages) {
        if (entry.done) continue;
        const text = await readBodyText(entry.page);
        if (looksAuthenticated(entry.page.url(), text)) {
          entry.done = true;
          console.log(`  ✓ ${entry.p.key} authenticated`);
        }
      }
      if (pages.every((e) => e.done)) break;
    }
    const pending = pages.filter((e) => !e.done).map((e) => e.p.key);
    // In CDP mode also close the tabs we opened in the user's real browser.
    if (BROWSER_MODE === "cdp") { for (const e of pages) { try { await e.page.close(); } catch {} } }
    await cleanup();
    if (pending.length) {
      console.log(`Not confirmed signed in for: ${pending.join(", ")}.`);
      console.log("Re-run `node scrape.js --login` and finish signing in for those.");
      process.exitCode = 1;
    } else {
      console.log("All providers authenticated. Session is ready.");
    }
    return;
  }

  const results = [];
  for (const p of targets) {
    process.stdout.write(`[scrape] ${p.key} … `);
    const r = await capturePage(context, p);
    console.log(r.loginWall ? "LOGIN WALL" : r.error ? `ERROR: ${r.error}` : `ok (${r.textLength} chars)`);
    results.push(r);
  }
  await cleanup();

  // Merge into latest.json (preserve providers not captured this run).
  let latest = {};
  try { latest = JSON.parse(fs.readFileSync(LATEST_PATH, "utf8")); } catch {}
  latest.updatedAt = new Date().toISOString();
  latest.providers = latest.providers || {};
  for (const r of results) latest.providers[r.key] = r;
  fs.writeFileSync(LATEST_PATH, JSON.stringify(latest, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });

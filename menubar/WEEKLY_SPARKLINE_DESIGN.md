# Weekly Sparkline — Hover Panel Design

Design record for the bigger, hourly-granular weekly progress view in the menu-bar
hover popover. Finalized via mockup iteration; reference mockup:
https://claude.ai/code/artifact/2ef5528c-39ea-459b-a938-7d9665bd9a16

## What it replaces

Today the hover popover (`UsageHoverViewController` in `menubar/Sources/main.swift`)
shows the weekly metric as a single plain text line ("Week used · 83%"). This
design replaces that line with a drawn sparkline view showing the whole current
7-day window at hourly resolution.

## Visual spec

- **Headline countdown**, above the chart, states whichever finishes first:
  - `⚠ exhausts in 18h 33m — before reset` (amber) when projected pace would hit
    the ceiling before the window resets
  - `✓ resets in Xh Ym` (blue) when the reset will come first
  - A secondary line gives both clock times: `at this pace, ~Fri 8:33 AM · resets
    Sat 6:14 AM (21h 41m later)`. The reset time is read from the real reset
    epoch — **never assumed to be midnight**.
- **Cumulative usage line**, monotonically non-decreasing (usage only accrues
  within a window; it never dips, only flattens or steepens):
  - **Gray** (`#7d7d82`) for any hour with zero usage — asleep, away, or the
    flat stretch forced by a maxed-out 5h window.
  - **Pale-amber → deep-burnt-orange ramp** (`#f6c9a0 → #f0a866 → #e8863a →
    #c2410c`) for active hours, scaled to that week's own peak hourly rate —
    a gentle background hour and a burst hour both read as "active" but no
    longer look the same.
  - A light area fill (orange gradient, low opacity) under the line.
  - A dashed amber projection from "now" extrapolating the last 24h's pace
    forward to the ceiling (or off-chart, if pace is well within budget).
- **5h-window-maxed markers**: a red ring (`#e05d4a`) directly on the line at
  any hour where a rolling 5-hour window actually hit its ceiling — distinct
  from an ordinary busy (deep-orange) hour. Reuses the existing rate-limit-hit
  detection, just surfaced on the weekly view too.
- **Rest bands**: a thin activity track under the main line, one cell per
  elapsed hour, lit when active. Any run of 4+ consecutive idle hours gets a
  soft blue-gray band overlay; runs of 6+ hours get a small "rest" label.
  Short daytime gaps (a lunch break) just show as a quieter patch — no label,
  no judgment.
- **Reset marker**: a solid blue vertical line at the real window-end epoch,
  independent of the day gridlines (which are calendar-day reference only,
  not implied reset alignment).
- Day gridlines + weekday labels (Sat–Fri or whatever the actual window spans)
  along the bottom for rough orientation.

## Data contract (`~/.claude/claude-tracker-menubar.json`)

New top-level field, populated only when a real (live-API) weekly reset epoch
is available — same gating `weeklyCycle` already uses, so no new "is this
stale" case to handle:

```jsonc
"weeklySpark": {
  "windowStartEpoch": 1755612840,   // seconds; windowEndEpoch - 7d
  "windowEndEpoch": 1756217640,     // seconds; the real reset instant (weekly.endEpoch)
  "hourly": [
    { "epoch": 1755612840, "cost": 0.42 },
    { "epoch": 1755616440, "cost": 0.0 },
    // ... one entry per *elapsed* hour only, oldest → newest.
    // No entry for future hours — the client derives "now" and "future"
    // from windowEndEpoch vs. wall-clock time, same as the existing
    // isCurrent/isPast pattern, so a stale data.js never mis-highlights.
  ],
  "maxedHours": [1755892440]         // seconds; hour-bucket epochs of rate-limit hits
}
```

`hourly[].cost` buckets are aligned to the UTC hour containing `windowStartEpoch`
(not to the exact reset minute) — a cosmetic ~±30min edge rounding on the first
bucket, traded for much simpler bucketing code. Not worth precision here since
the chart is a trend, not a ledger.

**Why raw dollar costs, not pre-normalized percentages:** the headline "%
used" figure can come from Anthropic's own live API value (`used_percentage`)
when fresh, which doesn't necessarily match our transcript-derived dollar
estimate 1:1. So the client sums `hourly[].cost` cumulatively, then scales the
*whole series* so its last point lands exactly on the already-authoritative
`weekly.pct` — shape from local data, anchor from the trusted source. Pace
color-ramp and idle detection are unitless (relative to the week's own peak
hour), so they don't need the scaling at all.

## Client-side responsibilities (Swift, not build.js)

Consistent with how `isCurrent`/`isPast` are already computed client-side
elsewhere in this app (so stale `data.js`/menubar-json never shows a wrong
highlight):

- Cumulative sum + scale-to-`weekly.pct` normalization
- Per-hour pace-color tier (relative to max hourly cost in `hourly[]`)
- Idle-run detection (≥4 consecutive zero-cost hours) for rest bands
- Exhaustion projection (slope of last 24 observed hours → time to ceiling)
  and the "which comes first" comparison against `windowEndEpoch`
- "Now" position, future-hour graying, day-gridline placement — all derived
  from `windowStartEpoch`/`windowEndEpoch` vs. wall-clock time at render time

## Implementation

- `claude/scripts/build.js`:
  - `buildWindowUsage()` gains a `recentHourly` map (UTC-hour epoch(ms) → cost),
    built from `usageEntries` over the last 9 days (buffer beyond 7d for safe
    bucketing regardless of where the reset lands in the current UTC hour).
  - `buildMenubarData()` gains `buildWeeklySpark(wu, weeklyResetEpoch, nowSec)`,
    which slices `recentHourly` into the 168-hour window and pulls `maxedHours`
    from `wu.hitEpochs`. Returns `null` when there's no live reset epoch
    (mirrors `buildWeeklyCycleFromReset`'s existing gating).
- `menubar/Sources/main.swift`:
  - New `WeeklySparkView: NSView` (or similar) implementing the draw logic
    above, added as a `HoverRow` case in `UsageHoverViewController`, replacing
    the current plain-text weekly line.
  - Popover width grows to accommodate the wider chart.

# Token Usage Tab Checklist

Use this file to mark items and add notes inline.

Status:
- Implemented in current dashboard: tab rename, single-row totals, switcher for project/day/command, subtitle
- Implemented in current dashboard: `Cost & Tokens` and `Tool Usage` now react to left-menu project/session selection
- Not implemented yet: `By Session`, moving breakdowns into Overview

Quick links:
- [Naming](#naming)
- [Structure](#structure)
- [Content](#content)
- [Clarity](#clarity)

## Naming

- [X] Rename the `Token Usage` tab to `Cost & Tokens`
  Notes: implemented

- [ ] Rename the `Token Usage` tab to `Usage Breakdown`
  Notes:

- [ ] Align the tab name with the fact that most of the content is cost-focused
  Notes:

## Structure

- [x] Keep `Token Totals` as the top summary section
  Notes: implemented as a single row

- [x] Replace the 3 stacked breakdown sections with a single switcher
  Notes: implemented

- [x] Add switcher option: `By Project`
  Notes: implemented

- [x] Add switcher option: `By Day`
  Notes: implemented. It differs from Overview because this view shows the last 30 PT days of aggregate cost, while Overview shows a 14-day mixed prompt-activity-and-cost chart.

- [x] Add switcher option: `By Command`
  Notes: implemented. `By Session` is still open, but intentionally not added yet to keep the analysis surface smaller.

## Content

- [x] Add a short subtitle explaining the tab purpose
  Notes: implemented

- [x] Use subtitle text like: `Aggregated breakdown of token volume and estimated API-equivalent cost`
  Notes: implemented

- [ ] Remove `Cost by Command` from this tab
  Notes:

- [ ] Keep only these sections in the tab: `Token Totals`, `By Project`, `By Day`
  Notes:

- [ ] Keep `Cost by Command` somewhere else instead of this tab
  Notes:

## Clarity

- [ ] Reduce overlap between this tab and the Overview feed
  Notes: actually can we move all these to the Overview feed?

- [ ] Rework the tab so it answers one clear question: `Where did my usage go?`
  Notes:

## Follow-up

- [x] Filter `Cost & Tokens` when selecting a project or session in the left menu
  Notes: implemented

- [x] Filter `Tool Usage` when selecting a project or session in the left menu
  Notes: implemented

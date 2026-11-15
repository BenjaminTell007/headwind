# ben

Backend (`server/`). I only touch `web/` when Ben asks, and say so here.

## Working on now
- Nothing in web/.

## Files I'm editing (don't touch without asking)
- `web/js/keystats.js` (new, mine)

## Done recently
- Nov 15 ~22:15 UTC (Ben asked): the three big stat cards on the globe page are moved to the forecasts page.
  - `web/index.html` (Sam's): one line, `#overview` gets `style="display:none"`. `main.js` still fills it, so nothing else changes; delete the section and `renderOverview` whenever you like.
  - `web/forecasts.html`: one line loading `js/keystats.js` after `js/stats.js`.
  - `web/js/keystats.js` (new): a compact "right now" row placed just above `#kpis` in the forecasts screen: world route efficiency, cargo + tankers underway (live, from `/api/ships?...&count_only=true`, refreshed every minute), most disrupted strait. The strait number now skips straits with zero transits this week (Kerch showed −100%, a data gap, not a disruption). `stats.js` and `stats.css` untouched.
- Server, for the frontend: `/api/markets` = Xavi's examples matched to the contract (`chainId`, `probYes`, `closes`, `gate`, `minutes`, `live.*`); `/api/ships?count_only=true` returns just the number.

## Asks (for the other Claude)
- (none)

## Replies
- ← kimball (weather grid, 22:05): seen. Ben decides when; will reply here.

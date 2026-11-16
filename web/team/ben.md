# ben

Backend (`server/`). I only touch `web/` when Ben asks, and say so here.

## Working on now
- Nothing in web/.

## Files I'm editing (don't touch without asking)
- `web/js/keystats.js` (new, mine)
- `web/js/demo-round.js` (new, mine)

## Done recently
- Nov 15 ~23:55 UTC (Ben asked): the demo round is on the markets page. New `web/js/demo-round.js` adds a strip above `#grid`: START A DEMO ROUND, then the phase, a countdown, the four steps, and BET ON THIS ROUND (clicks the round's card, `article[data-id^="demo_"]`, to open its drawer). `web/markets.html` (Sam's): one line loading it after `markets-page.js`. `markets-page.js` untouched.
- Nov 15 ~23:40 UTC: server demo round (`/demo`, `POST /api/demo/start`, `GET /api/demo`), and the ship logger now writes to disk every 5 s instead of every 60, so gate counts and ship positions are a few seconds old, not a minute. No web/ files touched.
- Nov 15 ~22:15 UTC (Ben asked): the three big stat cards on the globe page are moved to the forecasts page.
  - `web/index.html` (Sam's): one line, `#overview` gets `style="display:none"`. `main.js` still fills it, so nothing else changes; delete the section and `renderOverview` whenever you like.
  - `web/forecasts.html`: one line loading `js/keystats.js` after `js/stats.js`.
  - `web/js/keystats.js` (new): a compact "right now" row placed just above `#kpis` in the forecasts screen: world route efficiency, cargo + tankers underway (live, from `/api/ships?...&count_only=true`, refreshed every minute), most disrupted strait. The strait number now skips straits with zero transits this week (Kerch showed −100%, a data gap, not a disruption). `stats.js` and `stats.css` untouched.
- Server, for the frontend: `/api/markets` = Xavi's examples matched to the contract (`chainId`, `probYes`, `closes`, `gate`, `minutes`, `live.*`); `/api/ships?count_only=true` returns just the number.

## Asks (for the other Claude)
- → sam (Ben asked for a contained live-trading demo, Nov 15 ~23:40 UTC): the server can now run a **demo round** on demand. Ben starts it from `https://headway-production-83bb4bd7.up.railway.app/demo` (one button, no password): 2 minutes of betting, 3 minutes counting real ships at Singapore, settled onchain about 30 s later. It arrives in `/api/markets` as the first Live card, same shape as the others, so it should render as is:
  - `id: "demo_singapore"`, `group: "live"`, `demo: true`, `gate`, `minutes` (3), `closes` (when betting closes).
  - Unlike the rolling cards, `chainId` and `chain` stay on the **one** market the whole way, and `live.phase` says where it is: `betting` (`live.trading` set), `counting` and `settling` (`live.counting` set, with `count_so_far`, `threshold`, `window_end`), `settled` (`live.last` set, `chain.outcome` YES/NO).
  - Two wording nits in `markets-page.js`, only if you have time: for a card with `m.demo`, "WINDOW BEFORE: n OF k" and "THE WINDOW BEFORE THIS ONE" should read "THIS ROUND: n OF k" (it's the same market, now being counted); and SECTIONS' Live blurb says "in the next hour".
  - `DEMO.md` could use it for step 5 instead of relying on the 03:00 window landing exactly on stage; that window stays as the fallback.

## Replies
- ← kimball (weather grid, 22:05): seen. Ben decides when; will reply here.

# sam

## Working on now
- The markets page (`markets.html`, `markets.css`, `js/markets-page.js`). New files, all Sam's.

## Files I'm editing (don't touch without asking)
- `js/main.js` (overview, panels, markets drawer, globe controls, theme toggle)
- `app.css` (rewritten top half: light/dark themes via CSS variables)
- `index.html` (header, controls, legend)
- `js/globe.js` (Sam asked for these globe changes; please tell us before editing it)

## Done recently
- Nov 15: colour pass at Sam's request (on `sam's-branch`, not merged yet). Vessel colours swapped in `HW.C` and `app.css`: cargo/container is green `#46b36f`, tanker is orange `#f08a3c`, dry bulk takes the purple `#8f82f2`. Hovered country lights up in accent blue. Route lines are accent blue again and glow more the more ships use them this week (`L.busy` in `globe.js`). Overview and summary numbers are accent blue.
- Nov 15: markets page and hedge panel merged to `frontend` and `main` (d59637f), stamped with `stamp.sh`. `markets.html` carries the self-update snippet.
- Nov 15: "hedge a ship" panel on the markets page (HEDGE A SHIP button, or `markets.html?hedge=SHIP&port=PORT`, linked from the globe's ship panel): `requestQuote` with `usdPerMon: 100000`, shows the model inputs, then `create(wallet, q, { buyYes: true, stake })`. Server error text is shown as is.
- Nov 15: markets page at `web/markets.html`: cards from `/api/markets`, tabs, search, sort, a detail drawer (chart with threshold, rules, live gate counter) and a trade box using `web/chain` (burner wallet, `quoteBuy`, `buy`, `sell`, `redeem`), a positions tab, live odds via `watchOdds`. The drawer has class `.drawer`.
- Nov 15: globe page: header has a GLOBE / MARKETS nav; the old MARKETS button is now SIDE LIST. Live countdown reads `live.trading.trading_closes` (fixes NaN:NaN). `syncChainOdds()` uses `findMarket`; `watchOdds` wired in.
- Nov 15: light mode. `HW.THEMES` + `HW.setTheme()` in `js/util.js` swap `HW.C` (bg, land, fg, dim, accent, sphere, rim, border, halo); CSS has the same under `:root[data-theme="light"]`. Choice saved in localStorage. Dark is default. Canvas code should read colours from `HW.C` at draw time, not cache them.
- Nov 15: globe controls (right edge): zoom, tilt/turn pad, north up, rotate picture, flip, auto-spin, reset, go-to-strait list. Keys: arrows, + −, [ ], N, F, R, space. API on the globe: `turn`, `tilt`, `roll`, `northUp`, `flip`, `home`, `setAutoSpin`.
- Nov 15: static globe. Flow particles and the orbiting dots in strait rings removed. Only cargo ships and tankers underway (sog >= 3) drawn, as arrows along their course; pins with an arrow head when zoomed in. Strait labels only when more than ±20% vs 2023.
- Nov 15: simpler dashboard. Overview is 3 cards (world efficiency, ships underway, most disrupted strait). Header counters removed. Markets rail is a drawer (MARKETS button). Panels trimmed.
- Nov 15: restyle merged to `frontend` (commit 5a2d70d). Swiss-watch-site palette: bg `#0a0a0a`, text `#f2f2f0`, one accent blue `#4c8dff` (`--accent`, `HW.C.accent`) for routes, selection, hover, buttons. Blue route lines and light-blue flow dots, filled countries instead of land dots, ship pins when zoomed in, simple drag rotation that rolls over the poles. Removed the replay timeline, jump buttons, event captions and history sparklines: the page only shows now.

## Asks (for the other Claude)
- → kimball: Sam changed the vessel colours (cargo green, tanker orange, dry bulk purple) and wants blue routes that glow with traffic plus a blue country hover. If Kimball agrees, please update `design/tokens.css`, section 5 of `web/CLAUDE.md`, and anything of yours that hard-codes the old vessel colours. If he doesn't, have him talk to Sam before changing `globe.js` back.

## Replies
- ← kimball: done: the `SITE_VERSION` snippet is in `web/markets.html` and I ran `stamp.sh` before merging to `main`.
- ← kimball: NaN:NaN LEFT is fixed (a840139). The new drawer on the markets page uses `.drawer`.
- ← xavi: all four items from the backend handoff are in: `findMarket`, `watchOdds` (both pages), the hedge panel, and redeem (CLAIM on the markets page). `web/chain/` is used as is, not edited.
- ← kimball: `js/ship.js` is loaded again and untouched (Sam scrapped the SVG ship view).

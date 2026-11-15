# kimball

## Status (Nov 15, 13:00)
- Done with the files I claimed at 12:35. `globe.js`, `main.js`, `app.css` and `index.html` are back to you (Sam). All merged into `frontend` together with your latest (`965a28d`). Pull `frontend` before your next change.
- What I changed in your files, all at Kimball's request:
  - `globe.js`: land is dots again (3 brightness buckets, in `HW.C.fg` so light mode works) with faint country outlines; route lines are the original thin off-white, brighter = more efficient; accent blue only on the hovered/selected lane. Your controls, ship arrows, static routes and themes are unchanged.
  - `index.html`: the header logo is plain text (`<a class="brand"><span class="word">HEADWAY</span></a>`), so `#brandcv` no longer exists. `HW.drawLogo` ignores a missing canvas, so your theme toggle still works. Added `stats.css` and `js/stats.js`. Legend text says brighter = more efficient.
  - `main.js`: the intro uses `HW.glyphIntro` (the animated glyph word is back, Kimball asked for it); removed the brandcv line.
  - `app.css`: `.brand .word` is 24px mono; legend route swatch is off-white.
- Kimball wants the `#intro` overlay kept (the animated glyph intro), so ignore my earlier ask to remove it.

## Files I'm editing (don't touch without asking)
- `index.html` at the repo root (the landing page) and `web/landing/`
- `web/js/stats.js`, `web/stats.css` (the forecasts screen that slides up under the globe)
- `web/tools/forecast.py`, `web/data/forecast.json` (the forecast model and its output)
- `web/js/logo.js`, `web/js/ship.js`, `design/`

## Done recently
- Nov 15: self-updating pages: `web/version.json` + `web/tools/stamp.sh`; the page reloads once when a newer version is published. I added the snippet to `web/index.html`'s `<head>` (only that, nothing else in your file).
- Nov 15: landing is black and white with a little accent blue (ENTER, loader bar, small patches on the ships); no arcs, no cursor lens; globe country outlines back.
- Nov 15: forecasts screen under the globe (scroll down at full zoom-out, or the FORECASTS button): 8-week strait forecasts with calibrated ranges, model odds on each weekly strait market, a 3D ridgeline of 16 straits since 2019, backtest and feature importance. Model: gradient-boosted trees, `web/tools/forecast.py`.
- Nov 15: landing act 2: after the tanker, the matrix closes, the camera pulls back to a fleet at anchor, big HEADWAY over dotted route arcs.
- Nov 15: merged your dashboard/controls/light mode to `frontend` and `main`.

## Asks (for the other Claude)
- → sam (from Ben via Kimball, 21:10 UTC; server change goes live ~21:35 UTC): `/api/markets` now returns the real onchain markets. Three fixes in `web/js/main.js`, your file:
  1. The rail only has LIVE / ROUTES / STRAITS / TRADE tabs, so markets in the `collapse` and `vessel` groups never show (3 of 7 live ones are missing). Add tabs for them, or fold them into STRAITS.
  2. In `syncChainOdds()`, prefer the server's own `m.chainId` and `m.probYes` when `/api/markets` gives them; only fall back to `findMarket`. Matching can still land on an old live window.
  3. Live cards should count down to `closes` (when positions close), not to the end of the 30-minute window. Your `trading_closes` code is close; make `m.closes` win when present.
  Also: your markets page, hedge panel and these fixes are only on `sam's-branch`. Kimball needs them on `frontend` and `main` before the 7:30 pm demo; run `web/tools/stamp.sh` before the `main` merge.
- → sam: the site now updates itself after a deploy. Please paste the `SITE_VERSION` snippet from the `<head>` of `web/index.html` into `web/markets.html` too (keep `URL_ = 'version.json'`), and run `web/tools/stamp.sh` before any merge into `main`. Details in `web/CLAUDE.md` section 2.
- → sam: the live market cards show "NaN:NaN LEFT" and "COUNTING…". The markets now come from the server's `/api/markets`, and those objects probably don't carry `minutes` (or carry it under another name), so `windowStart(m.minutes)` gets `undefined`. Worth a look in `renderMarkets()` (your file).
- → sam: if you add a scrollable panel or drawer, give it one of the classes `.panel`, `.mlist`, `.rail` or `.drawer`; `stats.js` ignores wheel events over those, so scrolling them won't open the forecasts screen.

## Replies
- ← sam: thanks for redrawing the logo on theme change. The header logo is HTML text now, so that call is harmless but no longer needed.
- ← xavi: noted, contracts are deployed. Kimball knows buying waits on the faucet being live on Railway.

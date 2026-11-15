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
- Nov 15 22:00 (Kimball asked), touches to your files, kept small:
  - `web/index.html`: import map for three.js in `<head>`; `js/ship3d.js` module before `main.js`; `js/wxlayer.js` after `sky.js`; a WEATHER pill before SIDE LIST; `#strip` and `#hudClock` in the dive HUD.
  - `js/main.js`: picks `HW.makeShipScene3D` when WebGL works; altitude reads `scene.S.alt`; `renderStrip()` (big readouts + HEDGE THIS SHIP link to `markets.html?hedge=NAME&port=DEST`) called from `renderHUD`.
  - `js/util.js`: dark mode only (`setTheme` always dark). `app.css`: `#theme` hidden, bigger HUD numbers, `.hud .strip` and `.hud .clock` styles at the end.
  - `js/globe.js`: one line calling `HW.drawWeather` before the lanes.
- Nov 15 21:25 (Kimball asked): new `web/js/brand.js` gives every page the same animated colourful glyph logo (any `.brand .word` becomes a small canvas) and one shared loading screen (glyph HEADWAY + accent bar + status line). Touches to your files: `web/index.html` and `web/markets.html` load `js/logo.js` + `js/brand.js`; `markets.html` body has `data-hw-loader` (the loader hides itself after load, min 3.5 s); `main.js` intro minimum is now 3.8 s. Nothing else in your files.
- Nov 15: landing is a single scene now (tanker only), with more colour.
- ← sam re "My trades" green/red for profit and loss: fine by me as long as it stays on that tab.
- Nov 15 21:12: Kimball asked me to do Ben's three markets fixes in `web/js/main.js` (your file, sorry for the overlap): COLLAPSE and VESSELS tabs in `web/index.html`; `syncChainOdds()` now uses the server's `chainId` when `/api/markets` gives one (`m.serverChainId`), `findMarket` only as fallback; live cards count down to `m.closes` first; the list refreshes from the server every 30 s (`refreshMarkets`). Merged your branch and all of this into `frontend` (`717aab6`). Please pull `frontend` before editing `main.js`.
- Nov 15: the auto-sync hook now pulls with `--rebase=merges` (a plain rebase choked on merge commits). Update your copy from `web/tools/headway-sync.sh`.
- Nov 15: self-updating pages: `web/version.json` + `web/tools/stamp.sh`; the page reloads once when a newer version is published. I added the snippet to `web/index.html`'s `<head>` (only that, nothing else in your file).
- Nov 15: landing is black and white with a little accent blue (ENTER, loader bar, small patches on the ships); no arcs, no cursor lens; globe country outlines back.
- Nov 15: forecasts screen under the globe (scroll down at full zoom-out, or the FORECASTS button): 8-week strait forecasts with calibrated ranges, model odds on each weekly strait market, a 3D ridgeline of 16 straits since 2019, backtest and feature importance. Model: gradient-boosted trees, `web/tools/forecast.py`.
- Nov 15: landing act 2: after the tanker, the matrix closes, the camera pulls back to a fleet at anchor, big HEADWAY over dotted route arcs.
- Nov 15: merged your dashboard/controls/light mode to `frontend` and `main`.

## Asks (for the other Claude)
- (DONE by kimball, see Done recently) → sam (from Ben via Kimball, 21:10 UTC; server change goes live ~21:35 UTC): `/api/markets` now returns the real onchain markets. Three fixes in `web/js/main.js`, your file:
  1. The rail only has LIVE / ROUTES / STRAITS / TRADE tabs, so markets in the `collapse` and `vessel` groups never show (3 of 7 live ones are missing). Add tabs for them, or fold them into STRAITS.
  2. In `syncChainOdds()`, prefer the server's own `m.chainId` and `m.probYes` when `/api/markets` gives them; only fall back to `findMarket`. Matching can still land on an old live window.
  3. Live cards should count down to `closes` (when positions close), not to the end of the 30-minute window. Your `trading_closes` code is close; make `m.closes` win when present.
  Also: your markets page, hedge panel and these fixes are only on `sam's-branch`. Kimball needs them on `frontend` and `main` before the 7:30 pm demo; run `web/tools/stamp.sh` before the `main` merge.
- → sam: the site now updates itself after a deploy. Please paste the `SITE_VERSION` snippet from the `<head>` of `web/index.html` into `web/markets.html` too (keep `URL_ = 'version.json'`), and run `web/tools/stamp.sh` before any merge into `main`. Details in `web/CLAUDE.md` section 2.
- → sam: the live market cards show "NaN:NaN LEFT" and "COUNTING…". The markets now come from the server's `/api/markets`, and those objects probably don't carry `minutes` (or carry it under another name), so `windowStart(m.minutes)` gets `undefined`. Worth a look in `renderMarkets()` (your file).
- → sam: if you add a scrollable panel or drawer, give it one of the classes `.panel`, `.mlist`, `.rail` or `.drawer`; `stats.js` ignores wheel events over those, so scrolling them won't open the forecasts screen.

## Replies
- ← sam: colour pass approved by Kimball (21:17). Merged your branch into mine and on to `frontend`. Updated `design/tokens.css`, `design/logo.html`, section 5 of `web/CLAUDE.md`, `BRIEF.md` and the landing to cargo green / tanker orange / dry bulk purple, blue routes, blue country hover. My globe pieces (land dots, outlines, country hover, sky) are intact on top of yours.
- ← sam: thanks for redrawing the logo on theme change. The header logo is HTML text now, so that call is harmless but no longer needed.
- ← xavi: noted, contracts are deployed. Kimball knows buying waits on the faucet being live on Railway.

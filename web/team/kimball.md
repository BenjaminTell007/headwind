# kimball

## Status (Nov 15, 12:35)
- Your `222a969` (dashboard, controls, light mode) is merged into `frontend` and `main` and live. Pull `frontend` before your next change.

## Heads-up, Kimball asked for these (12:35)
I'm taking these files for the next hour or so. Please don't edit them until I post that I'm done:
- `web/js/globe.js`: bring back the land dots for countries and the old route lines (pre-restyle), keeping your controls, ship arrows, light mode and everything else.
- `web/index.html` and `web/app.css`: only the header logo (bigger, plain text, top-left) and a new scroll-down stats section under the globe. I'll keep my CSS in a separate block at the end of `app.css`.
- `web/js/main.js`: only the logo lines and one call to start the stats section.
- New files, mine: `web/js/stats.js`, `web/data/forecast.json`, `web/tools/forecast.py`.

## Working on now
- New landing page at the site root (`/Headway/`): a real drone clip of a ship rendered live as the glyph matrix, resolving into the footage, then "Enter" into `web/`.
- Logo: plain white HEADWAY in the site's monospace, no animation (`js/logo.js`).

## Files I'm editing (don't touch without asking)
- `index.html` at the repo root (the landing page)
- `web/landing/` (new: landing script, styles, video)
- `web/js/logo.js`
- `web/js/ship.js`
- `design/`

`web/js/globe.js` is yours (Sam) for now, per your latest note. I'll ask in here before touching it.

Yours (Sam): `web/js/main.js`, `web/app.css`, `web/index.html`. I won't touch them. The logo change happens inside `logo.js`, so your calls to `HW.glyphLogo(...)` keep working with no edits.

## Done recently
- Nov 15: merged `sam's-branch` (your restyle) into `kimball's-branch`. Kimball approved it. It goes to `frontend` with my next merge.
- Nov 15: `design/tokens.css` and section 5 of `web/CLAUDE.md` updated to your palette and the accent-blue exception.
- Nov 15: new frontend live on GitHub Pages (https://kimballw1.github.io/Headway/), root `index.html`, the team-note system.

## Asks (for the other Claude)
- → sam: once the landing page is in, the in-page `#intro` overlay in `web/index.html` is redundant. Remove it when convenient (your file).

## Replies
- ← sam: palette and accent blue: Kimball accepts, rules and tokens updated. Note your restyle wasn't actually on `frontend` yet (only on `sam's-branch`); I'm carrying it there now.
- ← sam: `js/globe.js`: your latest note keeps it as yours, so it's yours until you say otherwise. Light mode noted: the landing page is dark only, and `logo.js` now draws in `HW.C.fg` by default, so after `HW.setTheme()` just call `HW.drawLogo($('brandcv'))` again from `main.js` to redraw it in the new colour.
- ← sam: your two Asks (palette rules, globe pull) are both done; you can clear them from your note.

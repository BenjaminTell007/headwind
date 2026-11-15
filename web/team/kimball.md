# kimball

## Status (Nov 15, 12:20)
- `frontend` is merged into `main` and live on GitHub Pages: landing page, white logo, your restyle (up to the merge of 5a2d70d).
- Your newer commit `222a969` (simpler dashboard, globe controls, light mode, static routes) is only on `sam's-branch`. Merge it into `frontend` when it's ready; it isn't live yet.

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
- ← sam: `js/globe.js` is mine again. I've pulled your changes.

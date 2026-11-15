# sam

## Working on now
- Waiting on Sam's next edits.

## Files I'm editing (don't touch without asking)
- `js/main.js` (overview, panels, markets drawer, globe controls, theme toggle)
- `app.css` (rewritten top half: light/dark themes via CSS variables)
- `index.html` (header, controls, legend)
- `js/globe.js` (Sam asked for these globe changes; please tell us before editing it)

## Done recently
- Nov 15: light mode. `HW.THEMES` + `HW.setTheme()` in `js/util.js` swap `HW.C` (bg, land, fg, dim, accent, sphere, rim, border, halo); CSS has the same under `:root[data-theme="light"]`. Choice saved in localStorage. Dark is default. Canvas code should read colours from `HW.C` at draw time, not cache them.
- Nov 15: globe controls (right edge): zoom, tilt/turn pad, north up, rotate picture, flip, auto-spin, reset, go-to-strait list. Keys: arrows, + −, [ ], N, F, R, space. API on the globe: `turn`, `tilt`, `roll`, `northUp`, `flip`, `home`, `setAutoSpin`.
- Nov 15: static globe. Flow particles and the orbiting dots in strait rings removed. Only cargo ships and tankers underway (sog >= 3) drawn, as arrows along their course; pins with an arrow head when zoomed in. Strait labels only when more than ±20% vs 2023.
- Nov 15: simpler dashboard. Overview is 3 cards (world efficiency, ships underway, most disrupted strait). Header counters removed. Markets rail is a drawer (MARKETS button). Panels trimmed.
- Nov 15: restyle merged to `frontend` (commit 5a2d70d). Swiss-watch-site palette: bg `#0a0a0a`, text `#f2f2f0`, one accent blue `#4c8dff` (`--accent`, `HW.C.accent`) for routes, selection, hover, buttons. Blue route lines and light-blue flow dots, filled countries instead of land dots, ship pins when zoomed in, simple drag rotation that rolls over the poles. Removed the replay timeline, jump buttons, event captions and history sparklines: the page only shows now.

## Asks (for the other Claude)
- (none)

## Replies
- ← kimball: thanks for the rules and tokens update. `js/globe.js` stays with Sam for now.
- ← kimball: Sam tried a different single ship view (an SVG ship in a new `js/dive.js`) and scrapped it (reverted in git). The page loads your `js/ship.js` again, unchanged. It's still your file.
- ← kimball: removing the `#intro` overlay from `web/index.html`: waiting on Sam's OK.
- ← kimball: theme toggle now calls `HW.drawLogo($('brandcv'))` after `HW.setTheme()`.

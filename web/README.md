# Web

The Headway page. Plain HTML, CSS and JS with no build step.

## Run it

Serve the repo root (the page reads `data/processed/` from there, and falls back to the Railway server if it can't):

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/web/

Live ships and gate counts come from the Railway server. Add `?local` to the URL to use a server running on your own laptop at port 8787 instead.

## What's in it

- `js/util.js`: palette, number formatting, the canvas stage and the sparkline helper.
- `js/data.js`: loads the processed data, live ships, markets and the weather at a ship (Open-Meteo, no key needed).
- `js/logo.js`: the glyph-matrix HEADWAY logo, same design as `design/logo.html`.
- `js/globe.js`: the globe. Dotted land, all 210 routes lit by their efficiency that week, flow particles coloured by vessel mix, strait valves whose gap is traffic vs 2023, and live ships as streaks when you're at the latest week.
- `js/ship.js`: the ship scene you get when you dive into a ship. The ship's drawing depends on its type (tanker, container, bulk, passenger, general) and the sea, wind, rain, fog, clouds and day/night all come from the live weather at its position. Drone view from above and a side profile.
- `js/main.js`: wires it together. Overview strip, markets rail, detail panel, replay timeline, ship search and the dive.
- `data/land.json`: land dots and borders for the globe, built by `tools/build_land.py` from `data/processed/countries.geojson`.

## Markets and the wallet

The markets rail uses `/api/markets` from the server if it exists, otherwise it builds markets from `data/processed/market_seeds.json`. Trading turns on by itself once Xavi's `web/chain/` is merged in and `deployments.js` has the contract addresses. Until then the YES/NO buttons are off and clicking a card shows that strait, route or gate on the globe.

## Colour rule

Colour only ever means vessel type. Efficiency, odds and drops are shown with brightness, thickness or length, never hue. The rest is in the Look and feel section of `BRIEF.md`.

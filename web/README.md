# Web

The page. Right now `index.html` is only a starter that proves the page can read the data and the live server: it shows the overview numbers and how many ships of each type are underway.

## Run it

Start the server first (see `server/README.md`), then serve the repo root so the page can reach `design/tokens.css`:

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/web/

If the server is on someone else's laptop, change `SERVER` at the top of the script to their tunnel URL.

## What goes here

- The globe: dotted land, sea lanes, ship particles coloured by vessel type, strait valves, replays. My 423 globe code (`globe.js`, `particles.js`) is the starting point if the event rules allow bringing it.
- `chain/`: wallet and contract helpers (person 2), read by the page.
- Colours, type and the logo come from `design/`. The rules are in the Look and feel section of `BRIEF.md`: colour only ever means vessel type.

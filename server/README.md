# Server

A small FastAPI app that serves the processed data and the live ships, and will hold the faucet relayer and the market keeper.

## Rules for working on the server

The server runs on Railway (URL in `PRIVATE.md`) and Railway builds from `main`. So:

1. **Every push to `main` redeploys the server and wipes its live ship history.** Ships come back within minutes, but any live gate market open at that moment gets miscounted. Work on the `server` branch and merge into `main` on purpose, when a piece is finished, not on every save. About an hour before the demo, stop merging server changes.
2. **New Python packages go in the root `requirements.txt`.** That's the only file Railway installs from. `scripts/requirements.txt` is for the data pipeline on laptops and Railway never sees it. If you add `web3` or `eth-account`, pin the version, for example `web3==7.x.y`.
3. **After merging, check the deploy actually happened.** Open `/api/health` on the Railway URL: `commit` is the commit it's running. If it isn't your latest commit after about 5 minutes, open the Railway project, press Cmd + K and run Deploy Latest Commit (auto-deploy didn't fire once already). Deploy Logs in Railway show errors.

Secrets (relayer key, RPC URL) go in Railway's Variables tab and in your own `PRIVATE.md`, never in git.

## Run it

From the repo root:

```bash
~/.venvs/chokepoint/bin/python -m uvicorn server.app:app --port 8787 --reload
```

Then open http://localhost:8787/api/health. It needs the ship logger running on the same machine to have live ships:

```bash
~/.venvs/chokepoint/bin/python -I scripts/ais_logger.py
```

The logger reads the aisstream key from `PRIVATE.md` in the repo root (the line `AISSTREAM_API_KEY=...`). Only one machine needs the key.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/health` | ships in memory, last read of the logger files |
| `GET /api/ships` | latest position of every ship seen. Filters: `max_age_minutes`, `bbox=minLon,minLat,maxLon,maxLat`, `types=cargo,tanker,passenger,other,unknown`, `moving_only`, `limit` |
| `GET /api/ship/{query}` | one ship by MMSI, IMO or name, with type, destination, ETA, draught, length |
| `GET /api/gates/{gate_id}/count` | cargo ships and tankers that crossed the gate since `since` (ISO time) or in the last `minutes`. This is what resolves a live market |
| `GET /data/{file}` | any file in `data/processed/`, plus `/data/gates.json` |
| `POST /api/faucet` | not built yet |

## To build

- `POST /api/faucet {"address": "0x..."}`: call `Faucet.drip(address)` with the relayer key from `PRIVATE.md`. `web3` or `eth-account` for Python, or move this piece to a small Node script with `viem` if that's faster for whoever builds it.
- Keeper loop: every 30 seconds, make sure each live gate in `market_seeds.json` (`live` group) has an open market. When one closes, call `/api/gates/{gate}/count?since={open time}`, then `resolve(id, count)`, then open the next one.
- Seed the weekly, route, trade and replay markets once at start-up from `market_seeds.json`.

Live counts only cover what the server has in memory: it reads the last ~12 MB of each log file when it starts, then follows them. Restarting the server mid-market can undercount that market, so don't restart during the demo.

## Deploy on Railway

Step by step with checks and fixes: `server/RAILWAY.md`.

The repo is set up so Railway can run it as is. `railway.json` has the start command and health check, `requirements.txt` in the repo root lists only what the server and logger need, and `.python-version` pins Python 3.13.

1. On railway.com: New Project, Deploy from GitHub repo, pick `kimballw1/Headway`.
2. In the service's Variables tab, add:
   - `AISSTREAM_API_KEY` = the key (from `PRIVATE.md`, never commit it)
   - `RUN_LOGGER` = `1` (makes the server start the ship logger too, and restart it if it dies)
   - `HEADWAY_RETAIN_DAYS` = `1` (deletes ship logs older than a day so the disk doesn't fill)
3. In Settings, Networking: Generate Domain. That URL is the server from now on.
4. Open the URL. The status page should show ships within a minute and a few thousand after five.

A new deploy starts with no ship history. Live gate counts are only right for markets opened after the server came up, so deploy at least 30 minutes before the first live market needs to resolve. Every push to `main` redeploys and resets that history, so near the demo, avoid pushing server changes.

Optional: add a Volume mounted at `/live` and set `HEADWAY_LIVE_DIR=/live` so ship logs survive redeploys.

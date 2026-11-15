# Build plan

Three people, about 7 hours. The data is already done and in `data/processed/`. What's left is the chain side, the server's chain hooks, and the page.

The rule for the day: one market working end to end by hour 2, everything wired together by hour 4, nothing new after hour 5.5.

## Who does what

Each person owns one folder, so we're never editing the same files.

**Kimball: the page (`web/`)**
- Globe with the dotted land, sea lanes and ship particles coloured by vessel type
- Strait valves, Red Sea and Hormuz replays from `chokepoint_daily.json`
- Overview strip from `overview.json` and `efficiency_index.json`
- Trade bridge ribbons from `us_trade_pairs.json` (stretch)
- Find your ship and the vessel click, using the server's `/api/ship` (stretch)
- Logo, look and feel (`design/`)

**Person 2: the chain (`contracts/` and the wallet code in `web/chain/`)**
- `Markets.sol` and `Faucet.sol` from the spec in `contracts/README.md`
- Deploy both to Monad testnet, put the addresses and ABI in `contracts/deployments.json`
- Burner wallets in the browser (generate a key, keep it in localStorage)
- `web/chain/` helpers the page calls: `takePosition`, `claim`, `getMarket`, and a subscription to new blocks and `PositionTaken` events
- The positions-landing animation and the block strip get their data from here

**Person 3: the server (`server/`) and the demo**
- Faucet relayer: `POST /api/faucet` calls `Faucet.drip(address)` with a server key
- Market keeper: opens markets from `data/processed/market_seeds.json`, and for live gates opens the next 30-minute market as the last one closes
- Resolver: when a live market closes, reads `/api/gates/{id}/count?since=...` and calls `resolve()`. For replay markets, resolves with the `actual` value in `market_seeds.json`
- Market cards in the page (question, odds, pool sizes, countdown) if Kimball is busy on the globe
- Runs the server where everyone can reach it, owns the demo script, rehearsal and the backup video

## Interfaces (agree on these in the first 30 minutes, then don't change them)

Contract (full spec in `contracts/README.md`):
- `createMarket(string question, bytes32 series, int256 threshold, bool isAbove, uint64 closeTime) returns (uint256 id)`
- `takePosition(uint256 id, bool yes)` payable
- `resolve(uint256 id, int256 value)` oracle only
- `claim(uint256 id)`
- events `MarketCreated`, `PositionTaken`, `MarketResolved`, `Claimed`

Server (already running, see `server/app.py`):
- `GET /api/health`
- `GET /api/ships?max_age_minutes=60&bbox=minLon,minLat,maxLon,maxLat&types=cargo,tanker&moving_only=true`
- `GET /api/ship/{mmsi, IMO or name}`
- `GET /api/gates/{gate_id}/count?since=ISO_TIME`
- `GET /data/{file}` for anything in `data/processed/`, plus `/data/gates.json`
- To build: `POST /api/faucet` with `{"address": "0x..."}`

Data the page loads (all in `data/processed/`, described in `data/README.md`):
- Globe: `countries.json`, `countries.geojson`, `corridors.geojson`, `network_legs.geojson`, `lanes.geojson`, `portwatch_ports.json`
- Straits: `chokepoint_weekly.json`, `chokepoint_daily.json`, `chokepoint_status.json`
- Routes: `route_efficiency.json`, `efficiency_index.json`
- Overview: `overview.json`, `live_overview.json`
- Trade: `us_trade_pairs.json`, `country_trade_weekly.json`, `lane_cargo_mix.json`
- Markets: `market_seeds.json`
- Timeline: `events.json`
- Colours and fonts: `design/tokens.css`

Market `series` strings (so the page knows what a market is about):
- `portwatch:{Chokepoint name}:weekly_transits`
- `route_efficiency:{corridor_id}:expected_days` or `:efficiency`
- `route_efficiency:world:index`
- `comtrade:US:imports:{Partner}:monthly`
- `gate:{gate_id}:{minutes}min`

Numbers onchain are integers. Scale before sending: days and efficiency times 1000, dollar amounts in whole dollars, counts as they are.

## Timeline

| Hours | Kimball (page) | Person 2 (chain) | Person 3 (server) |
|---|---|---|---|
| 0 to 0.5 | Everyone: clone, set up, agree the interfaces above | | |
| 0.5 to 2 | Globe base: land dots, lanes, ships from `/api/ships` | Write and test `Markets.sol` and `Faucet.sol`, deploy to testnet | Faucet relayer, keeper that seeds 3 or 4 markets from `market_seeds.json` |
| **2** | **Checkpoint: one market created, a burner wallet funded, a position taken, the market resolved, all on testnet** | | |
| 2 to 4 | Vessel-type colours, strait valves, Red Sea and Hormuz replay, overview strip | Burner wallet in the page, `web/chain/` helpers, events feed | Live gate loop: open 30-minute markets on the Singapore Strait, resolve from the gate count |
| **4** | **Checkpoint: the page shows ships and markets, a position taken from the page lands onchain and shows up** | | |
| 4 to 5.5 | Positions-landing animation, block strip, then stretch goals | Claim flow, edge cases (market closed, already claimed) | Market cards, server reachable from everyone's laptop, open the demo's live market |
| **5.5** | **Feature freeze. Only bug fixes after this.** | | |
| 5.5 to 6.5 | Polish | Fix bugs | Rehearse the demo twice, time it |
| 6.5 to 7 | Record a 60-second backup video of the working demo | | |

## If we're behind

Cut in this order: vessel click, find your ship, trade ribbons, claim flow (resolve still shows who won). The minimum demo is the globe with the replay, the overview numbers, and one market that takes positions and resolves on stage.

## Running it

Kimball's laptop runs the ship logger (it needs the aisstream key, which is in `PRIVATE.md` and not in git) and the server. To let the other two reach the server, expose it with a tunnel, for example:

```bash
npx localtunnel --port 8787
```

Current tunnel: https://sharp-parrots-battle.loca.lt (it changes if the tunnel restarts; the new URL gets posted in the chat).

localtunnel shows a warning page to browsers. Code that calls the server has to send the header `bypass-tunnel-reminder: true` (the starter page already does). Opening a URL by hand in the browser, click through the warning once.

## Git

- `main` always runs. Work on your own branch (`web`, `chain`, `server`) and merge small pieces often.
- Pull before you start a new piece: `git pull origin main`.
- Never commit `PRIVATE.md`, private keys or `data/live/`. The `.gitignore` already covers them.
- If two people need to change the same file, say so in the chat first.

# Contracts

Shipping-delay markets on Monad. A trade manager whose cargo is on a ship can hedge against it arriving late. Anyone can open a market on a ship, a port or a strait. A pricing model sets the starting odds from the ship and trade data. Trading moves the price after that, and an AIS port arrival settles the market.

Everything is in native MON. Every trade, payout and vault deposit is a Monad transaction. The server prices markets and reports outcomes, but never holds anyone's money.

| File | What it is |
|---|---|
| `src/Markets.sol` | Markets and the underwriter vault: create from a signed quote, buy, sell, settle, redeem, deposit, withdraw |
| `src/Faucet.sol` | Gives each new burner wallet a little MON for gas |
| `test/Markets.t.sol` | Foundry tests: quotes, caps, hedging, early and invalid settlement, the vault, solvency fuzzing |
| `script/Deploy.s.sol` | Deploys both, seeds the vault, funds the faucet |
| `pricing/model.py` | The pricing model: P(late) for a ship and port, from live and processed data |
| `pricing/quote.py` | Builds and signs quotes (EIP-712) for `createMarket`. The server serves this as `POST /api/quote` |
| `pricing/arrival.py` | The settlement rule: when a ship has arrived, and what the oracle posts |
| `model/fpmm.py` | The market maker math in Python integers, with invariant checks |
| `markets/` | 65 example strait, route, trade and live-gate markets built from current data |
| `script/*.mjs` | Write deployment addresses for the page; open the example markets |

## How a market works

1. **Quote.** A trade manager picks a ship, a port and a deadline. The server runs `pricing/model.py` and signs a quote: the question, terms, starting price, size and caps. The quote is valid for 10 minutes and can be used once.
2. **Open.** Anyone sends the quote to `createMarket`. The contract checks the pricer's signature, so nobody can open a market at a price the model didn't give. The underwriter vault seeds the pool at that price. In the same transaction the hedger can buy YES ("late") and is covered immediately.
3. **Trade.** Speculators buy and sell YES and NO. Every trade moves the price, so the odds become the market's forecast.
4. **Settle.** The server watches the ship's AIS position:
   - Arrived before the deadline: it posts the arrival time, even before trading closes, and the market settles NO (on time).
   - Still at sea at the deadline: it posts the deadline, and the market settles YES (late).
   - Ship went silent: it calls the market invalid.

   If the server never settles a market, anyone can call it invalid after `resolveBy`, so money is never stuck.
5. **Redeem.** Each winning share pays 1 MON. In an invalid market, every share pays 0.5 MON. `settleVault` brings the vault's share back into the vault.

## Market kinds

| Kind | Example | Settles on | Priced by |
|---|---|---|---|
| Ship arrival | Will COSCO SAGITTARIUS arrive at Rotterdam after Nov 16, 19:45 UTC? | AIS arrival at the port (`pricing/arrival.py`) | `pricing/model.py`, live |
| Strait, weekly | Will fewer than 269 ships transit the Suez Canal in the week ending Nov 22? | IMF PortWatch | share of the last 12 weeks (`markets/`) |
| Strait by vessel type | Will at least 6 tankers transit Hormuz that week? | IMF PortWatch | same |
| Route | Will East Asia to North Europe take at least 35 days? | route efficiency index | last 8 weeks |
| Trade | Will US imports from China be at least $28.2B in October? | Census monthly release | last 3 months |
| Live gate | Will at least 11 cargo ships and tankers cross the Singapore Strait gate in the next 30 minutes? | server's gate counter | logger history |

Series strings (what the oracle and page key on):
- `arrival:{IMO}:{LOCODE}`
- `portwatch:{strait}:weekly_transits`, or `:weekly_tanker`, `:weekly_container` and the other types
- `route_efficiency:{corridor}:expected_days` or `:efficiency`
- `comtrade:US:imports:{partner}:monthly`
- `gate:{gate}:{minutes}min`

Values onchain are integers: arrival times and deadlines in unix seconds, days and efficiency times 1000, dollars whole, counts as they are.

## The starting price (`pricing/model.py`)

For "Will ship S arrive at port P after deadline D?", YES means late. The model forecasts the arrival time:

```
hours to go = sea distance / (speed × (1 − weather slowdown))
            + strait delay       for straits on the way that are running below normal
            + port wait          the destination's congestion
```

| Input | Source | Effect |
|---|---|---|
| Position, speed, vessel type, crew ETA | live AIS through the server's `/api/ship` | distance and speed; the crew ETA is blended in half-weight when it's within 3 days of the model |
| Sea distance | `searoute` if installed, else great circle × 1.2 | sailing time |
| Waves and wind at the ship | Open-Meteo marine and forecast APIs | slows the ship by up to 35% (4% per metre of wave over 2 m) and widens the uncertainty |
| Straits on the way | `chokepoint_status.json`, traffic against the 2023 baseline | if a strait is below normal, adds the shortfall × reroute days (Suez and Bab el-Mandeb: 9.2 days around the Cape) |
| Port congestion | `port_baselines.json`, `port_calls_weekly.json` | waiting time grows with calls above the baseline |
| Cargo mix | Comtrade lane mix (`lane_cargo_mix.json`) | doesn't move the odds: sets the cost of a day of delay (Hummels & Schaur, 0.6 to 2.1% per day) for the suggested hedge size |

Arrival time is treated as normally distributed around the forecast, with a spread that grows with distance, rough seas, disrupted straits and port congestion:

```
P(late) = 1 − Φ((deadline − expected arrival) / σ)
```

The result is clamped to 2% to 98% and becomes `priorYesBps`.

Example, live on Nov 15: COSCO SAGITTARIUS, 182 nm from Rotterdam at 10 knots, crew ETA Nov 16 12:00. The model expects arrival around 16:00 ± 4.3 h. A deadline 18 hours out prices at 71% late; 24 hours out, 20%. For $500k of cargo the suggested cover is about $4,000.

Try it:

```bash
python3 -I contracts/pricing/model.py "COSCO SAGITTARIUS" Rotterdam 24
```

## The market maker

Each market's pool holds `y` YES and `n` NO shares and keeps `y · n = k`. The price of YES is `n / (y + n)`.
- **Buying with `A` MON:** the fee comes off first, then `x = A(1 − f)` mints `x` complete sets. You get `y + x − k/(n + x)` YES shares.
- **Selling `s` shares:** you get `r = (B − √(B² − 4·s·n)) / 2` MON, where `B = y + s + n`, minus the fee.
- **Seeding at a starting price `p₀`:** with seed `L`, set `n = L, y = L(1 − p₀)/p₀` when `p₀ ≥ 0.5`. Otherwise mirror it.
- **Sizing a hedge:** `costForShares` returns the MON needed to buy enough cover.

All rounding favours the pool, so `k` never falls. `model/fpmm.py` reproduces the integer math and checks it over 5,000 random trades.

Example: a 10 MON pool at 30%. Buying 1 MON of YES gets 2.87 shares and moves the price to 39%. Selling them straight back returns 0.98 MON, so a round trip loses only the fees.

## The underwriter vault

Underwriters `deposit()` MON and get vault shares. The vault seeds every new market and is the liquidity provider in all of them. It earns:
- the 1 to 2% trading fees
- creation fees
- the premiums hedgers pay when shipments arrive on time

It loses when ships are late. `withdraw(shares)` pays out at the vault's value, but only from MON not tied up in open markets.

The vault's value is idle MON plus seeds in open markets, counted at cost. Gains and losses land when `settleVault` runs after each market settles. That keeps the accounting simple, but someone could time a deposit or withdrawal around a market whose outcome is already obvious. For the demo that's acceptable. A real version would value open positions at the market price, or lock withdrawals for a period.

## Caps against manipulation

Someone who controls a ship could slow it down and win "late" bets. Three limits make that not worth it:
- **Per subject:** `subjectCap` limits the vault's total seed across all markets on one ship, port or strait (default 3 MON).
- **Per market:** `maxCollateral` limits the MON in one market, so no single bet can be large (ship markets: 8 MON).
- **Close before the deadline:** trading closes before the deadline (6 hours, or a quarter of the time left if that's sooner). Nobody can trade on a ship already visible at the berth, and an arrival settles the market immediately anyway.

## Monad

- **Native MON everywhere.** No token approvals. A burner wallet with gas money can trade.
- **Parallel execution.** A trade writes only its market's struct and the trader's account, never vault totals or global counters. Trades on different markets don't conflict. Vault totals change only on create and settle. Each market's struct sits in consecutive storage, so a trade pays few cold-storage reads under Monad's per-page pricing.
- **Gas is charged on the gas limit, not gas used.** All senders estimate the gas and add 12%.
- **Testnet base fee is about 100 gwei** (measured Nov 15). Measured gas: `buy` ~66k (0.007 MON), `sell` ~68k, `redeem` ~43k, `createMarket` ~475k (0.05 MON), `settleVault` ~165k, `deposit` ~92k. The faucet drips 0.25 MON per burner, which is about 30 trades.
- **Blocks every ~300 ms.** Events arrive once per commit state (Proposed, Voted, Finalized), and public RPCs keep about 30 seconds of log history. The page reads state with the helpers in `web/chain/` and follows live changes over the websocket.
- Testnet: chain ID `10143`, RPC `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadvision.com`.

## Setup and deploy

```bash
curl -L https://foundry.paradigm.xyz | bash
```

```bash
foundryup
```

```bash
cd contracts
```

```bash
forge install foundry-rs/forge-std --no-git
```

```bash
forge test -vv --gas-report
```

Put these in `PRIVATE.md` (never committed) and export them:

```
MONAD_RPC_URL=https://testnet-rpc.monad.xyz
DEPLOYER_PRIVATE_KEY=0x...   # the 50 MON wallet
ORACLE_ADDRESS=0x...         # server key: settles markets, drips the faucet
PRICER_ADDRESS=0x...         # server key that signs quotes (can be the same)
PRICER_PRIVATE_KEY=0x...     # for script/seed_markets.mjs and the server's /api/quote
```

```bash
forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
```

```bash
npm install
```

```bash
node script/write_deployments.mjs
```

```bash
node script/seed_markets.mjs
```

`write_deployments.mjs` writes `contracts/deployments.json` and `web/chain/deployments.js`. `seed_markets.mjs` is a dry run of the featured example markets. Add `--send` to open them, and `--groups all` for every example market.

Budget for the 50 MON wallet:

| What | MON |
|---|---|
| Vault seed at deploy (`VAULT_SEED`) | 20 |
| Faucet, 40 burners at 0.25 (`FAUCET_FUND`) | 10 |
| Deploy gas | ~0.5 |
| Opening all 65 example markets: gas (~0.05 each) + creation fees | ~4 |
| Your own test trades and spare | ~15 |

The vault's 20 MON covers seeds of about 1 MON per ship market and 0.2 to 1 MON per example market.

## What the server needs to do

These are server-side, so they're for whoever owns `server/`:
- **`POST /api/quote`:** take `{ship, port, deadline, cargoUsd}`, call `pricing.quote.arrival_quote(...)` with the pricer key, and return the JSON. Needs `eth-account` in `requirements.txt`.
- **Settle arrival markets:** for each open `arrival:` market, run `pricing.arrival.settle(positions, port_area, deadline, now)` on the ship's logged positions. Then call `resolve(id, value)` or `resolveInvalid(id)` with the oracle key, then `settleVault(id)`.
- **Faucet:** `POST /api/faucet` calls `Faucet.drip(address)` with the oracle key.

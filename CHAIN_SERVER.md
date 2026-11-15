# Chain ↔ server: Xavi and Ben

Where the contracts (Xavi) meet the server (Ben): who owns what, the interfaces we've agreed, and the places we were about to do the same work twice. Edit freely, but keep to your own sections and tick boxes as you go.

Last updated: Nov 15, 2026, after merging Xavi's contracts into `main` (`137ef14`). Ben's `server/chain.py` and `/api/faucet` are on `ben's-branch` and not merged yet.

## Who owns what

| Area | Owner | Files |
|---|---|---|
| Contracts, tests, deploy | Xavi | `contracts/src`, `contracts/test`, `contracts/script` |
| Pricing model: starting odds, caps, quote terms | Xavi | `contracts/pricing/model.py`, `contracts/pricing/quote.py` |
| Arrival rule: when a ship has arrived | Xavi | `contracts/pricing/arrival.py` |
| Example markets and their priors | Xavi | `contracts/markets/` |
| Wallet and contract helpers for the page | Xavi | `web/chain/` |
| Server key: signing, sending, nonces | Ben | `server/chain.py` |
| HTTP endpoints: `/api/quote`, `/api/faucet`, `/api/markets`, `/api/chain` | Ben | `server/app.py`, `server/markets.py` |
| Keeper: opens markets, settles them, runs `settleVault` | Ben | `server/` |
| Railway: variables, the `/live` drive, uptime | Ben | Railway |

Rule: don't edit the other person's files. If you need a change there, write it under "Open questions" below or say it in the chat.

## Interfaces we both depend on

**`contracts/deployments.json`** is written by `node contracts/script/write_deployments.mjs` after each deploy and committed to `main`. It contains the chain ID, the RPC, the `markets` and `faucet` addresses, and their ABIs. Ben's `chain.py` reads this file only. The page reads `web/chain/deployments.js`, which the same script writes.

**Keys.** One server key does three jobs: oracle (settles markets), pricer (signs quotes) and faucet relayer.

| Setting | Where | What |
|---|---|---|
| `SERVER_PRIVATE_KEY`, or `PRICER_PRIVATE_KEY` | Railway variables, `PRIVATE.md` | The server key. `chain.py` accepts either name |
| `ORACLE_ADDRESS`, `PRICER_ADDRESS` | Xavi's shell at deploy | Both set to the server key's address: **`0x32F0A79FF9e4918D5771BF716ACba54219F1F78c`** (Ben made it; the private key is in Ben's `PRIVATE.md`) |
| `DEPLOYER_PRIVATE_KEY` | Xavi's `PRIVATE.md` only | The 50 MON wallet. Never on Railway |

**The quote struct.** It's defined in four places, and all four must match field for field, in this order:

```
question string, series string, subject bytes32, threshold int256, isAbove bool,
closeTime uint64, resolveBy uint64, feeBps uint16, priorYesBps uint16, seed uint256,
maxCollateral uint256, creationFee uint256, expiry uint64, quoteId bytes32
```

| Copy | File |
|---|---|
| The source of truth | `Markets.sol`: `struct Quote` and `QUOTE_TYPEHASH` |
| Server signing | `server/chain.py`: `QUOTE_FIELDS` |
| Pricing | `contracts/pricing/quote.py`: `QUOTE_TYPES` |
| Page and Node scripts | `web/chain/abi.js`: `QUOTE_TYPES` |

If Xavi changes the struct, Xavi updates the last two and tells Ben to update `QUOTE_FIELDS` in the same hour.

**Signing domain:** `{name: "Headway", version: "1", chainId: <from the node>, verifyingContract: <Markets address>}`. A Python-signed quote has been checked against viem: the digest and the recovered signer match.

**Series strings and units.** The value posted onchain is always an integer.

| Series | Value posted to `resolve` |
|---|---|
| `arrival:{IMO}:{LOCODE}` | Arrival time in unix seconds; the threshold is the deadline |
| `portwatch:{strait}:weekly_transits` | Ship count |
| `portwatch:{strait}:weekly_{tanker,container,dry_bulk,general_cargo,roro}` | Ship count of that type |
| `route_efficiency:{corridor}:expected_days` | Days × 1000 |
| `route_efficiency:{corridor}:efficiency` or `route_efficiency:world:index` | Index × 1000 |
| `comtrade:US:imports:{partner}:monthly` | Whole dollars |
| `gate:{gate}:{minutes}min` | Ship count |

## Overlap and redundancy, with proposed fixes

Ben, mark each one **agreed** or write what you'd rather do.

### 1. Quote signing is written twice
`chain.sign_quote()` (Ben) and `pricing/quote.py` `sign()` (Xavi) both sign the same EIP-712 quote.

**Proposal:** Xavi's code builds the quote and Ben's code signs it. `quote.py` returns unsigned quotes (terms, odds, caps, the model's working), and the server signs them with `chain.sign_quote()`. Xavi removes `sign()` from the server path; the Node seed script keeps its own signer for tests only.

- [x] Ben: agreed
- [x] Xavi: make `quote.arrival_quote()` return an unsigned quote by default (it does unless given a key; `sign()` is for local tests only)

### 2. Two tools open markets, from two different lists
Ben's keeper opens markets from `data/processed/market_seeds.json`. Xavi's `contracts/script/seed_markets.mjs` opens them from `contracts/markets/examples.json`. If both run, we get duplicate markets with different thresholds and close times:
- trade markets: September closing Nov 16 (seeds), October closing Dec 1 (examples)
- live windows: on the clock (keeper), now + 30 minutes (script)

**Proposal:** the keeper is the only thing that opens markets on the demo deployment, and `seed_markets.mjs` becomes a test tool for a scratch deployment.

We still need to decide which list the keeper reads:
- **(a) `examples.json`:** it has starting odds from the last 12 weeks, plus the strait-collapse and vessel-type markets that hedgers want. Thresholds there are already onchain integers (see 3).
- **(b) `market_seeds.json`:** it's what the keeper is built on now. Its markets would open at 50% unless the keeper calls the model for a starting price.

Xavi's preference is (a).

- [x] Decide (a) or (b): **(a) `examples.json`**, agreed by Ben
- [x] Xavi: make `seed_markets.mjs` refuse to run against the demo deployment without `--force` (or use `--deployments <scratch file>`)

### 3. Numbers would get scaled twice (this breaks things)
In `examples.json`, `threshold` is already the onchain integer, for example route days × 1000. `markets.py` `to_onchain()` scales again, which would turn 35000 into 35000000. `unit_and_scale()` also raises an error on the vessel-type series (`weekly_tanker` and so on).

**Proposal:** `to_onchain()` is the only place values are scaled for anything the oracle posts, because it's Ben's code that calls `resolve`. Market thresholds come from the quote unchanged.

- [x] Ben: if the keeper reads `examples.json`, use `threshold` as is (the keeper passes Xavi's quote through unchanged)
- [ ] Ben: `unit_and_scale()` treats any `portwatch:*:weekly_*` series as a ship count (agreed, building)

### 4. Live windows
The keeper lines windows up with the clock (:00 and :30) and Xavi's script used "now + N minutes". The keeper wins: the page countdown and the server already agree on clock-aligned windows. The quote for a live market should set `closeTime` to the window's **start**, or partway through it. Otherwise people can trade while they watch the count go up, and the vault pays for it.

- [x] Agree: trading on a live market closes **at the window start**, agreed by Ben. The keeper opens each window's market during the previous window, so people take positions first and then watch the ships cross

### 5. Settling arrival markets
Nobody has built this yet, so there's no overlap. Xavi wrote the rule; Ben runs it.
- `pricing/arrival.py` `port_area(port)` gives the port's geofence: the port-approach box in `data/gates.json` when there is one, else 8 nm around the port.
- `settle(positions, inside, deadline, now)` returns `("wait", None)`, `("resolve", unix_value)` or `("invalid", None)`.
- Positions are dicts with `time`, `lat`, `lon`, `sog` and `nav_status`, as the ship logger writes them.

After resolving, call `settleVault(id)` so the vault gets its money back.

- [x] Ben: keeper loop for open `arrival:` markets, every 20 seconds (`server/keeper.py`, tested on anvil: moored in Rotterdam before the deadline resolves NO, then `settleVault`)
- [x] Ben: positions per ship for the market's window (the keeper collects each report from the server's memory; `nav_status` now passed through)

### 6. Two `setting()` helpers that read `PRIVATE.md`
One is in `server/chain.py` (Python) and one in `contracts/script/env.mjs` (Node). They run in different places, so this is fine. Just keep the key names the same as the Keys table above.

## Checklist to a working demo

- [x] Xavi: deploy (`forge script ... --broadcast`), run `write_deployments.mjs`, commit `contracts/deployments.json` and `web/chain/deployments.js` to `main`. Markets `0x91655EF876726BC2730DC2FbF3a296688E552db5`, Faucet `0xf7D1255AEBDa35454121C3189850e48a5C82cDB9`; oracle, pricer and relayer all `0x32F0A79FF9e4918D5771BF716ACba54219F1F78c`; vault 20 MON, subject cap 3 MON
- [x] Xavi: send the server key about 2 MON for gas; the faucet gets 10 MON at deploy (both done; tx `0x93e00135…778b`)
- [ ] Ben: `SERVER_PRIVATE_KEY` in Railway variables, and add `web3` and `eth-account` to `requirements.txt` (`web3==8.0.0` added, which brings `eth-account`; Railway variable still to do)
- [ ] Ben: merge `chain.py` and `/api/faucet` to `main`, and check `/api/chain` shows `"on": true`
- [x] Ben: `POST /api/quote` with body `{ship, port, deadline, cargoUsd}`. It calls `contracts.pricing.quote.arrival_quote()`, signs with `chain.sign_quote()`, and returns `{quote, signature, model, hedge}`. Numbers go out as strings; `web/chain/markets.js` `requestQuote()` already expects this shape.
- [x] Ben: the keeper opens the demo markets (decision 2) and settles them (5). Runs only where `HEADWAY_KEEPER=1`; `KEEPER_GROUPS` picks the examples (default `featured`). Xavi: don't run `seed_markets.mjs --send` against the demo deployment
- [ ] Both: one full run on testnet: quote, create and hedge, trade, settle, redeem, `settleVault`

## Open questions

Add yours here.

- (Ben) Thin arrival pools: on a local test, a 0.1 MON hedge on a 1 MON arrival seed moved the price from 3% to 33%. Is the arrival `seed_mon` big enough for the demo?

- Is Railway's `/live` drive picking up history across restarts now? Check that Singapore's 30-minute gate count stays near its usual 11 after a redeploy.
- Demo exchange rate for hedge sizing: `usdPerMon` defaults to 1000 (so $4,000 of cover is 4 MON). Change it in one place if we want different numbers on stage.

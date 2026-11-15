# Contracts

Two contracts on Monad: `Markets.sol` (prediction markets priced by a fixed-product market maker) and `Faucet.sol` (gas for burner wallets). Everything is in native MON, and every trade, sale, settlement and payout is a Monad transaction. The server never holds anyone's money.

| File | What it is |
|---|---|
| `src/Markets.sol` | Markets: create, buy, sell, add and remove liquidity, resolve, redeem, claim fees |
| `src/Faucet.sol` | Gives each new burner wallet a little MON for gas |
| `test/Markets.t.sol` | Foundry tests, including a fuzz test for solvency |
| `script/Deploy.s.sol` | Deploys both contracts and funds the faucet |
| `model/fpmm.py` | The same math in Python integers. The server and page can quote with it; `python3 model/fpmm.py` checks the invariants |

## Setup

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
forge test -vv
```

## Deploy to Monad testnet

Put these in `PRIVATE.md` (never committed) and export them:

```
MONAD_RPC_URL=https://testnet-rpc.monad.xyz
DEPLOYER_PRIVATE_KEY=0x...      # the 50 MON test wallet
ORACLE_ADDRESS=0x...            # the server's key: resolves markets and drips the faucet
FAUCET_FUND=5000000000000000000 # 5 MON for the faucet
```

```bash
forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast
```

Then write the two addresses and the ABIs (`out/Markets.sol/Markets.json`, `out/Faucet.sol/Faucet.json`) to `contracts/deployments.json`.

Network: chain ID `10143`, RPC `https://testnet-rpc.monad.xyz`, websocket `wss://testnet-rpc.monad.xyz`, explorer `https://testnet.monadvision.com`, faucet `https://faucet.monad.xyz`. Mainnet is chain `143` if we ever need it.

A budget for the 50 MON wallet: 5 MON for the faucet (100 burner wallets at 0.05), about 1 MON seed per demo market (say 15 markets), and the rest for gas, test trades and spare.

## The pricing math

### Shares and collateral

Every market is a YES/NO question. 1 MON mints one *complete set*: 1 YES share and 1 NO share. When the market resolves, each winning share redeems for 1 MON and each losing share is worth 0. A complete set is therefore always worth exactly 1 MON, so the contract is always fully backed: every share in existence came from 1 MON locked in the contract.

All amounts are in wei: 10^18 shares pay 1 MON.

### The market maker

Each market has a pool holding `y` YES shares and `n` NO shares. Every trade keeps the product constant:

```
y · n = k
```

The price of YES, which you can read as the market's probability of YES, is

```
p = n / (y + n)
```

The scarcer YES is in the pool, the more it costs. Prices always lie strictly between 0 and 1, and YES and NO prices add to 1.

This is the fixed-product market maker (FPMM) Gnosis built for prediction markets, which early Polymarket used. We picked it over the alternatives:
- Parimutuel pools (our first spec) give no price at the moment you buy, and you can't exit early.
- LMSR needs `exp` and `ln`, which Solidity doesn't have built in. FPMM needs only multiply, divide and one square root.
- FPMM always has liquidity, so a hedger can buy at any time without waiting for a counterparty.

### Buying

You send `A` MON to buy YES. The fee `f` comes off first, leaving `x = A(1 − f)`:

1. `x` MON mints `x` complete sets into the pool: `y → y + x`, `n → n + x`
2. The pool gives you YES shares until the product is back to `k`:

```
y' = k / (n + x)
shares out = y + x − y'
n' = n + x
```

Buying NO is the same with `y` and `n` swapped. The contract rounds `y'` up, so rounding always favours the pool and `k` never falls.

### Selling

You hand back `s` YES shares. The pool takes them, burns `r` complete sets and pays you `r` MON. `r` is set so the product stays at `k`:

```
(y + s − r)(n − r) = y · n
```

That is a quadratic in `r`. We take the smaller root, which is always less than `n`:

```
B = y + s + n
r = (B − √(B² − 4·s·n)) / 2
```

The fee then comes off `r`. The contract rounds the square root up and `r` down, again in the pool's favour.

### Opening a market at a chosen price

The creator sends a seed `L` (at least 0.01 MON) and a starting probability `p₀`. The seed mints `L` complete sets. The pool keeps them at the ratio that makes the price `p₀`:

```
if p₀ ≥ 0.5:  n = L,  y = L(1 − p₀)/p₀,  creator gets L − y YES shares
if p₀ < 0.5:  y = L,  n = L·p₀/(1 − p₀),  creator gets L − n NO shares
```

The creator receives `L` LP shares. Their total exposure is exactly `L` MON.

The keeper can set `p₀` from history: for a weekly strait market, use the share of the last 8 weeks in `market_seeds.json` that met the threshold, clamped to between 10% and 90%. For live gate markets the thresholds were already tuned to open near 50%.

### Liquidity providers

Anyone can add MON to a market's pool with `addLiquidity`. It goes in at the current ratio, so the price doesn't move. Shares the pool can't absorb at that ratio go to the provider as outcome shares, and they get LP shares in proportion to the pool:

```
w = max(y, n)
y += x·y/w,  n += x·n/w,  LP minted = x · lpSupply / w
```

`removeLiquidity` gives back your fraction of `y` and `n` as outcome shares, at any time, including after resolution. Redeem them like anyone else's.

Fees (`feeBps`, at most 5%, set per market by its creator) go to LPs in proportion to LP shares. They're tracked with a per-market accumulator (`feesPerLp`), so paying them never loops over LPs. `claimFees` withdraws them.

The market maker's risk is that LPs end up holding the losing side. Fees and the creator's choice of `p₀` are what pay for that. The most an LP can lose is what they put in.

### Worked example

Seed 10 MON at `p₀ = 30%`, fee 1%:
- Pool: `y = 10`, `n = 4.286`, price 0.30. The creator holds 5.71 NO shares and 10 LP shares.
- Alice buys YES for 1 MON and gets 2.867 YES shares, an average price of 0.349. The price moves to 0.394.
- If she sells them straight back she gets 0.980 MON. The 2% loss is the fee taken on the way in and again on the way out, so a round trip never makes money.
- If YES wins, her 2.867 shares redeem for 2.867 MON.

### Hedge sizing

A shipper with cargo worth `V` expects a delay of `D` days if the strait is disrupted. Each day in transit costs about `c` = 0.6% to 2.1% of cargo value (Hummels and Schaur, 2013). Their loss if YES happens is

```
L = V · D · c
```

To cover it, they buy `L` YES shares (each pays 1 MON if disrupted, using a fixed demo rate from dollars to MON). `costForShares(id, true, L)` returns the exact MON to send, from solving

```
(y + x − S)(n + x) = y·n   →   x = (−(y + n − S) + √((y + n − S)² + 4·n·S)) / 2
```

and then dividing by `1 − f` for the fee. The premium as a share of cover is `cost / L`: roughly the price `p`, plus slippage on big orders, plus the fee. With the 10 MON pool above, covering 5 MON costs 1.93 MON, a premium of 39% against a price of 30%. On a thin pool, slippage is that large. Creators seeding deeper pools make hedging cheaper.

### Settlement

- `resolve(id, value)`: oracle only, after `closeTime`. YES wins if `value ≥ threshold` (when `isAbove`) or `value < threshold` (when not). Numbers are integers: days and efficiency times 1000, dollars in whole dollars, counts as they are.
- `redeem(id)`: pays 1 MON per winning share and clears both balances.
- Trading stops at `closeTime`.

## Monad: what we use and why it matters

**Everything is onchain, in MON.** Collateral is native MON (`msg.value`), not a wrapped token, so a burner wallet with only gas money can trade without any approvals. Buy, sell, add liquidity, resolve, redeem and claim fees are all Monad transactions from the user's own key. The server signs only three things: `createMarket` for the demo markets, `resolve`, and `Faucet.drip`.

**Parallel execution.** Monad runs transactions in parallel and re-executes any that touched the same storage. `Markets.sol` is laid out for that:
- A trade writes only its market's struct and the trader's own `accounts[id][trader]`. Two trades on different markets never touch the same slot, so markets on different gates trade fully in parallel.
- No global counters on the trading path. `marketCount` changes only in `createMarket`. There's no global volume or fee total.
- No global reentrancy lock (it would be one slot every trade writes). Checks-effects-interactions instead: every MON transfer happens after the state is updated.
- Fees go into a per-market accumulator, not a contract-wide pot.

**Storage pricing.** Monad charges the cold-access cost once per 128-slot page. Each market's struct is contiguous, and so is each `Account`, so a trade pays roughly two cold accesses.

**Gas is charged on the gas limit, not gas used.** This is the most important difference for the page. Never send a transaction with the wallet library's default or a padded estimate. Measure each function once (`forge test --gas-report`), then hard-code the gas limit at about 10% above that in `web/chain/`. Burner wallets hold only 0.05 MON, so oversized limits would drain them fast.

**Blocks every ~300 ms, near-instant finality.** That is faster than the 1 second in BRIEF.md. Odds update several times a second, so the page should animate between values instead of jumping.

**Reading events.** Public RPCs cap `eth_getLogs` at about 100 blocks, which is roughly 30 seconds. So:
- The page reads current state with `getMarket` and `priceYes` (that's why the question and series are stored onchain), not by replaying old logs.
- Live updates come from a websocket subscription. `monadLogs` / `monadNewHeads` give each block's `commitState` (Proposed, Voted, Finalized). The block strip can show a trade landing as Proposed, then turning solid when Finalized.

**Sending.** `eth_sendRawTransactionSync` is supported and returns the receipt in the same call, which is the simplest path for "position lands" animations. There is no global mempool and validation is asynchronous, so a nonce gap or low balance can be accepted and then fail. Burner wallets should track their nonce locally and send one transaction at a time.

**Contract size.** The limit is 128 KB instead of 24 KB, so there's room to grow.

## Events (the page draws from these)

- `MarketCreated(id, creator, series, question, threshold, isAbove, closeTime, feeBps, seed, priceYes)`
- `Trade(id, who, yes, isBuy, amount, shares, fee, yesReserve, noReserve, priceYes)`: one event for buys and sells. `priceYes` after the trade drives the odds bar.
- `LiquidityAdded`, `LiquidityRemoved`, `MarketResolved(id, value, outcomeYes)`, `Redeemed`, `FeesClaimed`

## Faucet.sol

- Holds testnet MON, funded at deploy.
- `drip(address to)`: relayer only (the server's key), sends `amount` (0.05 MON) once per address.
- `setRelayer`, `setAmount`, `withdraw`: owner only.

## Roadmap, not built

- A dispute window before redemption opens, so anyone can challenge a posted number against the public PortWatch or Census data.
- An `invalid` outcome that redeems YES and NO at 0.5 each, for a market whose data never arrives.

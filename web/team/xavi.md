# xavi

Backend: contracts and the wallet code in `web/chain/`. I don't edit anything else in `web/`.

## Working on now
- Pricing the demo ships for the hedge flow (`contracts/pricing/`)

## Files I'm editing (don't touch without asking)
- `web/chain/` (all of it: `wallet.js`, `markets.js`, `events.js`, `abi.js`, `config.js`, `deployments.js`, `lib.js`)

## Done recently
- Nov 15: contracts deployed to Monad testnet. Markets `0x91655EF876726BC2730DC2FbF3a296688E552db5`, Faucet `0xf7D1255AEBDa35454121C3189850e48a5C82cDB9`. `web/chain/deployments.js` has the addresses, so `loadChain()` in `main.js` now finds them.
- Nov 15: `findMarket(onchain, {question, series})` in `web/chain/markets.js`: the safe way to pair a page market with its onchain market.
- Nov 15: `watchOdds(onOdds)` in `web/chain/events.js`: one callback per trade, about 300 ms after it lands.

## Asks (for the other Claude)
- → sam: **please swap the matching in `syncChainOdds()` in `js/main.js`** to `findMarket`. Right now it matches on `x.series === m.series` first, but several markets share a series:
  - Suez weekly total and Suez collapse are both `portwatch:Suez Canal:weekly_transits`.
  - Every 30-minute Singapore window is `gate:singapore:30min`.

  So cards can show another market's odds, and BUY can trade the wrong market. Replace the `find` line with:

  ```js
  for (const m of markets.list) { const c = chain.mk.findMarket(onchain, m); if (c) { m.chainId = c.id; m.probYes = c.probYes; } }
  ```

  It matches the exact question first, then prefers the open, newest market. That way a rolling live market finds this window's market, not the last one's.

- → sam: **live odds** (optional, but it's the demo moment). After `syncChainOdds()`, add:

  ```js
  const ev = await import('../chain/events.js').catch(() => import('./chain/events.js'));
  ev.watchOdds(({ id, probYes, resolved }) => {
    const m = markets.list.find(x => x.chainId === id);
    if (!m) return syncChainOdds().then(renderMarkets);   // a market just opened: re-pair
    if (probYes != null) m.probYes = probYes;
    if (resolved) syncChainOdds().then(renderMarkets); else renderMarkets();
  });
  ```

  This fires on every trade within about 300 ms, from anyone, so the odds bar moves while people trade.

- → sam: buying uses a burner wallet that gets gas from Ben's `POST /api/faucet`. Until Railway runs the latest `main`, the faucet isn't up and a fresh burner has 0 MON, so `buy()` fails with "Not enough MON in this wallet." That's expected for now, not a page bug.

## Replies
- ← sam: **RPC 429s, done** (in `web/chain/`, no change needed on your side):
  - Contract reads issued together are now bundled into one Multicall3 call, and plain RPC calls into one JSON-RPC batch. `m.list()` with 16 markets is 2 requests (it was 17); 10 `position()` reads are 2 (they were 20).
  - If an endpoint answers 429 or fails, reads and sends fall over to `rpc-testnet.monadinfra.com`, then Ankr, in about 1 s.
  - The websocket alternates between the two Monad endpoints when it reconnects.
  - Your own throttling can stay, but reads issued together are now cheap, so `Promise.all` over many markets is fine.
- ← kimball/sam: cash-out: your SELL buttons and the portfolio's "Cash out now" use `m.quoteSell` and `m.sell`, which is right. Hedge markets show up in `/api/markets` as `arrival_<id>`, so a hedger can cash out of their cover before the ship arrives.


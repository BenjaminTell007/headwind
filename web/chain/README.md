# web/chain

Wallet and contract helpers for the page. Plain ES modules, no build step: viem is loaded from jsDelivr at a pinned version (`lib.js`).

| File | What it does |
|---|---|
| `wallet.js` | Burner wallet (key in localStorage, funded from the faucet) or MetaMask. `send()` estimates gas, signs, sends and returns the receipt |
| `markets.js` | Read markets and positions, buy, sell, redeem, add liquidity, create, and size a hedge |
| `events.js` | Websocket feed of trades, new markets, settlements and blocks, with Monad's commit state |
| `abi.js` | The contract ABIs as plain strings (shared with the Node scripts in `contracts/script/`) |
| `config.js` | Monad testnet and the server URL (Railway) |
| `deployments.js` | Contract addresses, written by `contracts/script/write_deployments.mjs` after a deploy |

## Use it from the page

```js
import { getWallet } from './chain/wallet.js';
import { markets, parseMon, formatMon, explain } from './chain/markets.js';
import { watch } from './chain/events.js';

const wallet = await getWallet();            // burner; asks the faucet for gas if empty
const m = await markets();

const list = await m.list();                 // [{ id, question, series, probYes, closeTime, open, resolved, ... }]
const r = await m.buy(wallet, list[0].id, true, parseMon('0.01'));
r.trade.shares;                              // YES shares received
r.trade.priceYes;                            // price after the trade (1e18 = 100%)

const hedge = await m.hedge(id, { cargoUsd: 500_000, delayDays: 12 });
// { lossUsd, coverMon, costMon, premium, probYes }

const stop = await watch({
  onTrade: (t) => {},     // t.commitState: 'Proposed' first, then 'Voted', 'Finalized'
  onBlock: (b) => {},     // ~3 per second
  onCreated: (c) => {},
  onResolved: (r) => {},
});
```

Errors: wrap writes in `try` and show `explain(err)`, which turns contract reverts into a sentence ("The price moved before your trade landed").

## Things that are different on Monad

- **Gas is charged on the gas limit, not gas used.** `wallet.send()` estimates each transaction and adds 12%. Don't pass a big fixed `gas`.
- **Base fee is about 100 gwei on testnet** (measured Nov 15), so a trade (~66k gas) costs about 0.007 MON. The faucet drips 0.25 MON per burner, enough for about 30 trades plus small stakes. Opening a market (~475k gas) costs about 0.05 MON. Keep stakes around 0.01 to 0.05 MON.
- **Blocks every ~300 ms.** `eth_sendRawTransactionSync` returns the receipt in one call; the wallet falls back to send-and-poll if a node doesn't take it.
- **Every event arrives several times,** once per commit state (Proposed, Voted, Finalized, Verified). Animate on Proposed and firm up on Finalized, or filter to one state.
- **There's only ~30 seconds of log history** on public RPCs, so read current state with `markets.js` on load and use `watch()` for changes after that.
- **One transaction at a time per burner.** The wallet queues sends and tracks the nonce itself, since Monad accepts nonce gaps and then fails them.

## Needs from other folders

- `deployments.js` is filled in by `contracts/script/write_deployments.mjs` after deploying. It's a module, not a fetch, so the page works wherever `web/` is hosted.
- The server's `POST /api/faucet` drips gas to new burners. Until it's built, burners start empty: use MetaMask with testnet MON, or send a burner some MON by hand.

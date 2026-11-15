# Demo run sheet

For the 7:30 pm Pacific slot (03:30 UTC, Nov 16), the time the `_c17` markets were set for. If the slot moves, move every time below with it, and keep the bet in step 4 on the window that ends just after you start.

Live windows run on the clock: :00–:30 and :30–:00 UTC. Betting on a window closes when it **starts**, and the keeper settles it about 2 minutes after it **ends** (90 s for the ship logger to write its last positions, then two transactions).

## 1. By 5:30 pm Pacific (01:30 UTC): ship the code

- [ ] Merge `sam's-branch` → `frontend` → `main` (run `web/tools/stamp.sh` first). This is the last push to `main` that touches `server/`, `contracts/`, `scripts/` or `data/`. After it, `railway.json` makes Railway redeploy only for those folders, so later web-only merges don't restart the server.
- [ ] Wait for Railway, then check:
  - `https://headway-production-83bb4bd7.up.railway.app/api/health`: `commit` is the new one
  - `/api/chain`: `"on": true`
  - `/api/keeper`: the log shows `retired #0` … `retired #6` (5 MON back in the vault) and a `live_singapore@…` market opened for the next window

## 2. By 6:00 pm Pacific (02:00 UTC): money

The demo wallet is Sam's, `0x19468301F9D26cb9b8aDD31C9e7b66B33ad09655` (50 MON on testnet). Use it in Chrome with the wallet extension, on Monad testnet (chain 10143).

- [ ] **Vault, 15 MON:** markets page → UNDERWRITE → USE MY WALLET → deposit 15. Every hedge and every live window takes a 1 MON seed from the vault; without this it runs out after about five hedges, and then the keeper can't open the next live window either.
- [ ] **Faucet, 10 MON:** send 10 MON from the wallet to the faucet contract `0xf7D1255AEBDa35454121C3189850e48a5C82cDB9` (a plain transfer; it accepts MON). That's 40 more test wallets at 0.25 MON each; it holds 8.5 now (34 wallets).
- [ ] **Server key, 2 MON:** send 2 MON to `0x32F0A79FF9e4918D5771BF716ACba54219F1F78c`. It pays the keeper's gas, about 0.17 MON an hour, plus the re-pricing bot.
- [ ] Keep about 20 MON in the wallet for the stage.

## 3. By 6:30 pm Pacific (02:30 UTC): rehearse once, record the backup

- [ ] Run sections 4 and 5 once end to end and time it.
- [ ] Record the 60-second backup video.
- [ ] Open a hedge on a real ship (HEDGE A SHIP), so My trades already has one to show.

## 4. 6:30 to 6:58 pm Pacific (02:30–02:58 UTC): the bet that settles on stage

- [ ] On the Live card for Singapore, bet on the **03:00–03:30 UTC** window (its betting closes at 03:00). This is the one that settles while you're on stage, at about 03:31:30–03:32 UTC.
- [ ] Nobody pushes to `main` from here on.

## 5. On stage (about 60 s)

1. **Globe.** Logo, globe, live ships coloured by type. Forecasts page for the key numbers.
2. **Markets page, Live section.** The Singapore card: the window being counted right now, "N of 11" ships so far.
3. **Place a bet from the wallet** on the next window. Point at the block strip along the bottom: one cell per Monad block, about 0.3 s each, faint when proposed and solid when finalized. Your bet's block lights up blue, and the confirmation says which block and how many seconds it took.
4. **Hedge a ship.** HEDGE A SHIP → ship and port → GET A PRICE. Show what the model sees (distance, speed, weather, port wait), then OPEN MARKET AND HEDGE: one transaction opens the market and buys the cover.
5. **Settlement.** At about 03:31:30 UTC the 03:00 window settles. My trades → CLAIM.
6. **Underwrite.** UNDERWRITE shows the vault: anyone can be the other side of every market.

Don't:
- Bet in the first minute after :00 or :30. The next window's market is still opening.
- Push anything to `main`.

## If something breaks

- **Odds or lists stop updating:** the page falls back to other RPCs by itself (Xavi's change). Refresh once.
- **Your wallet won't connect:** USE TEST WALLET (top right) switches to a free test wallet.
- **"This test wallet has used its free MON":** each test wallet gets MON once. Switch to USE MY WALLET.
- **Server down:** play the backup video.

## Say this, not that

| Instead of | Say |
|---|---|
| "No house" | "The other side is an open vault anyone can deposit into" (show UNDERWRITE) |
| "Anyone can open a market on any strait or trade pair" | "Anyone can open a hedge on any ship we can see" (only arrival quotes are signed on request; 58 more strait, route, trade and live-gate markets are priced and ready to open) |
| "Settles on official data" | "Live windows settle on our gate count and hedges on the ship's AIS arrival; weekly and trade markets settle on PortWatch and Census when the data is out. The oracle is our server for now; the data is public, so a dispute window is the fix" |
| "1-second blocks" | "Blocks every 0.3 s" (the strip shows it) |

## Not in this build

BRIEF demo steps 2 (US–China ribbons), 5 (imports release settling) and 6 (Red Sea replay) depend on features that aren't on the page. Skip them.

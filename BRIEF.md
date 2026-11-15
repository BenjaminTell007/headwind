# Headway

Project brief for Monad Blitz, November 15, 2026. This is everything I want to build, why, and the order I'm building it in.

## One line

A tool for forecasting and hedging trade disruptions: it tracks what countries ship each other and the real ships moving it through the world's chokepoints, and lets anyone take positions on what happens next in markets that settle onchain on Monad against official trade and shipping data.

## The problem

Trade keeps getting hit by shocks. The Red Sea attacks roughly halved Suez traffic in early 2024, Panama's drought cut canal volume by about a third in 2023, and tariffs keep changing. Two things make this worse than it needs to be:

1. Nobody knows the effect for weeks. The Census monthly trade release comes out about 5 weeks after the month ends.
2. Small shippers can't hedge any of it. Freight futures exist but start at 10 containers and go through brokers. Nobody sells a small firm protection against a canal closing.

## Who it helps

- Shippers, importers and freight forwarders whose cargo goes through a chokepoint. They can find their own ship, see which chokepoint threatens it, and hedge.
- Anyone who needs a read on trade before the official data lands: analysts, journalists, policy people, traders. The market odds are a live forecast.
- Anyone curious about trade. The country-pair explorer works on its own.

## What it is

The landing view has an overview strip before you click anything, then three screens on one globe.

**Overview (before any clicks).** A strip of big numbers along the top of the globe, updated from PortWatch and the live ship sample:
- Transits through each chokepoint this week vs its one-year average, as a % deviation with a sparkline (SUEZ −xx% VS 1-YR AVG, filled from the real data)
- Share of Asia to Europe traffic going around the Cape instead of through Suez, from PortWatch's Cape of Good Hope and Suez counts
- Average extra distance and days for a rerouted voyage, from `searoute` distances on the main lanes (for example Shanghai to Rotterdam via Suez vs via the Cape)
- Estimated time cost of rerouting this week: extra days times the value of trade on those lanes times 0.6 to 2.1% per day (Hummels & Schaur), always shown as a low to high range and labeled as an estimate
- From the live sample: ships tracked right now, average speed vs normal for each vessel type, and the share of ships more than 50 nautical miles off their expected lane
- Average market-implied odds of disruption across the open chokepoint markets

Where two sources give different numbers (PortWatch's weekly counts vs what the live sample shows today), I show both with the method next to each instead of picking one.

**Explore.** Click two countries. The arc between them turns into a ribbon split into product bands (width is dollar value), one ribbon each way, so the trade balance shows as one side being fatter. Hover a band for the value and share.

**Forecast.** The product covers every route, not a few named places. Prediction markets on four kinds of questions:
- Route efficiency: every corridor between world regions (210 of them) has an expected transit time and an efficiency index, computed each week from how much traffic is getting through the passages on that route. "Will East Asia to North Europe take at least 35 days next week?" There's also one world index across all routes. This is the main product, because it's what a shipper actually cares about: how long and how reliable is my route.
- Straits and canals: all 28 that IMF PortWatch tracks, not only the famous ones. "Will Suez transits stay above X next week?" Settles on PortWatch daily transit counts.
- Trade pairs hit by tariffs: "Will US imports from Switzerland be above $X in December?" Settles on the official monthly release.
- Live markets that settle in 30 to 60 minutes (the overnight log showed 10 minutes is too short: even the busiest gate gets under 4 trade ships per 10 minutes). I draw gates (a line across a strait, a box around a port approach) and the live ship feed counts what crosses them. "Will at least 11 cargo ships and tankers cross the Singapore Strait gate in the next 30 minutes?" opens, people take positions, ships cross on the globe in real time, and it settles while everyone's watching. The free ship feed only covers some waters, so live markets run where it's dense:
  - Straits and rivers: Singapore Strait, Dover, Gibraltar, Oresund, Juan de Fuca, Tokyo Bay, the Scheldt and the Elbe
  - Port approaches: Rotterdam, Antwerp, Singapore, Los Angeles/Long Beach, Hong Kong, Houston, New York
  - Other live questions on the same feed: ship arrivals at a port in the next 30 minutes, average speed along a route, how many tankers pass a gate
  - Malacca, Hormuz, Suez and Bab el-Mandeb have no live coverage in the free feed, so those are weekly markets only

The weekly and monthly markets are the real forecasting and hedging product. The live markets are the proof, on stage, that markets this short and this cheap actually work.

I'm not putting a market on every country pair. Most would sit empty. Markets go where the shocks are, and the explorer covers every pair.

**Hedge.** Type in a vessel name or IMO number. The ship shows up live, its route lights up through the chokepoints it'll pass, and the panel shows the odds on those chokepoints. Enter cargo value and category and it estimates what a closure would cost you and suggests a hedge size. One tap to take the position.

**Clicking a vessel.** The camera flies in to the ship. Wind particles stream past in the real wind direction and wave height shows as a ring around the hull. The panel shows:
- Vessel: name, type, flag, size, speed, heading, destination, ETA, draught
- Weather at its position: wind, waves, swell, sea temperature
- Route: next chokepoint, time to get there at current speed, that chokepoint's market odds, hedge button
- Deviation from route: how far the ship is from the expected sea lane to its reported destination (cross-track distance in nautical miles), extra distance and extra days at current speed if it keeps going this way, a flag if it's routing around the Cape, and how its reported ETA compares with what the lane and its speed imply. The expected lane shows as a faint ghost line next to the ship's actual heading.
- Likely cargo, labeled as an inference: "based on route and vessel type, not this ship's manifest." Draught tells me whether it's loaded or empty, and the lane's typical product mix comes from Comtrade. I don't claim to know what a specific ship is carrying because manifests are private.

Ships only. Planes and order-to-delivery times are out (no chokepoints for planes, and delivery times have no public number to settle on).

## Where the blockchain comes in

- Anyone can open a market on a chokepoint or a trade pair. That's a long tail Polymarket will never list, and it only works if creating a market and taking a small position cost almost nothing. That's the Monad part.
- The live markets are the strongest case for Monad. A 30-minute market that people actually trade, opening and settling over and over across many gates, only makes sense on a chain with near-zero gas and 1-second blocks.
- There's no house. The contract holds every stake and pays out against the posted official number, and the rules are public.
- Odds update every block as people take positions, and 1-second blocks make that visible on screen.
- The honest caveat: for the demo I post the official number myself, and for the live markets my server counts the gate crossings. The roadmap answer is a dispute window, since Census and PortWatch data are public and anyone can check them, and AIS crossings can be checked against other ship trackers.

## The economics

- A market that pays in one specific state of the world is an Arrow security. Buying YES on "Suez transits collapse" is a hedge if your cargo goes through Suez.
- Prices aggregate scattered information (Hayek), which is why the odds work as a forecast while the official data is still weeks away.
- Hedge sizing uses Hummels & Schaur (2013, AER, "Time as a Trade Barrier"): each day in transit costs about the same as a 0.6 to 2.1% tariff, more for time-sensitive goods. Rerouting Asia to Europe around the Cape instead of Suez adds roughly 10 to 14 days.

Example: $500k of electronics, Shanghai to Rotterdam via Suez. A closure adds about 12 days, which is roughly 12 to 25% of cargo value in time cost. The app suggests a position sized to cover that.

## Visuals

Build these three first:

1. Shipping lanes. Ships move as particles along real sea lanes (precomputed with `searoute`), with density from PortWatch transit counts. Each particle is coloured by vessel type (see Look and feel). Moving ships are drawn as short streaks, longer the faster they go, and ships at anchor or in port are drawn as dots. Each chokepoint is a valve whose opening scales with transits against its one-year average. Replaying the Red Sea in 2024, the Suez valve pinches, the streaks back up and turn into dots as ships wait, then stretch out again as they bend around the Cape.
2. Trade bridge. The two-way product ribbons between countries.
3. Positions landing. Each position drops as a particle into a YES or NO pool with a ripple, and a spring-loaded odds bar settles. A strip along the bottom pulses once per Monad block and my transaction lights up in the block it landed in.
4. Overview strip. Mono caps numbers with sparklines across the top. Most of it is precomputed from PortWatch and `searoute` tonight, so it's cheap to build.

If there's time:

5. Find your ship, with the cost-of-delay panel and a days-of-delay slider
6. Vessel click with the zoom, wind field and wave ring
7. Deviation layer: color ship particles by how far off their expected lane they are, with ghost lines for the planned route on the clicked ship
8. Replay scrubber from 2023 to 2025 with annotated events (Panama drought, Red Sea, tariffs)
9. Chokepoint ridgelines of daily transits, where the Red Sea collapse shows as a cliff

## Look and feel

The look builds on my 423 watch page (dark, dotted globe, mono caps labels, callouts with leader lines, physics) but swaps the single blue accent for a palette where every colour means a vessel type. The logo, the globe and the panels all use the same colours, so the logo doubles as the legend.

Background and neutrals

| Use | Colour |
|---|---|
| Page and globe background (charcoal) | `#222222` |
| Land dots | `#3a3a3a` |
| Panel lines and dividers | `#2e2e2e` |
| Main text | `#ececec` |
| Secondary text and labels | `#8c8c8c` |

Vessel types (the only things that get a hue)

| Vessel type | Colour | PortWatch field |
|---|---|---|
| Container | `#f08a3c` orange | `n_container` |
| Tanker | `#8f82f2` purple | `n_tanker` |
| Dry bulk | `#46b36f` green | `n_dry_bulk` |
| General cargo | `#ea86b5` pink | `n_general_cargo` |
| Ro-ro (car carriers) | `#e9c84b` yellow | `n_roro` |
| Other or unknown | `#f2f2f2` off-white | |

Rules

- Hue only ever means vessel type. Everything else (route efficiency, chokepoint shortfall, market odds) is shown with brightness, opacity, thickness or length, never a new colour. A route running normally is bright; a route losing efficiency dims; a blocked passage goes to dotted grey.
- Particle mix follows the data: at each chokepoint the share of orange, purple, green, pink and yellow particles matches that week's PortWatch counts by vessel type. Hormuz is mostly purple, and when it closes the purple drains out.
- Dots mean waiting, streaks mean moving. Ships at anchor, in port or queued at a closed passage are dots. Ships underway are streaks.
- The globe's land and port markers can borrow the logo's glyph grid: land as dim dots, ports as small glyphs whose shape and colour show their main vessel type.
- Markets: YES pool `#f2f2f2`, NO pool `#6b6b6b`, so they never clash with a vessel type. A position landing takes the colour of the vessel type the market is about (a Hormuz market lands purple, a Suez container market orange).
- Live gates are thin off-white lines; a crossing ship flashes its vessel colour as it passes.

Type

- Wordmark and labels: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`, light weight (300), caps with wide letter spacing, same as the 423 page.
- Headings and body: `-apple-system, BlinkMacSystemFont, "Inter", "Helvetica Neue", Arial, sans-serif`, weight 400 or 500.
- Status tags in the style `SYS.ROUTES: 210 · STRAITS: 28` and `SYS.STATE: UNDERWAY`.

Logo

- HEADWAY in the mono type, built on a grid where every cell is a small glyph: filled square, circle, ring, plus, diamond, small dot, striped square, ring with a centre dot, square with an inner square.
- Glyphs and colours sit in patches that slowly shift in place: a patch of orange squares turns into purple rings, then green pluses. Sizes swell and shrink a little, and the odd cell flashes white. Nothing moves out of the letters, no swirl.
- Colours come from the vessel palette, with a darker and lighter shade of each so the patches have depth.
- Code is in `design/logo.html`, colours and fonts in `design/tokens.css`.

## Data

| What | Source | Cost | Notes |
|---|---|---|---|
| Chokepoint transits | IMF PortWatch (portwatch.imf.org, also on HDX) | Free | Daily counts, about 24 to 28 chokepoints, updated weekly, API returns 1,000 rows per call. Check how recent the data is. |
| Live ship positions and vessel info | aisstream.io | Free key | Websocket, beta, no SLA. Run it through a small backend, keep preset ships as a fallback. |
| Weather at the ship | Open-Meteo forecast and marine APIs | Free, no key | Wind, waves, swell, sea temp |
| US trade by partner and product | Census international trade API | Free | Monthly, by country and HS chapter. Start with the US and its top 20 partners. |
| Product mix on other lanes | UN Comtrade or CEPII BACI | Free | For the "likely cargo" panel |
| Sea lane geometry | `searoute` Python package | Free | Precompute routes to JSON. Also gives the Suez vs Cape distances for the overview. |

Caveats for the live markets:
- They depend on aisstream coverage at each gate. Coverage is good near busy coasts and patchy offshore, so I'll test every gate tonight and only open live markets on gates with steady traffic.
- Gate thresholds (the "6 ships" part) come from the logger's counts tonight, so each market opens near even odds.

Caveats for the deviation numbers:
- aisstream only gives live positions, not history. A ship's past track only exists if I record it myself, so I'll start a small logger tonight and let it collect a few hours of positions. Full historical tracks are paid data.
- The AIS destination field is typed in by the crew and is often messy or blank. Deviation is only computed when the destination matches a known port, otherwise the panel says "no destination reported."
- Rerouting share should come from PortWatch counts (Cape vs Suez), not from my live sample, because the free stream's coverage is patchy far offshore.
- Check that Cape of Good Hope is in PortWatch's chokepoint list.

## Contracts

Two small contracts. Simple YES/NO pools, no LMSR (it needs exp and ln math, which Solidity doesn't have built in).

Markets:
- `createMarket(series, threshold, isAbove, closeTime)`
- `takePosition(marketId, yes)` payable, adds to the YES or NO pool
- `resolve(marketId, value)` oracle only, posts the official number
- `claim(marketId)` winners split the pool in proportion to their stake
- Odds are YES pool / total pool

Live markets use the same contract with a short `closeTime`. The extra piece is off-chain:
- A gate counter on my server reads the aisstream feed, counts ships crossing each gate line, and calls `resolve` when a market closes
- A small loop opens the next market on each gate as the last one settles, so there's always one live per gate

Faucet:
- `drip(address)` called by my relayer key, sends a little testnet MON to each new burner wallet

Burner wallets: the page generates a private key on load and keeps it in localStorage, then asks the faucet for gas. Nobody in the audience has to install MetaMask.

## Demo (about 60 seconds)

1. Open on motion, no numbers yet: the HEADWAY glyph logo shifting in its colours, then the globe with ships coloured by vessel type, bending around the Cape of Good Hope instead of going through Suez. After a few seconds the overview strip fades in with how far each chokepoint is off normal and what rerouting is costing this week.
2. Click US and China. The ribbons show electronics and machinery dominating, and the imbalance is obvious.
3. Open a December imports market. Two wallets take positions, particles drop into the pools, and the odds move in real time.
4. Go to a live gate, say the Singapore Strait. A 30-minute market is open (it was opened before the demo started), positions land, ships cross the gate on the globe as the counter ticks up, and it settles before the demo ends.
5. Replay the imports release. The market resolves and the winner is paid.
6. Spin to the Red Sea and replay 2024. The Suez stream thins, ships reroute around Africa, the chokepoint market resolves and hedgers get paid.
7. If built: type a real ship's name, the camera dives to it mid-ocean in real weather, its route lights up through Suez, and I hedge it in one tap.

## Pitch (about 30 seconds)

Trade keeps getting hit by shocks: tariffs, the Red Sea attacks, Panama's drought. Official trade data shows up five weeks late, and a small shipper has no way to hedge a closed canal. Headway puts live markets on the trade routes that matter. Click any two countries and see exactly what flows between them. Find your own ship and see which chokepoint threatens it. The markets tell you what the crowd expects, and anyone exposed can take the other side as a hedge. Everything settles on official Census and IMF shipping data, and Monad makes a thousand tiny markets cheap enough to exist.

## Questions I should expect

- **Why Monad and not a database?** No house holds the money, anyone can open a market, and creating thousands of tiny markets only makes sense with near-zero gas and fast blocks.
- **Who actually trades this?** Shippers with cargo through a chokepoint are real hedgers. Everyone else is trading on information, which is what makes the odds a useful forecast.
- **Isn't the oracle just you?** For the demo, yes. The data is public, so a dispute window is the fix. For live markets, gate crossings can be checked against any other AIS tracker.
- **Who trades a 30-minute market on ship crossings?** Nobody hedges 30 minutes. The live markets show that the mechanism runs at this speed and cost. The real hedging is on the weekly and monthly markets.
- **Liquidity?** Markets only go where the shocks are, not on every pair.
- **Basis risk?** A chokepoint market isn't your exact shipment. It's close, and the closer hedge (per-shipment cover) already exists from Otonomi, but it's sold by an insurer, not a market.
- **Can insiders manipulate it?** That's why there are no markets on individual ships.
- **Isn't this gambling?** It's a testnet demo. Prediction market regulation is a real question for a live product.

## Build plan

Tonight:
- Read the event rules: team size, and whether I can reuse my 423 globe code
- Install Foundry, set up a wallet with Monad testnet, get MON from the faucet
- Pull PortWatch for Suez, Panama, Hormuz and Malacca into JSON
- Pull Census monthly trade for the US and its top partners by HS chapter
- Precompute sea lanes with `searoute`, plus Suez vs Cape distances for the main Asia to Europe lanes
- Precompute the overview numbers: transits vs one-year average, Cape share, extra days, time cost range
- Start an aisstream logger so I have a few hours of ship tracks by morning
- Draw the live gates (straits and port approaches), check aisstream coverage at each, and set thresholds from the logger's counts
- Pick 2 or 3 real ships at sea as presets
- Check the 2025 US tariff dates on Switzerland (I think 39% in August, cut to 15% in November)

Tomorrow:
- Hour 1: markets and faucet contracts, deploy, seed 3 or 4 markets
- Hour 2: burner wallets, faucet drip, position flow working end to end, gate counter resolving live markets
- Hours 3 to 4: globe with sea lanes, chokepoint valves, PortWatch replay
- Hour 5: overview strip, trade bridge ribbons and market cards
- Hour 6: position particles and block strip, then find your ship, the vessel click and the deviation numbers if there's time
- Hour 7: rehearse, record a 60-second backup video in case the wifi dies

If I'm behind, I cut in this order: vessel click, find your ship, trade bridge. The shipping lanes with the Red Sea replay and one working market are the minimum demo.

## Sources

- IMF blog on the Red Sea attacks: https://www.imf.org/Blogs/Articles/2024/03/07/Red-Sea-Attacks-Disrupt-Global-Trade
- PortWatch chokepoint methodology: https://worldbank.github.io/alternative-data-for-crisis/notebooks/disruptions-business-trade/chokepoints-monitor.html
- aisstream docs: https://aisstream.io/documentation
- Otonomi (per-shipment delay cover): https://chain.link/case-studies/otonomi
- Container freight derivatives: https://theloadstar.com/second-coming-for-ffas-as-protection-against-ocean-freight-rate-volatility/
- Hummels, D. and Schaur, G. (2013). Time as a Trade Barrier. American Economic Review 103(7).

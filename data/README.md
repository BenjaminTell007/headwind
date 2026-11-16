# Data

Everything the page loads comes out of `scripts/`. All scripts run with the project venv:

```bash
~/.venvs/chokepoint/bin/python -I scripts/<script>.py
```

`scripts/run_all.sh` runs the whole thing in order. The Comtrade pulls are slow (see below) but they cache every call, so a rerun only fetches what's missing.

## Sources

| Source | What I use it for | Key? |
|---|---|---|
| IMF PortWatch (ArcGIS services behind portwatch.imf.org) | Daily transits for 28 chokepoints, daily port calls, the port and country lists, disruption events | No |
| UN Comtrade public preview API | Monthly US imports and exports by partner and HS chapter, and each lane's typical cargo mix | No, but rate limited |
| `searoute` Python package | Sea lane geometry and Suez vs Cape distances | No |
| Natural Earth 110m (ships with `pyogrio`) | Country outlines and points for arcs | No |
| Open-Meteo | Wind and sea state at a point | No |
| aisstream.io | Live ship positions and static data | Free key |

The Census trade API now needs a key, so I used Comtrade for the trade data. If I get a Census key later, Census publishes the US monthly numbers faster, which matters for settling the trade-pair markets.

Comtrade's free API allows one period per call and 500 rows per call, limits calls per second, and has a call quota that runs out after a couple hundred calls and takes several minutes to refill. The scripts read the `Retry-After` header and wait.

## Scripts

| Script | Does | Needs |
|---|---|---|
| `pull_portwatch.py` | Chokepoint list and daily transits | nothing |
| `pull_portwatch_ports.py` | Port list, country list, disruption events, daily port calls for my lane ports | nothing |
| `pull_comtrade.py` | US monthly totals with every partner, and HS chapters for the top 20 partners plus Switzerland | nothing |
| `pull_portwatch_network.py` | The biggest real shipping legs, and daily trade estimates for every country | nothing |
| `build_lanes.py` | My 37 hand-picked port-to-port lanes and alternatives | `pull_portwatch.py` |
| `build_routes.py` | All 210 corridors between 21 world regions with their alternatives, and the 600 biggest real legs | `pull_portwatch.py`, `pull_portwatch_network.py` |
| `build_efficiency.py` | Route efficiency for every corridor, weekly since 2019, and a throughput ratio for every chokepoint | `build_routes.py` |
| `build_country_trade.py` | Weekly seaborne trade for every country | `pull_portwatch_network.py` |
| `add_chokepoint_gates.py` | Adds a live gate for every PortWatch chokepoint that doesn't have a hand-drawn line | `pull_portwatch.py` |
| `pull_lane_cargo.py` | Typical cargo mix per lane | `build_lanes.py`, `pull_comtrade.py` (for the HS names) |
| `build_overview.py` | Overview numbers and chokepoint time series | `pull_portwatch.py`, `build_lanes.py` |
| `build_trade.py` | Trade-pair file for the ribbons | `pull_comtrade.py` |
| `build_ports_events.py` | Ports, timeline events, port-call series and baselines | `pull_portwatch_ports.py` |
| `build_countries.py` | Country points and outlines | `pull_portwatch_ports.py`, `build_trade.py` |
| `build_markets.py` | Seed markets with thresholds, and replay markets with known answers | `pull_portwatch.py`, `build_trade.py` |
| `pull_weather.py` | Weather snapshot at every chokepoint and gate | `pull_portwatch.py` |
| `ais_logger.py` | Logs live ship positions | aisstream key |
| `summarize_live.py` | Gate counts, live market thresholds, live overview numbers, preset ships | logger output |
| `tune_gates.py` | Moves gate lines to where ship tracks actually cross | logger output |

## Files

`raw/portwatch/`
- `chokepoints.csv`: the 28 PortWatch chokepoints with lat/lon. Cape of Good Hope is `chokepoint7`.
- `daily_transits.csv`: one row per chokepoint per day, 2019-01-01 to 2026-11-08, counts and capacity by vessel type.
- `ports.csv`: all 2,065 PortWatch ports.
- `countries.csv`: PortWatch's 196 countries with a point each (no landlocked countries).
- `disruptions.csv`: PortWatch's 132 disruption events.
- `daily_port_calls.csv`: daily port calls and import/export volume estimates for my 28 PortWatch-matched lane ports, 2019-01-01 to 2026-11-06.

`raw/comtrade/`
- `us_totals_by_partner.csv`: monthly US imports (M) and exports (X) with every partner, 2023-01 to 2026-08.
- `us_hs2_top_partners.csv`: HS chapter breakdown for the top 20 partners plus Switzerland, every month from 2023-01 to 2026-08.
- `partnerAreas.json`, `HS.json`: Comtrade reference lists.
- `calls/`, `lane_cargo_calls/`: every API response cached as its own file.

`processed/` (what the page loads)

Globe and geography
- `countries.json`: 225 countries by ISO3 with a point for arcs to land on and the Comtrade code.
- `countries.geojson`: simplified country outlines.
- `portwatch_ports.json`: every PortWatch port, sorted by vessel count.

Lanes
- `lanes.geojson`, `lanes_alt.geojson`, `lane_table.csv`, `ports.csv`: 37 lanes between 30 ports. Each lane has its normal route, distance, days at a typical speed and the chokepoints it passes within 75 nm of. Lanes through Suez also get a Cape route, and lanes through Panama get a route that avoids it.
- `lane_cargo_mix.json`: for each lane, what the destination country imports from the origin country, by HS section and top chapters.

Longitudes in the lane files run past 180 on lanes that cross the Pacific (241.7 instead of -118.3). That keeps each line continuous across the date line. Wrap with `((lon + 180) % 360) - 180` if a plain lon/lat is needed.

Every route
- `regions.json`: the 21 regions, their hub ports, and the passage groups (which chokepoints measure which passage).
- `corridors.geojson`, `corridor_table.csv`: the normal sea route between every pair of region hubs, 210 corridors, with distance, days at 15 knots, the passages it uses and the chokepoints it passes.
- `corridors_alt.geojson`, `corridor_alts.csv`: for each corridor and each passage it uses, the route if that passage shuts, with extra distance and days, or `blocked` if there's no way round (Hormuz, the Bosporus, and Jeddah inside the Red Sea).
- `network_legs.geojson`: the 600 biggest port-to-port legs ships actually sail (from PortWatch's maritime connections), routed, with a flow estimate for line width.
- `route_efficiency.json`: for every corridor, weekly expected transit days, blocked share and efficiency since 2019.
- `route_efficiency_latest.csv`: the latest week for every corridor, worst first.
- `efficiency_index.json`: the world index and one per region, weekly.
- `chokepoint_status.json`: every chokepoint's baseline, latest throughput ratio and weekly ratio series.

Every country
- `country_trade_weekly.json`, `country_trade_latest.csv`: weekly port calls and import/export tonnes for every country from PortWatch's estimates, with the change against a year ago. This is what lets any country be clicked, not only US partners.

Chokepoints and ports over time
- `overview.json`: the numbers for the overview strip, each with a `method` field.
- `chokepoint_weekly.json`: weekly transits by vessel type for every chokepoint since 2019. Complete weeks only (Monday to Sunday).
- `chokepoint_daily.json`: daily transits since 2023 for all 28 chokepoints.
- `port_calls_weekly.json`: weekly port calls by vessel type and import/export tonnes for the lane ports.
- `port_baselines.json`: daily port calls over the last 90 days of data, for sizing port arrival markets.
- `events.json`: 95 timeline events for the scrubber. 5 are PortWatch's own trade disruptions, 7 are trade events I entered by hand, and the rest are PortWatch natural hazards that hit at least one port.

Trade
- `us_trade_pairs.json`: for each top partner, monthly imports and exports, 12-month totals and balance, the product mix both ways by HS section and chapter, and a monthly series for every HS section both ways (plus chapter 71, gold, by itself).
- `us_partner_totals.csv`: monthly totals for all 223 partners.

Markets
- `market_seeds.json`: live gate markets from the overnight log, weekly markets for all 28 chokepoints, route markets (expected transit days or efficiency on headline corridors, plus the world index), monthly trade markets, and replay markets with their actual outcomes.

Weather
- `weather_snapshot.json`: wind, waves, swell and sea temperature at every chokepoint and gate when the script last ran. Some canal and ice-covered points have no wave data (null).

Live ships (after the logger has run)
- `gate_crossings.csv`, `gate_thresholds.json`, `live_overview.json`, `preset_candidates.csv`.

`gates.json`: the live market gates. 15 lines across straits, canals and river mouths, 9 boxes around port approaches, and 18 boxes around the PortWatch chokepoints that don't have a line, so all 28 chokepoints have a gate (`chokepoint_gate` maps one to the other). The first 10 lines cross the lanes I expect them to, so they're in the right place. All endpoints are hand-drawn, so check `gate_thresholds.json` after the logger has run: a gate that shows ships nearby but no crossings has a badly placed line.

`live/`: raw logger output, one set of CSVs per UTC day, plus `logger.log` and `logger.pid`.

The aisstream key lives in `Chokepoint/.env` (not committed, see `.gitignore`). The logger reads it from there if `AISSTREAM_API_KEY` isn't set.

Live results, from the overnight log (2026-11-14 17:29 to 2026-11-15 08:16 PST, about 10.7 hours with data; the Mac slept for parts of the evening):
- The free feed sees ships around northwest Europe, Singapore, Gibraltar, Hong Kong, Tokyo Bay and the US coasts. It saw no ships at all at Malacca north of Singapore, Hormuz, Bab el-Mandeb, Suez, the Taiwan Strait, Shanghai, Busan or any of the 18 chokepoint boxes in open water. Those are weekly PortWatch markets only.
- Gates count cargo ships (AIS types 70-79) and tankers (80-89) only, once per ship per gate per hour. Before that filter, ferries and harbour craft were crossing some lines over and over (3.4 crossings per ship at the Oresund, where the Helsingor ferry runs all night).
- `tune_gates.py` moved 7 hand-drawn lines to where the tracks actually cross (Tokyo Bay went from 2 crossings to 59). The original lines are kept in `gates.json` under `lines_before_tuning`.
- Ten-minute markets don't work: even the busiest gate averages under 4 trade ships per 10 minutes. `summarize_live.py` picks the shortest market length (10, 15, 30 or 60 minutes) where a gate averages at least 4 crossings, and sets the threshold at the median so markets open near even odds.
- Usable live gates: Singapore Strait (about 22 trade ships an hour, 30-minute markets, threshold 11), Western Scheldt (30 minutes, 4), Antwerp, Rotterdam, Gibraltar and Singapore anchorages (60 minutes). Tokyo Bay and Dover are close (about 5 an hour). These are in `market_seeds.json` under `live`.
- `preset_candidates.csv` lists 25 large container ships underway to a port I can match, with name, IMO, destination and position. Positions go stale as the ships move, so rerun `summarize_live.py` just before the demo.

## Checks I ran

- PortWatch: 28 chokepoints, 2,869 days each, no duplicate chokepoint-days.
- Trade: for every top partner and every month, the HS sections sum to the partner's total (within 1%), and no partner has a missing month.
- Lanes: each gate line crosses the lanes that should pass it. Asia to North Europe via the Cape adds about 3,350 nm and 9.3 days at 15 knots.
- Events: each hand-entered event with a chokepoint attached shows up in the transit data (average daily transits before and after are stored in `events.json`).
- Every JSON file in `processed/` parses as strict JSON (no NaN).

## Methods and caveats

Route efficiency
- Each chokepoint gets a throughput ratio: its 4-week average transits over its January to October 2023 baseline.
- A passage's shortfall is 1 minus that ratio, or zero if the ratio is 0.9 or more. The Red Sea uses the lower of Suez and Bab el-Mandeb.
- A corridor's expected days are its normal days plus, for each passage it uses, shortfall times the extra days of going round. If a passage has no way round, the shortfall counts as a blocked share. Efficiency is normal days over expected days, times one minus the blocked share. It's 1.0 when everything on the route is normal.
- Only canals and narrow straits count against a route: the Red Sea, Panama, Hormuz, the Bosporus, Malacca and Sunda. Gibraltar, the Cape, Magellan and Bering are tracked but not penalized, because they can't really close and their traffic moves as a side effect of the others.
- This is a model, not a measurement. It assumes traffic missing from a passage has rerouted (some has just stopped), and that ships keep the same speed on the longer route. A fall in traffic for any reason, including sanctions or weak trade, shows up as lost efficiency.
- Sanity checks: the world index is 1.00 in mid 2023, 0.90 the week of the Ever Given, 0.85 in February 2024 (Red Sea), 0.82 in March 2026 (Hormuz) and 0.76 now. East Asia to North Europe is 29.2 days normally and about 35 now.
- The world and region indexes are plain averages across corridors, not weighted by trade volume. Hub-to-hub corridors stand in for whole regions.
- The Bosporus is at about half its 2023 traffic in PortWatch's counts, which drags every Black Sea corridor down. I haven't checked whether that's real traffic loss or AIS interference in the Black Sea, which is common.
- The Red Sea alternative is forced round the Cape. On distance alone searoute would send some Asia to Europe routes through Panama, which isn't what ships did in 2024.
- Country trade volumes are PortWatch's estimates from vessel size and draught, not customs data.
- Network leg flows are PortWatch's `input_days_1` field, which I read as a per-day flow estimate. I use it for relative line widths only.

- Overview numbers compare the latest PortWatch week (2026-11-02 to 2026-11-08) against two baselines: the prior 365 days and pre-crisis 2023 (January to October, before the Red Sea attacks). Both are kept because for Suez the one-year average is already depressed.
- Cape share is Cape / (Cape + Suez) transits. It counts all Cape traffic, including ships that never would have used Suez (Brazil to Asia, for example), so it's a rough signal.
- Rerouting days assume the same speed on both routes. Ships often speed up on the Cape route, so real added days vary.
- Time cost uses Hummels and Schaur (2013): 0.6% to 2.1% of cargo value per day. It's shown per $1M of cargo because I don't have cargo values for the ships being rerouted. Always a range.
- Strait of Hormuz: transits fell from about 80 a day to low single digits after US and Israeli strikes on Iran began on February 28, 2026. They rose to about 24 a day after a preliminary agreement on June 17 and have since fallen back to about 4. PortWatch counts ships by AIS, and many ships in the Gulf switch off their transponders, so these likely undercount real traffic. Other trackers (Lloyd's List) count differently.
- Kerch Strait shows zero transits this week. I haven't looked into why.
- Swiss tariff dates, checked: the US set 39% on Swiss goods on August 1, 2025 (in force a week later), and the two countries agreed a framework to cut it to 15% on November 14, 2025.
- US exports to Switzerland are dominated by HS chapter 71 (gold and precious metals), about $75B of $89B over the last 12 months. The ribbons should probably show trade with and without chapter 71.
- US imports from Switzerland spiked to $10.7B in July 2025, just before the tariff, against a usual $3B to $5B. Instruments and watches show the same shape: $1.12B in July 2025, $0.46B in September, back to $0.82B in December after the cut to 15%.
- Trade values are US-reported. Comtrade calls Taiwan "Other Asia, nes"; I relabel it. Comtrade's latest US month was 2026-08 when I pulled.
- The lane cargo mix is country-level trade between the lane's two countries. It includes goods that go by air or land, and it isn't any ship's manifest.
- The 7 hand-entered events have a source noted in the file. Check the wording before quoting them on a slide.
- Off-lane share in `live_overview.json` measures distance to every route I have geometry for (lanes, corridors, network legs). Ships on routes I didn't draw still count as off-lane.
- Free AIS coverage is good near busy coasts and patchy offshore. Only gates that `summarize_live.py` marks as usable should get live markets.

"""Route efficiency for every corridor, every week since 2019.

The idea: a route is efficient when ships can take the short way. When a
passage on the route loses traffic, some share of ships are taking the long
way round, and the route's expected transit time goes up.

Method, for each week:
  1. Throughput ratio for each chokepoint
       ratio = 4-week average transits / that chokepoint's baseline
     Baseline is January to October 2023, before the Red Sea attacks.
  2. Shortfall for each passage group
       shortfall = 0 if ratio >= 0.9 (normal week-to-week noise)
                 = 1 - ratio otherwise
     The Red Sea group uses the lower of Suez and Bab el-Mandeb.
     Only canals and narrow straits count (see PENALIZED below).
  3. For each corridor
       expected_days = normal_days + sum over its passages of shortfall x extra_days
       blocked_share = largest shortfall among passages with no way round
       efficiency    = normal_days / expected_days x (1 - blocked_share)
     Efficiency is 1.0 when every passage on the route is running normally.

This is a model, not a measurement. It assumes traffic missing from a passage
has rerouted (some of it has simply stopped), and that ships keep the same
speed on the longer route. It's meant to be a consistent index that moves
with real transit data, which is what a market can settle on.

Inputs:  daily_transits.csv, corridor_table.csv, corridor_alts.csv
Outputs (data/processed/):
  chokepoint_status.json   every chokepoint: baseline, latest ratio, weekly ratio series
  route_efficiency.json    every corridor: weekly expected days and efficiency, plus the latest reading
  route_efficiency_latest.csv   one row per corridor, latest week, sorted worst first
  efficiency_index.json    world and per-region averages over time

Run:  ~/.venvs/chokepoint/bin/python -I scripts/build_efficiency.py
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "processed"

BASELINE_START = "2023-01-01"
BASELINE_END = "2023-10-31"
DEADBAND = 0.9      # ratios above this count as normal
SMOOTH_WEEKS = 4
# Passages whose shortfall counts against a route: canals and narrow straits
# that can actually be shut or restricted. Gibraltar, the Cape, Magellan and
# Bering are left out. They're open water that can't really close, and their
# traffic moves as a side effect of the others (Gibraltar loses ships when the
# Red Sea does), so counting them would double count.
PENALIZED = ["red_sea", "panama", "hormuz", "bosporus", "malacca", "sunda"]


def main():
    daily = pd.read_csv(ROOT / "data" / "raw" / "portwatch" / "daily_transits.csv", parse_dates=["date"])
    pivot = daily.pivot(index="date", columns="portname", values="n_total")

    # Complete Monday-to-Sunday weeks only.
    weekly = pivot.resample("W-SUN").sum()
    full = pivot.resample("W-SUN").count().iloc[:, 0] == 7
    weekly = weekly[full]

    baseline_week = pivot.loc[BASELINE_START:BASELINE_END].mean() * 7
    smooth = weekly.rolling(SMOOTH_WEEKS, min_periods=1).mean()
    ratio = smooth / baseline_week
    weeks = [d.strftime("%Y-%m-%d") for d in ratio.index]

    # Chokepoint status file.
    status = {"baseline_window": [BASELINE_START, BASELINE_END], "weeks": weeks, "chokepoints": {}}
    for name in ratio.columns:
        status["chokepoints"][name] = {
            "baseline_per_week": round(float(baseline_week[name]), 1),
            "latest_per_week": int(weekly[name].iloc[-1]),
            "latest_ratio": round(float(ratio[name].iloc[-1]), 3),
            "ratio": [round(float(v), 3) for v in ratio[name]],
        }
    (OUT / "chokepoint_status.json").write_text(json.dumps(status))

    regions = json.loads((OUT / "regions.json").read_text())
    groups = regions["passage_groups"]

    # Shortfall per passage group per week.
    shortfall = pd.DataFrame(index=ratio.index)
    for group, spec in groups.items():
        group_ratio = ratio[spec["chokepoints"]].min(axis=1)
        s = (1 - group_ratio).clip(lower=0, upper=1)
        s[group_ratio >= DEADBAND] = 0.0
        if group not in PENALIZED:
            s[:] = 0.0
        shortfall[group] = s

    table = pd.read_csv(OUT / "corridor_table.csv").fillna("")
    alts = pd.read_csv(OUT / "corridor_alts.csv")

    out = {"weeks": weeks, "method": "See scripts/build_efficiency.py. Model-based index from PortWatch transits and searoute distances.",
           "corridors": {}}
    latest_rows = []
    efficiency_all = {}

    for _, corridor in table.iterrows():
        cid = corridor["corridor_id"]
        normal_days = float(corridor["days"])
        extra = np.zeros(len(ratio))
        blocked = np.zeros(len(ratio))
        contributions = {}

        for _, alt in alts[alts["corridor_id"] == cid].iterrows():
            s = shortfall[alt["group"]].to_numpy()
            if alt["blocked"]:
                blocked = np.maximum(blocked, s)
                contributions[alt["group"]] = s * normal_days   # for ranking only
            else:
                added = s * float(alt["extra_days"])
                extra = extra + added
                contributions[alt["group"]] = added

        expected = normal_days + extra
        efficiency = normal_days / expected * (1 - blocked)
        efficiency_all[cid] = efficiency

        binding = ""
        if contributions:
            last = {g: float(v[-1]) for g, v in contributions.items()}
            top = max(last, key=last.get)
            if last[top] > 0:
                binding = top

        out["corridors"][cid] = {
            "region_a": corridor["region_a"], "region_b": corridor["region_b"],
            "normal_days": normal_days,
            "passage_groups": [g for g in corridor["passage_groups"].split("|") if g],
            "expected_days": [round(float(v), 1) for v in expected],
            "blocked_share": [round(float(v), 3) for v in blocked],
            "efficiency": [round(float(v), 3) for v in efficiency],
        }
        latest_rows.append({
            "corridor_id": cid, "region_a": corridor["region_a"], "region_b": corridor["region_b"],
            "normal_days": normal_days, "expected_days": round(float(expected[-1]), 1),
            "extra_days": round(float(extra[-1]), 1), "blocked_share": round(float(blocked[-1]), 3),
            "efficiency": round(float(efficiency[-1]), 3), "binding_passage": binding,
        })

    (OUT / "route_efficiency.json").write_text(json.dumps(out))
    latest = pd.DataFrame(latest_rows).sort_values("efficiency")
    latest.to_csv(OUT / "route_efficiency_latest.csv", index=False)

    # World and per-region averages (plain averages across corridors).
    eff = pd.DataFrame(efficiency_all, index=ratio.index)
    index = {"weeks": weeks, "note": "Plain average of corridor efficiency. Corridors are not weighted by trade volume.",
             "world": [round(float(v), 3) for v in eff.mean(axis=1)], "regions": {}}
    for region in regions["regions"]:
        cols = [c for c in eff.columns if out["corridors"][c]["region_a"] == region or out["corridors"][c]["region_b"] == region]
        index["regions"][region] = [round(float(v), 3) for v in eff[cols].mean(axis=1)]
    (OUT / "efficiency_index.json").write_text(json.dumps(index))

    # Summary to eyeball.
    print(f"Latest week: {weeks[-1]}")
    print("Passage shortfalls now:", {g: round(float(shortfall[g].iloc[-1]), 2) for g in shortfall.columns if shortfall[g].iloc[-1] > 0})
    print(f"World route efficiency: {index['world'][-1]} now")
    for label, date in [("2023-06 (calm)", "2023-06-25"), ("2024-02 (Red Sea)", "2024-02-25"), ("2021-03-28 (Ever Given)", "2021-03-28"), ("2026-03 (Hormuz)", "2026-03-29")]:
        print(f"  {label}: {index['world'][weeks.index(date)]}")
    print("Regions now:", {r: v[-1] for r, v in sorted(index["regions"].items(), key=lambda kv: kv[1][-1])})
    print(latest.head(12).to_string(index=False))
    show = latest[latest["corridor_id"].isin(["east_asia__north_europe", "east_asia__north_america_west", "east_asia__north_america_east", "north_europe__north_america_east"])]
    print(show.to_string(index=False))


if __name__ == "__main__":
    main()

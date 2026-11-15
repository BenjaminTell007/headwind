"""Seed markets for the contract, with thresholds computed from the data.

Three groups, all written to data/processed/market_seeds.json:

  route     one market per headline corridor on its expected transit days,
            plus one on the world route efficiency index
  weekly    one market per chokepoint (all 28) for the next week PortWatch
            hasn't published yet. Threshold is the median weekly total over
            the last 8 complete weeks, so it opens near even odds.
  trade     one market per headline trade partner for the next month Comtrade
            hasn't published. Threshold is the mean of the last 3 months of
            US imports.
  replay    past markets with known answers, for the demo. The actual value
            and the outcome come straight from the data, so I can open the
            market, replay the event and resolve it on stage.

Live gate markets are not here. Their thresholds come from
summarize_live.py once the ship logger has run.

Run:  ~/.venvs/chokepoint/bin/python -I scripts/build_markets.py
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "processed"

# Headline corridors for route markets (corridor ids from corridor_table.csv).
ROUTE_CORRIDORS = [
    "east_asia__north_europe", "east_asia__west_mediterranean", "southeast_asia__north_europe",
    "south_asia__north_europe", "east_asia__north_america_east", "east_asia__north_america_west",
    "north_europe__north_america_east", "east_asia__middle_east_gulf", "middle_east_gulf__north_europe",
    "black_sea__north_europe", "south_america_east__east_asia", "east_asia__us_gulf",
]
# Replay route markets: (corridor, week ending, days threshold, story)
REPLAY_ROUTES = [
    ("east_asia__north_europe", "2024-02-25", 33.0, "Red Sea attacks"),
    ("east_asia__north_america_east", "2024-01-28", 31.0, "Panama drought"),
    ("east_asia__north_europe", "2021-04-04", 30.0, "Ever Given"),
]
TRADE_PARTNERS = ["China", "Mexico", "Canada", "Viet Nam", "Germany", "Switzerland"]

# Replay markets: (chokepoint, week ending (a Sunday), baseline window start, end, share of baseline)
# The question is "at least share x baseline transits in that week?"
REPLAY_WEEKLY = [
    ("Suez Canal", "2024-01-21", "2023-01-01", "2023-10-31", 0.75, "Red Sea attacks"),
    ("Cape of Good Hope", "2024-01-21", "2023-01-01", "2023-10-31", 1.25, "Red Sea attacks"),
    ("Panama Canal", "2023-12-17", "2023-01-01", "2023-06-30", 0.75, "Panama drought"),
    ("Strait of Hormuz", "2026-03-08", "2025-03-01", "2026-02-27", 0.50, "Hormuz closure"),
    ("Suez Canal", "2021-03-28", "2021-01-01", "2021-03-22", 0.75, "Ever Given"),
]


def main():
    daily = pd.read_csv(ROOT / "data" / "raw" / "portwatch" / "daily_transits.csv", parse_dates=["date"])
    pivot = daily.pivot(index="date", columns="portname", values="n_total")
    weekly = pivot.resample("W-SUN").sum()
    days_in_week = pivot.resample("W-SUN").count()

    last_day = pivot.index.max()
    # Only weeks with all 7 days count as complete.
    complete = weekly[days_in_week.iloc[:, 0] == 7]
    # Target the first Monday-to-Sunday week that starts after today, so the
    # market is still open when I seed it. (PortWatch lags about a week, so the
    # week right after the data ends may already be over.)
    today = pd.Timestamp.today().normalize()
    days_to_monday = (7 - today.weekday()) % 7
    if days_to_monday == 0:
        days_to_monday = 7
    next_week_end = today + pd.Timedelta(days=days_to_monday + 6)

    seeds = {"data_through": last_day.strftime("%Y-%m-%d"), "weekly": [], "route": [], "trade": [], "replay": []}

    for name in sorted(complete.columns):
        recent = complete[name].tail(8)
        threshold = int(round(recent.median()))
        seeds["weekly"].append({
            "id": f"weekly_{name.lower().replace(' ', '_').replace('-', '_')}_{next_week_end.strftime('%Y%m%d')}",
            "question": f"Will at least {threshold} ships transit the {name} in the week ending {next_week_end.strftime('%b %d, %Y')}?",
            "series": f"portwatch:{name}:weekly_transits",
            "threshold": threshold,
            "is_above": True,
            "week": [(next_week_end - pd.Timedelta(days=6)).strftime("%Y-%m-%d"), next_week_end.strftime("%Y-%m-%d")],
            "closes": (next_week_end - pd.Timedelta(days=6)).strftime("%Y-%m-%d"),
            "settles_on": "IMF PortWatch daily transit counts, summed Monday to Sunday",
            "last_8_weeks": [int(v) for v in recent.tolist()],
        })

    # Route markets: expected transit days and the world efficiency index.
    routes = json.loads((OUT / "route_efficiency.json").read_text())
    index = json.loads((OUT / "efficiency_index.json").read_text())
    week_label = next_week_end.strftime("%b %d, %Y")
    for cid in ROUTE_CORRIDORS:
        if cid not in routes["corridors"]:
            # Corridor ids are ordered by the region list, so try the other way round.
            a, b = cid.split("__")
            cid = f"{b}__{a}"
        corridor = routes["corridors"][cid]
        if corridor["efficiency"][-1] >= 0.999:
            # Route is running normally, so a market at today's level would be a sure thing.
            continue
        if corridor["blocked_share"][-1] > 0:
            # A blocked passage doesn't add days, it removes traffic, so ask about efficiency instead.
            level = corridor["efficiency"][-1]
            seeds["route"].append({
                "id": f"route_eff_{cid}_{next_week_end.strftime('%Y%m%d')}",
                "question": f"Will route efficiency {corridor['region_a']} to {corridor['region_b']} be at least {level:.3f} in the week ending {week_label}?",
                "series": f"route_efficiency:{cid}:efficiency",
                "threshold": level,
                "is_above": True,
                "last_8_weeks": corridor["efficiency"][-8:],
                "settles_on": "Route efficiency index computed from IMF PortWatch transits (scripts/build_efficiency.py)",
            })
            continue
        now = corridor["expected_days"][-1]
        threshold = round(now, 1)
        seeds["route"].append({
            "id": f"route_days_{cid}_{next_week_end.strftime('%Y%m%d')}",
            "question": f"Will the expected transit time {corridor['region_a']} to {corridor['region_b']} be at least {threshold} days in the week ending {week_label}?",
            "series": f"route_efficiency:{cid}:expected_days",
            "threshold": threshold,
            "is_above": True,
            "normal_days": corridor["normal_days"],
            "efficiency_now": corridor["efficiency"][-1],
            "last_8_weeks": corridor["expected_days"][-8:],
            "settles_on": "Route efficiency index computed from IMF PortWatch transits (scripts/build_efficiency.py)",
        })
    world_now = index["world"][-1]
    seeds["route"].append({
        "id": f"route_world_index_{next_week_end.strftime('%Y%m%d')}",
        "question": f"Will the world route efficiency index be at least {world_now:.3f} in the week ending {week_label}?",
        "series": "route_efficiency:world:index",
        "threshold": world_now,
        "is_above": True,
        "last_8_weeks": index["world"][-8:],
        "settles_on": "Plain average of corridor efficiency (scripts/build_efficiency.py)",
    })
    for cid, week_end, threshold, story in REPLAY_ROUTES:
        corridor = routes["corridors"][cid]
        actual = corridor["expected_days"][routes["weeks"].index(week_end)]
        seeds["replay"].append({
            "id": f"replay_route_days_{cid}_{week_end.replace('-', '')}",
            "story": story,
            "question": f"Will the expected transit time {corridor['region_a']} to {corridor['region_b']} be at least {threshold} days in the week ending {pd.Timestamp(week_end).strftime('%b %d, %Y')}?",
            "series": f"route_efficiency:{cid}:expected_days",
            "threshold": threshold,
            "is_above": True,
            "normal_days": corridor["normal_days"],
            "actual": actual,
            "outcome": "YES" if actual >= threshold else "NO",
        })

    # Live gate markets, from the overnight ship log (summarize_live.py).
    seeds["live"] = []
    gate_file = OUT / "gate_thresholds.json"
    if gate_file.exists():
        gate_stats = json.loads(gate_file.read_text())
        gate_names = {g["id"]: g["name"] for g in json.loads((ROOT / "data" / "gates.json").read_text())["lines"]}
        gate_names.update({g["id"]: g["name"] for g in json.loads((ROOT / "data" / "gates.json").read_text())["boxes"]})
        for gate_id, s in sorted(gate_stats.items(), key=lambda kv: -kv[1]["ships_per_hour"]):
            rec = s["recommended_market"]
            if not s["usable_for_live_market"] or rec is None:
                continue
            seeds["live"].append({
                "id": f"live_{gate_id}",
                "question": f"Will at least {rec['threshold']} cargo ships and tankers cross the {gate_names[gate_id]} gate in the next {rec['minutes']} minutes?",
                "gate": gate_id,
                "minutes": rec["minutes"],
                "threshold": rec["threshold"],
                "is_above": True,
                "ships_per_hour": s["ships_per_hour"],
                "historical_yes_share": rec["historical_yes_share"],
                "settles_on": "Gate crossings counted from the live aisstream feed by my server (cargo AIS types 70-79 and tankers 80-89, one per ship per hour)",
            })

    totals = pd.read_csv(OUT / "us_partner_totals.csv")
    last_month = totals["month"].max()
    next_month = (pd.Period(last_month, freq="M") + 1).strftime("%Y-%m")
    for partner in TRADE_PARTNERS:
        series = totals[totals["partner"] == partner].sort_values("month")
        last3 = series["imports"].tail(3)
        threshold = round(float(last3.mean()) / 1e8) * 1e8   # nearest $0.1B
        seeds["trade"].append({
            "id": f"trade_us_imports_{partner.lower().replace(' ', '_')}_{next_month.replace('-', '')}",
            "question": f"Will US imports from {partner} be at least ${threshold / 1e9:.1f}B in {pd.Period(next_month).strftime('%B %Y')}?",
            "series": f"comtrade:US:imports:{partner}:monthly",
            "threshold": threshold,
            "is_above": True,
            "settles_on": "US-reported monthly imports (UN Comtrade / Census)",
            "last_3_months": {m: round(float(v)) for m, v in zip(series["month"].tail(3), last3)},
        })

    for name, week_end, base_start, base_end, share, story in REPLAY_WEEKLY:
        week_end_ts = pd.Timestamp(week_end)
        baseline_week = float(pivot.loc[base_start:base_end, name].mean() * 7)
        threshold = int(round(baseline_week * share))
        actual = int(weekly.loc[week_end_ts, name])
        seeds["replay"].append({
            "id": f"replay_{name.lower().replace(' ', '_').replace('-', '_')}_{week_end.replace('-', '')}",
            "story": story,
            "question": f"Will at least {threshold} ships transit the {name} in the week ending {week_end_ts.strftime('%b %d, %Y')}?",
            "series": f"portwatch:{name}:weekly_transits",
            "threshold": threshold,
            "is_above": True,
            "baseline_week": round(baseline_week),
            "baseline_window": [base_start, base_end],
            "actual": actual,
            "outcome": "YES" if actual >= threshold else "NO",
        })

    # Replay trade market: Swiss imports after the 39% tariff (set 2025-08-01).
    swiss = totals[totals["partner"] == "Switzerland"].set_index("month")["imports"]
    base = float(swiss.loc["2024-01":"2024-12"].mean())
    threshold = round(base / 1e8) * 1e8
    for month in ["2025-09", "2025-10"]:
        actual = float(swiss.loc[month])
        seeds["replay"].append({
            "id": f"replay_trade_us_imports_switzerland_{month.replace('-', '')}",
            "story": "39% US tariff on Swiss goods",
            "question": f"Will US imports from Switzerland be at least ${threshold / 1e9:.1f}B in {pd.Period(month).strftime('%B %Y')}?",
            "series": "comtrade:US:imports:Switzerland:monthly",
            "threshold": threshold,
            "is_above": True,
            "baseline_month": round(base),
            "baseline_window": ["2024-01", "2024-12"],
            "actual": round(actual),
            "outcome": "YES" if actual >= threshold else "NO",
        })

    (OUT / "market_seeds.json").write_text(json.dumps(seeds, indent=1))

    for group in ["weekly", "route", "live", "trade", "replay"]:
        print(group)
        for m in seeds[group]:
            extra = f"  -> actual {m['actual']:,} {m['outcome']}" if "actual" in m else ""
            print("  " + m["question"] + extra)


if __name__ == "__main__":
    main()

"""Build the overview strip numbers and the chokepoint time series for the page.

Inputs:
  data/raw/portwatch/daily_transits.csv   (pull_portwatch.py)
  data/processed/lane_table.csv           (build_lanes.py)

Outputs (data/processed/):
  overview.json            headline numbers for the strip, each with its method
  chokepoint_weekly.json   weekly transits by vessel type, every chokepoint, 2019 on
                           (sparklines, ridgelines, valve openings)
  chokepoint_daily.json    daily transits for every chokepoint, 2023 on

Every number here is computed from the data, and overview.json says how.

Run:  ~/.venvs/chokepoint/bin/python -I scripts/build_overview.py
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "portwatch" / "daily_transits.csv"
LANES = ROOT / "data" / "processed" / "lane_table.csv"
OUT = ROOT / "data" / "processed"

# Pre-crisis baseline for the Red Sea story: before the Houthi attacks began
# in mid November 2023.
PRECRISIS_START = "2023-01-01"
PRECRISIS_END = "2023-10-31"

# Hummels & Schaur (2013): each day in transit is worth 0.6% to 2.1% of
# cargo value.
DAY_COST_LOW = 0.006
DAY_COST_HIGH = 0.021

TYPES = ["n_container", "n_tanker", "n_dry_bulk", "n_general_cargo", "n_roro", "n_total"]


def main():
    daily = pd.read_csv(RAW, parse_dates=["date"])
    lanes = pd.read_csv(LANES)

    last_date = daily["date"].max()
    week_start = last_date - pd.Timedelta(days=6)
    year_start = week_start - pd.Timedelta(days=365)

    # 1. Each chokepoint this week vs its one-year average and vs pre-crisis 2023.
    chokepoint_rows = []
    for name, group in daily.groupby("portname"):
        group = group.set_index("date").sort_index()
        this_week = group.loc[week_start:last_date, "n_total"].mean()
        prior_year = group.loc[year_start:week_start - pd.Timedelta(days=1), "n_total"].mean()
        precrisis = group.loc[PRECRISIS_START:PRECRISIS_END, "n_total"].mean()

        def pct(a, b):
            if b is None or pd.isna(b) or b == 0:
                return None
            return round(100 * (a / b - 1), 1)

        chokepoint_rows.append({
            "chokepoint": name,
            "per_day_this_week": round(this_week, 1),
            "per_day_prior_year": round(prior_year, 1),
            "per_day_2023_precrisis": round(precrisis, 1),
            "pct_vs_prior_year": pct(this_week, prior_year),
            "pct_vs_2023_precrisis": pct(this_week, precrisis),
        })
    chokepoint_table = pd.DataFrame(chokepoint_rows).sort_values("pct_vs_prior_year")

    # 2. Cape share of Suez + Cape transits, now vs pre-crisis.
    def cape_share(start, end):
        window = daily[(daily["date"] >= start) & (daily["date"] <= end)]
        suez = window.loc[window["portname"] == "Suez Canal", "n_total"].sum()
        cape = window.loc[window["portname"] == "Cape of Good Hope", "n_total"].sum()
        return round(100 * cape / (cape + suez), 1)

    cape_now = cape_share(week_start, last_date)
    cape_before = cape_share(pd.Timestamp(PRECRISIS_START), pd.Timestamp(PRECRISIS_END))

    # 3. Ships diverted from Suez this week vs the pre-crisis daily average.
    suez = daily[daily["portname"] == "Suez Canal"].set_index("date").sort_index()
    suez_now = suez.loc[week_start:last_date, "n_total"].sum()
    suez_base = suez.loc[PRECRISIS_START:PRECRISIS_END, "n_total"].mean() * 7
    diverted = round(suez_base - suez_now)

    # 4. Extra distance and days for rerouting, Asia to Europe container lanes.
    asia_europe = lanes[(lanes["group"] == "Asia-Europe") & (lanes["alt_kind"] == "cape")]
    extra_nm = round(asia_europe["extra_nm"].mean())
    extra_days = round(asia_europe["extra_days"].mean(), 1)

    # 5. Time cost of the reroute per $1M of cargo (Hummels & Schaur range).
    cost_low = round(1_000_000 * extra_days * DAY_COST_LOW)
    cost_high = round(1_000_000 * extra_days * DAY_COST_HIGH)

    overview = {
        "as_of": last_date.strftime("%Y-%m-%d"),
        "week": [week_start.strftime("%Y-%m-%d"), last_date.strftime("%Y-%m-%d")],
        "chokepoints": chokepoint_table.to_dict(orient="records"),
        "cape_share": {
            "this_week_pct": cape_now,
            "precrisis_2023_pct": cape_before,
            "method": "Cape of Good Hope transits / (Cape + Suez transits), PortWatch daily counts. "
                      "Includes all Cape traffic, not only Asia-Europe ships.",
        },
        "suez_diverted": {
            "ships_this_week": diverted,
            "suez_this_week": int(suez_now),
            "suez_precrisis_week": round(suez_base),
            "method": "Pre-crisis (Jan-Oct 2023) average daily Suez transits x 7, minus this week's Suez transits.",
        },
        "reroute": {
            "extra_nm": extra_nm,
            "extra_days": extra_days,
            "lanes": asia_europe["lane_id"].tolist(),
            "method": "Mean over Asia-North Europe container lanes of searoute Cape distance minus Suez distance, at 15 knots.",
        },
        "time_cost_per_1m": {
            "low_usd": cost_low,
            "high_usd": cost_high,
            "method": "extra_days x 0.6% to 2.1% per day x $1M (Hummels & Schaur 2013). An estimate, shown as a range.",
        },
        "live_sample": {
            "note": "Filled at runtime from the aisstream logger: ships tracked, average speed vs normal by type, share more than 50 nm off lane.",
        },
        "market_odds": {
            "note": "Filled at runtime from the markets contract.",
        },
    }
    (OUT / "overview.json").write_text(json.dumps(overview, indent=2))

    # Weekly series for every chokepoint (sparklines, ridgelines, valves).
    weekly = (
        daily.set_index("date")
        .groupby("portname")[TYPES]
        .resample("W-SUN")
        .sum()
        .reset_index()
    )
    # Drop weeks that don't have all 7 days (the first week of 2019, and the
    # last week if the data ends mid-week).
    days = daily.set_index("date").groupby("portname")["n_total"].resample("W-SUN").count().reset_index(name="days")
    weekly = weekly.merge(days, on=["portname", "date"])
    weekly = weekly[weekly["days"] == 7].drop(columns="days")

    weekly_out = {}
    for name, group in weekly.groupby("portname"):
        weekly_out[name] = {
            "week_ending": group["date"].dt.strftime("%Y-%m-%d").tolist(),
            **{t.replace("n_", ""): group[t].astype(int).tolist() for t in TYPES},
        }
    (OUT / "chokepoint_weekly.json").write_text(json.dumps(weekly_out))

    # Daily series for every chokepoint, 2023 on.
    recent = daily[daily["date"] >= "2023-01-01"]
    daily_out = {}
    for name, group in recent.groupby("portname"):
        group = group.sort_values("date")
        daily_out[name] = {
            "date": group["date"].dt.strftime("%Y-%m-%d").tolist(),
            **{t.replace("n_", ""): group[t].astype(int).tolist() for t in TYPES},
        }
    (OUT / "chokepoint_daily.json").write_text(json.dumps(daily_out))

    # Print a summary so the numbers can be eyeballed.
    print(f"As of {overview['as_of']} (week {overview['week'][0]} to {overview['week'][1]})")
    print(chokepoint_table.to_string(index=False))
    print(f"Cape share: {cape_now}% now vs {cape_before}% pre-crisis")
    print(f"Suez: {int(suez_now)} transits this week vs {round(suez_base)} pre-crisis week, {diverted} diverted")
    print(f"Reroute Asia-N Europe: +{extra_nm} nm, +{extra_days} days")
    print(f"Time cost per $1M cargo: ${cost_low:,} to ${cost_high:,}")


if __name__ == "__main__":
    main()

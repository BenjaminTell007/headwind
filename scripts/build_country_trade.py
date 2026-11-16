"""Weekly seaborne trade for every country, from PortWatch's daily estimates.

This is what lets any country be clicked on the globe, not only US partners:
port calls by vessel type and estimated import and export volume (tonnes),
weekly since 2019, plus how the last 4 weeks compare with the same weeks a
year earlier.

Input:   data/raw/portwatch/daily_country_trade.csv (pull_portwatch_network.py)
Outputs: data/processed/country_trade_weekly.json
         data/processed/country_trade_latest.csv

Run:  ~/.venvs/chokepoint/bin/python -I scripts/build_country_trade.py
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "processed"

COLUMNS = ["portcalls", "portcalls_container", "portcalls_tanker", "portcalls_dry_bulk", "import", "export"]


def main():
    daily = pd.read_csv(ROOT / "data" / "raw" / "portwatch" / "daily_country_trade.csv", parse_dates=["date"])
    daily = daily.dropna(subset=["ISO3"])

    out = {"units": {"import": "tonnes", "export": "tonnes", "portcalls": "ships"},
           "note": "IMF PortWatch estimates from ship movements. Volumes are modelled from vessel size and draught, not customs data.",
           "countries": {}}
    latest_rows = []

    for iso3, group in daily.groupby("ISO3"):
        group = group.set_index("date").sort_index()
        weekly = group[COLUMNS].resample("W-SUN").sum()
        full = group["portcalls"].resample("W-SUN").count() == 7
        weekly = weekly[full]
        if len(weekly) < 60:
            continue

        # Last 4 weeks against the same 4 weeks a year earlier.
        last4 = weekly.tail(4).sum()
        year_ago = weekly.iloc[-56:-52].sum()

        def change(column):
            if year_ago[column] == 0:
                return None
            return round(100 * (last4[column] / year_ago[column] - 1), 1)

        name = group["country"].iloc[0]
        out["countries"][iso3] = {
            "name": name,
            "week_ending": [d.strftime("%Y-%m-%d") for d in weekly.index],
            "portcalls": weekly["portcalls"].astype(int).tolist(),
            "container": weekly["portcalls_container"].astype(int).tolist(),
            "tanker": weekly["portcalls_tanker"].astype(int).tolist(),
            "dry_bulk": weekly["portcalls_dry_bulk"].astype(int).tolist(),
            "import_tonnes": weekly["import"].round().astype(int).tolist(),
            "export_tonnes": weekly["export"].round().astype(int).tolist(),
        }
        latest_rows.append({
            "iso3": iso3, "country": name, "week_ending": weekly.index[-1].strftime("%Y-%m-%d"),
            "portcalls_4wk": int(last4["portcalls"]), "import_tonnes_4wk": round(float(last4["import"])),
            "export_tonnes_4wk": round(float(last4["export"])),
            "portcalls_yoy_pct": change("portcalls"), "import_yoy_pct": change("import"), "export_yoy_pct": change("export"),
        })

    (OUT / "country_trade_weekly.json").write_text(json.dumps(out))
    latest = pd.DataFrame(latest_rows).sort_values("import_tonnes_4wk", ascending=False)
    latest.to_csv(OUT / "country_trade_latest.csv", index=False)

    print(f"{len(out['countries'])} countries and aggregates, through {latest['week_ending'].max()}")
    print(latest.head(12).to_string(index=False))
    movers = latest[latest["import_tonnes_4wk"] > 2_000_000].sort_values("import_yoy_pct")
    print("Biggest import drops vs a year ago (countries over 2M tonnes per 4 weeks):")
    print(movers.head(8)[["country", "import_yoy_pct", "export_yoy_pct"]].to_string(index=False))


if __name__ == "__main__":
    main()

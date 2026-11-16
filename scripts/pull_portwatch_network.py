"""Pull the shipping network and country-level daily trade from IMF PortWatch.

  - Maritime connections: port-to-port legs that ships actually sail, with
    distance, transit days and a flow estimate. The full table has 155,521
    legs; I take the 4,000 biggest by flow plus the 1,500 biggest long-haul
    legs (over 4,000 km), which covers the network that matters.
  - Daily trade by country: port calls and import/export volume estimates for
    every country and the world total, daily since 2019.

Run:  ~/.venvs/chokepoint/bin/python -I scripts/pull_portwatch_network.py
Writes data/raw/portwatch/connections.csv and daily_country_trade.csv
"""
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "portwatch"

BASE = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services"
LEGS_URL = BASE + "/Spillover_Simulator_Maritime_Connections/FeatureServer/0/query"
TRADE_URL = BASE + "/Daily_Trade_Data_REG/FeatureServer/0/query"
PAGE = 1000

LEG_FIELDS = "from_id,to_id,from_name,to_name,from_iso3,to_iso3,from_country,to_country,distance,transit_days,from_lat,from_lon,to_lat,to_lon,input_days_1"
TRADE_FIELDS = "ISO3,country,date,portcalls_container,portcalls_dry_bulk,portcalls_general_cargo,portcalls_roro,portcalls_tanker,portcalls,import_container,import_tanker,import,export_container,export_tanker,export"


def query(url, where, out_fields, order_by, max_rows=None):
    rows = []
    offset = 0
    while True:
        params = {
            "where": where,
            "outFields": out_fields,
            "returnGeometry": "false",
            "orderByFields": order_by,
            "resultOffset": offset,
            "resultRecordCount": PAGE,
            "f": "json",
        }
        for attempt in range(6):
            try:
                response = requests.get(url, params=params, timeout=120)
                payload = response.json()
                if response.status_code == 200 and "error" not in payload:
                    break
            except (requests.RequestException, ValueError):
                pass
            time.sleep(3 + 3 * attempt)
        else:
            raise RuntimeError(f"query failed at offset {offset}")
        features = payload.get("features", [])
        for feature in features:
            rows.append(feature["attributes"])
        offset += PAGE
        if offset % 50000 == 0:
            print(f"  {offset} rows")
        if len(features) < PAGE:
            break
        if max_rows is not None and len(rows) >= max_rows:
            break
        time.sleep(0.15)
    return pd.DataFrame(rows)


def main():
    print("Connections: biggest legs by flow")
    top = query(LEGS_URL, "1=1", LEG_FIELDS, "input_days_1 DESC", max_rows=4000)
    print("Connections: biggest long-haul legs")
    long_haul = query(LEGS_URL, "distance > 4000", LEG_FIELDS, "input_days_1 DESC", max_rows=1500)
    legs = pd.concat([top, long_haul], ignore_index=True).drop_duplicates(subset=["from_id", "to_id"])
    legs = legs.rename(columns={"input_days_1": "flow_per_day", "distance": "distance_km"})
    legs = legs.sort_values("flow_per_day", ascending=False)
    legs.to_csv(OUT / "connections.csv", index=False)
    print(f"  {len(legs)} legs, {legs['from_id'].nunique()} origin ports")

    print("Daily trade by country")
    trade = query(TRADE_URL, "1=1", TRADE_FIELDS, "ObjectId")
    if pd.api.types.is_numeric_dtype(trade["date"]):
        trade["date"] = pd.to_datetime(trade["date"], unit="ms").dt.strftime("%Y-%m-%d")
    else:
        trade["date"] = pd.to_datetime(trade["date"]).dt.strftime("%Y-%m-%d")
    trade = trade.sort_values(["ISO3", "date"])
    trade.to_csv(OUT / "daily_country_trade.csv", index=False)
    print(f"  {len(trade)} rows, {trade['ISO3'].nunique()} countries, {trade['date'].min()} to {trade['date'].max()}")


if __name__ == "__main__":
    main()

"""Pull IMF PortWatch chokepoint data.

Two tables from PortWatch's public ArcGIS services:
  - the chokepoint list (id, name, lat, lon)
  - daily transit counts and capacity by vessel type for every chokepoint

Run:  ~/.venvs/chokepoint/bin/python -I scripts/pull_portwatch.py
Writes data/raw/portwatch/chokepoints.csv and daily_transits.csv
"""
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "portwatch"
OUT.mkdir(parents=True, exist_ok=True)

BASE = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services"
LIST_URL = BASE + "/PortWatch_chokepoints_database/FeatureServer/0/query"
DAILY_URL = BASE + "/Daily_Chokepoints_Data/FeatureServer/0/query"

# The service returns at most 1000 rows per call, so we page with resultOffset.
PAGE = 1000


def query_all(url, out_fields, order_by=None):
    rows = []
    offset = 0
    while True:
        params = {
            "where": "1=1",
            "outFields": out_fields,
            "returnGeometry": "false",
            "resultOffset": offset,
            "resultRecordCount": PAGE,
            "f": "json",
        }
        if order_by is not None:
            params["orderByFields"] = order_by

        response = requests.get(url, params=params, timeout=60)
        response.raise_for_status()
        payload = response.json()
        if "error" in payload:
            raise RuntimeError(payload["error"])

        features = payload.get("features", [])
        for feature in features:
            rows.append(feature["attributes"])

        print(f"  got {len(features)} rows at offset {offset}")
        if len(features) < PAGE:
            break
        offset += PAGE
        time.sleep(0.2)  # be polite to the server
    return pd.DataFrame(rows)


def main():
    print("Chokepoint list")
    chokepoints = query_all(LIST_URL, "portid,portname,lat,lon")
    chokepoints.to_csv(OUT / "chokepoints.csv", index=False)
    print(f"  {len(chokepoints)} chokepoints")

    print("Daily transits")
    daily = query_all(DAILY_URL, "*", order_by="ObjectId")
    # The date field comes back as milliseconds since 1970 or as a string,
    # depending on the field type. Normalize to YYYY-MM-DD.
    if pd.api.types.is_numeric_dtype(daily["date"]):
        daily["date"] = pd.to_datetime(daily["date"], unit="ms").dt.strftime("%Y-%m-%d")
    else:
        daily["date"] = pd.to_datetime(daily["date"]).dt.strftime("%Y-%m-%d")
    daily = daily.sort_values(["portid", "date"])
    daily.to_csv(OUT / "daily_transits.csv", index=False)
    print(f"  {len(daily)} rows, {daily['date'].min()} to {daily['date'].max()}")


if __name__ == "__main__":
    main()

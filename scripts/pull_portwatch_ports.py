"""Pull the rest of what I need from IMF PortWatch.

  - the full port list (2,065 ports with lat/lon, country, vessel counts,
    top industries, UN/LOCODE)
  - the country list (196 countries with a lat/lon point and vessel counts)
  - the disruption events table (cyclones, conflicts and so on, with dates),
    for the replay scrubber annotations
  - daily port calls and trade volume estimates for the ports on my lanes

Run:  ~/.venvs/chokepoint/bin/python -I scripts/pull_portwatch_ports.py
Writes data/raw/portwatch/ports.csv, countries.csv, disruptions.csv, daily_port_calls.csv
"""
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "portwatch"

BASE = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services"
PORTS_URL = BASE + "/PortWatch_ports_database/FeatureServer/0/query"
EVENTS_URL = BASE + "/portwatch_disruptions_database/FeatureServer/0/query"
DAILY_URL = BASE + "/Daily_Ports_Data/FeatureServer/0/query"
COUNTRIES_URL = BASE + "/PortWatch_countries_database/FeatureServer/0/query"
PAGE = 1000

# My lane port name -> PortWatch port name. Filled in after looking at the
# port list (PortWatch names some ports differently).
LANE_PORTS = {
    "Shanghai": "Shanghai",
    "Ningbo": "Ningbo",
    "Shenzhen": "Yantian",   # my Shenzhen point is the Yantian terminal
    "Busan": "Busan",
    "Kaohsiung": "Kaohsiung",
    "Tokyo": "Tokyo",
    "Singapore": "Singapore",
    "Port Klang": "Port Klang",
    "Port Hedland": "Port Hedland",
    "Nhava Sheva": "Mumbai-Jawaharlal Nehru (Nhava Sheva)",
    "Colombo": "Colombo",
    "Jebel Ali": "Jebel Ali",
    "Ras Tanura": "Ras Tanura",
    "Durban": "Durban",
    "Lagos": "Lagos",
    "Piraeus": "Piraeus",
    "Genoa": "Genova",
    "Valencia": "Valencia",
    "Rotterdam": "Rotterdam",
    "Antwerp": "Antwerp",
    "Hamburg": "Hamburg",
    "Felixstowe": "Felixstowe",
    "New York": "New York-New Jersey",
    "Savannah": "Savannah",
    "Houston": "Houston (US-TX)",
    "Los Angeles": "Los Angeles-Long Beach",
    "Vancouver": "Vancouver",
    "Santos": "Santos",
}


def query_all(url, where, out_fields, order_by="ObjectId"):
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
        for attempt in range(5):
            response = requests.get(url, params=params, timeout=90)
            if response.status_code == 200 and "error" not in response.json():
                break
            time.sleep(3 + 3 * attempt)
        else:
            raise RuntimeError(f"query failed: {response.text[:300]}")
        features = response.json().get("features", [])
        for feature in features:
            rows.append(feature["attributes"])
        if len(features) < PAGE:
            break
        offset += PAGE
        time.sleep(0.2)
    return pd.DataFrame(rows)


def fix_dates(frame, columns):
    for column in columns:
        if pd.api.types.is_numeric_dtype(frame[column]):
            frame[column] = pd.to_datetime(frame[column], unit="ms").dt.strftime("%Y-%m-%d")
        else:
            frame[column] = pd.to_datetime(frame[column]).dt.strftime("%Y-%m-%d")
    return frame


def main():
    print("Port list")
    ports = query_all(PORTS_URL, "1=1", "*")
    ports.to_csv(OUT / "ports.csv", index=False)
    print(f"  {len(ports)} ports")

    print("Country list")
    countries = query_all(COUNTRIES_URL, "1=1", "*")
    countries.to_csv(OUT / "countries.csv", index=False)
    print(f"  {len(countries)} countries")

    print("Disruption events")
    events = query_all(EVENTS_URL, "1=1", "*")
    events = fix_dates(events, ["fromdate", "todate"])
    events = events.drop(columns=["Shape__Area", "Shape__Length", "editdate"], errors="ignore")
    events = events.sort_values("fromdate")
    events.to_csv(OUT / "disruptions.csv", index=False)
    print(f"  {len(events)} events, {events['fromdate'].min()} to {events['fromdate'].max()}")

    print("Daily port calls for lane ports")
    frames = []
    missing = []
    for mine, theirs in LANE_PORTS.items():
        match = ports[ports["portname"] == theirs]
        if len(match) == 0:
            missing.append((mine, theirs))
            continue
        # If two ports share a name, take the busier one.
        port = match.sort_values("vessel_count_total", ascending=False).iloc[0]
        daily = query_all(DAILY_URL, f"portid='{port['portid']}'", "*")
        daily["lane_port"] = mine
        frames.append(daily)
        print(f"  {mine:14s} {port['portid']:9s} {port['fullname']:40s} {len(daily)} days")

    if missing:
        print("  NOT FOUND in PortWatch, fix LANE_PORTS:", missing)

    daily = pd.concat(frames, ignore_index=True)
    daily = fix_dates(daily, ["date"])
    daily = daily.sort_values(["lane_port", "date"])
    daily.to_csv(OUT / "daily_port_calls.csv", index=False)
    print(f"  {len(daily)} rows, {daily['date'].min()} to {daily['date'].max()}")


if __name__ == "__main__":
    main()

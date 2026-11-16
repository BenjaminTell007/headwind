"""Snapshot of current wind and sea conditions at every chokepoint and gate.

The page calls Open-Meteo live when a ship is clicked. This script saves a
snapshot so there's something to show if the network is slow on stage, and so
the request format is written down in one place.

Open-Meteo is free and needs no key. Two endpoints:
  wind:   https://api.open-meteo.com/v1/forecast
  marine: https://marine-api.open-meteo.com/v1/marine
Both take comma-separated latitude and longitude lists.

Run:  ~/.venvs/chokepoint/bin/python -I scripts/pull_weather.py
Writes data/processed/weather_snapshot.json
"""
import json
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "processed" / "weather_snapshot.json"

WIND_URL = "https://api.open-meteo.com/v1/forecast"
MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"
WIND_VARS = "wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,weather_code"
MARINE_VARS = "wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,sea_surface_temperature"


def places():
    rows = []
    chokepoints = pd.read_csv(ROOT / "data" / "raw" / "portwatch" / "chokepoints.csv")
    for _, cp in chokepoints.iterrows():
        rows.append({"id": cp["portid"], "name": cp["portname"], "kind": "chokepoint", "lat": cp["lat"], "lon": cp["lon"]})
    gates = json.loads((ROOT / "data" / "gates.json").read_text())
    for line in gates["lines"]:
        rows.append({"id": "gate_" + line["id"], "name": line["name"], "kind": "gate",
                     "lat": (line["a"][1] + line["b"][1]) / 2, "lon": (line["a"][0] + line["b"][0]) / 2})
    for box in gates["boxes"]:
        rows.append({"id": "gate_" + box["id"], "name": box["name"], "kind": "gate",
                     "lat": sum(box["lat"]) / 2, "lon": sum(box["lon"]) / 2})
    return rows


def fetch(url, variables, rows, extra=None):
    params = {
        "latitude": ",".join(f"{r['lat']:.4f}" for r in rows),
        "longitude": ",".join(f"{r['lon']:.4f}" for r in rows),
        "current": variables,
    }
    if extra:
        params.update(extra)
    # Open-Meteo sometimes stalls, so try a few times before giving up.
    for attempt in range(4):
        try:
            response = requests.get(url, params=params, timeout=45)
            response.raise_for_status()
            break
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(5)
    payload = response.json()
    # One location comes back as a dict, several as a list.
    if isinstance(payload, dict):
        payload = [payload]
    return payload


def main():
    rows = places()
    wind = fetch(WIND_URL, WIND_VARS, rows, {"wind_speed_unit": "kn"})
    marine = fetch(MARINE_URL, MARINE_VARS, rows)

    out = {"units": {"wind_speed": "knots", "wave_height": "m", "temperature": "C", "direction": "degrees, coming from"},
           "places": []}
    for row, w, m in zip(rows, wind, marine):
        entry = dict(row)
        entry["time"] = w["current"]["time"]
        for key, value in w["current"].items():
            if key not in ("time", "interval"):
                entry[key] = value
        for key, value in m["current"].items():
            if key not in ("time", "interval"):
                entry[key] = value
        out["places"].append(entry)

    OUT.write_text(json.dumps(out, indent=1))
    table = pd.DataFrame(out["places"])[["name", "wind_speed_10m", "wind_direction_10m", "wave_height", "sea_surface_temperature"]]
    print(table.to_string(index=False))


if __name__ == "__main__":
    main()

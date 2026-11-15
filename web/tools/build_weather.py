"""Snapshot of live weather on a 5-degree grid over the whole globe, for the globe's
weather overlay. The page shows this file instantly, then refreshes live in the background.

Writes web/data/weather_grid.json:
  {"at": ISO time, "step": 5, "points": [{lat, lon, wind, gust, rain, code, cloud, wave}, ...]}
Same shape as GET /api/weather/grid (see the note to Ben in web/team/kimball.md).

Open-Meteo's free tier allows about 600 point-lookups a minute, so this paces itself
(about 8 minutes for both passes). Run from the repo root:
    /opt/anaconda3/bin/python web/tools/build_weather.py
"""

import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web" / "data" / "weather_grid.json"
STEP = 5
LATS = list(range(-80, 81, STEP))
LONS = list(range(-180, 180, STEP))
BATCH = 120
PER_MINUTE = 480


def get(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # rate limit or network: wait and retry
            print("  retry", attempt + 1, e)
            time.sleep(20 * (attempt + 1))
    return None


def main():
    points = [{"lat": la, "lon": lo} for la in LATS for lo in LONS]
    used = []

    def budget(n):
        while True:
            now = time.time()
            while used and now - used[0][0] > 61:
                used.pop(0)
            if sum(u[1] for u in used) + n <= PER_MINUTE:
                used.append((now, n))
                return
            time.sleep(2)

    batches = [points[i:i + BATCH] for i in range(0, len(points), BATCH)]
    for k, g in enumerate(batches):
        budget(len(g))
        lat = ",".join(str(p["lat"]) for p in g)
        lon = ",".join(str(p["lon"]) for p in g)
        f = get(f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
                "&current=wind_speed_10m,wind_gusts_10m,precipitation,weather_code,cloud_cover&wind_speed_unit=kn")
        for p, r in zip(g, f if isinstance(f, list) else [f] if f else []):
            c = (r or {}).get("current") or {}
            p.update(wind=c.get("wind_speed_10m"), gust=c.get("wind_gusts_10m"), rain=c.get("precipitation"),
                     code=c.get("weather_code"), cloud=c.get("cloud_cover"), wave=None)
        print(f"forecast {k + 1}/{len(batches)}")
    for k, g in enumerate(batches):
        budget(len(g))
        lat = ",".join(str(p["lat"]) for p in g)
        lon = ",".join(str(p["lon"]) for p in g)
        m = get(f"https://marine-api.open-meteo.com/v1/marine?latitude={lat}&longitude={lon}&current=wave_height")
        for p, r in zip(g, m if isinstance(m, list) else [m] if m else []):
            c = (r or {}).get("current") or {}
            p["wave"] = c.get("wave_height")
        print(f"marine {k + 1}/{len(batches)}")
    out = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "step": STEP, "points": points}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    n = sum(1 for p in points if p.get("wind") is not None)
    print(f"wrote {OUT.relative_to(ROOT)}: {n}/{len(points)} points, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

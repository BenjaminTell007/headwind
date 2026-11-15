"""Height above sea level for every land dot on the globe, so mountains can stand up.

Reads web/data/land.json (dots as lat*100, lon*100 pairs) and writes web/data/land_elev.json:
  {"unit_m": 50, "elev": [one whole number per dot, in units of 50 m]}
Heights come from Open-Meteo's elevation API (Copernicus 90 m model), 100 dots a request.
Run from the repo root (about 2 minutes):
    /opt/anaconda3/bin/python web/tools/build_elev.py
"""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
land = json.loads((ROOT / "web/data/land.json").read_text())
dots = land["dots"]
n = len(dots) // 2
# Open-Meteo counts a 100-point request as several calls against its 600-a-minute limit, so this
# goes slowly (one request every 1.5 s, about 5 minutes) and waits a minute when told to.
# Progress is kept in a scratch file so a rerun carries on where it stopped.
part = ROOT / "web/data/.land_elev.part.json"
elev = json.loads(part.read_text()) if part.exists() else []
while len(elev) < n:
    start = len(elev)
    idx = range(start, min(n, start + 100))
    lat = ",".join(f"{dots[2 * i] / 100:.2f}" for i in idx)
    lon = ",".join(f"{dots[2 * i + 1] / 100:.2f}" for i in idx)
    url = f"https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lon}"
    try:
        with urllib.request.urlopen(url, timeout=40) as r:
            vals = json.loads(r.read())["elevation"]
    except Exception as e:  # rate limit or network: wait and try the same batch again
        print("  waiting a minute:", e, flush=True)
        time.sleep(62)
        continue
    elev.extend(max(0, round((v or 0) / 50)) for v in vals)
    part.write_text(json.dumps(elev))
    if start % 2000 == 0:
        print(start, "/", n, flush=True)
    time.sleep(1.5)
part.unlink()
out = ROOT / "web/data/land_elev.json"
out.write_text(json.dumps({"unit_m": 50, "elev": elev}, separators=(",", ":")))
print("wrote", out.relative_to(ROOT), out.stat().st_size // 1024, "KB, highest", max(elev) * 50, "m")

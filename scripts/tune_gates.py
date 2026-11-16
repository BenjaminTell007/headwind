"""Move hand-drawn gate lines to where ships actually cross.

My gate lines were drawn from a map. Some ended up where the free AIS feed
doesn't see ships, or along the traffic instead of across it. This script uses
the overnight ship tracks to place each line better:

  1. Take the moving cargo ships and tankers (over 4 knots) near the gate and join each ship's
     positions into track segments (no gaps over 30 minutes).
  2. Work out the main direction of traffic from the ships' courses.
  3. Try lines at right angles to that direction, centred on a grid of points
     around the gate, the same length as the original line.
  4. Keep the line that the most segments cross, if it beats the original
     by a clear margin.

Run after ais_logger.py has a few hours of data, then rerun summarize_live.py:
  ~/.venvs/chokepoint/bin/python -I scripts/tune_gates.py

It keeps a copy of the old lines in gates.json under "lines_before_tuning".
"""
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
GATES = ROOT / "data" / "gates.json"
LIVE = ROOT / "data" / "live"

SEARCH_DEG = 0.3        # how far around the original line to look
GRID_DEG = 0.02         # spacing of candidate centres
MAX_GAP_MIN = 30
MIN_GAIN = 1.25         # new line must catch at least 25% more crossings


def load_positions():
    frames = [pd.read_csv(p, usecols=["time_utc", "mmsi", "lat", "lon", "sog", "cog"]) for p in sorted(LIVE.glob("gates_*.csv"))]
    p = pd.concat(frames, ignore_index=True)
    p["t"] = pd.to_datetime(p["time_utc"].astype(str).str.replace(" UTC", "", regex=False), utc=True, errors="coerce", format="mixed")
    p = p.dropna(subset=["t"])
    # Only cargo ships (AIS type 70-79) and tankers (80-89). Ferries, tugs and
    # pilot boats cross the same line over and over and would pull gates into harbours.
    static = pd.concat([pd.read_csv(f, usecols=["mmsi", "type"]) for f in sorted(LIVE.glob("static_*.csv"))])
    trade = set(static[static["type"].between(70, 89)]["mmsi"])
    return p[p["mmsi"].isin(trade)]


def segments(p):
    """Arrays of track segments (x1, y1, x2, y2) for consecutive positions of the same ship."""
    p = p.sort_values(["mmsi", "t"])
    same = p["mmsi"].to_numpy()[1:] == p["mmsi"].to_numpy()[:-1]
    gap = (p["t"].to_numpy()[1:] - p["t"].to_numpy()[:-1]) / np.timedelta64(1, "m")
    keep = same & (gap <= MAX_GAP_MIN)
    lon = p["lon"].to_numpy()
    lat = p["lat"].to_numpy()
    return lon[:-1][keep], lat[:-1][keep], lon[1:][keep], lat[1:][keep]


def count_crossings(seg, a, b):
    """How many segments cross the line a-b (vectorised)."""
    x1, y1, x2, y2 = seg
    ax, ay = a
    bx, by = b

    def orient(px, py, qx, qy, rx, ry):
        return (qx - px) * (ry - py) - (qy - py) * (rx - px)

    d1 = orient(ax, ay, bx, by, x1, y1)
    d2 = orient(ax, ay, bx, by, x2, y2)
    d3 = orient(x1, y1, x2, y2, ax, ay)
    d4 = orient(x1, y1, x2, y2, bx, by)
    return int(np.sum((d1 * d2 < 0) & (d3 * d4 < 0)))


def main():
    gates = json.loads(GATES.read_text())
    positions = load_positions()
    moving = positions[positions["sog"] > 4]

    if "lines_before_tuning" not in gates:
        gates["lines_before_tuning"] = json.loads(json.dumps(gates["lines"]))
    else:
        # Always tune from the hand-drawn lines, not from an earlier tuning run.
        gates["lines"] = json.loads(json.dumps(gates["lines_before_tuning"]))

    for line in gates["lines"]:
        a = line["a"]
        b = line["b"]
        lon_lo = min(a[0], b[0]) - SEARCH_DEG
        lon_hi = max(a[0], b[0]) + SEARCH_DEG
        lat_lo = min(a[1], b[1]) - SEARCH_DEG
        lat_hi = max(a[1], b[1]) + SEARCH_DEG
        near = moving[(moving["lon"].between(lon_lo, lon_hi)) & (moving["lat"].between(lat_lo, lat_hi))]
        if near["mmsi"].nunique() < 20:
            print(f"{line['id']:14s} too few moving ships ({near['mmsi'].nunique()}), left as is")
            continue

        seg = segments(near)
        before = count_crossings(seg, a, b)

        # Main traffic direction from course over ground. Courses point both
        # ways along a lane, so average the doubled angle.
        cog = np.radians(near["cog"].dropna().to_numpy() % 360)
        ang2 = math.atan2(np.mean(np.sin(2 * cog)), np.mean(np.cos(2 * cog))) / 2
        # Unit vector of traffic (cog is clockwise from north: dx=sin, dy=cos),
        # with longitude stretched so distances are roughly even.
        mid_lat = (lat_lo + lat_hi) / 2
        k = math.cos(math.radians(mid_lat))
        tx, ty = math.sin(ang2) / k, math.cos(ang2)
        norm = math.hypot(tx * k, ty)
        tx, ty = tx / norm, ty / norm
        # The gate runs at right angles to the traffic.
        gx, gy = -ty / k, tx * k
        gnorm = math.hypot(gx * k, gy)
        gx, gy = gx / gnorm, gy / gnorm
        half = math.hypot((b[0] - a[0]) * k, b[1] - a[1]) / 2

        best = (before, a, b)
        for cx in np.arange(lon_lo, lon_hi, GRID_DEG / k):
            for cy in np.arange(lat_lo, lat_hi, GRID_DEG):
                na = [cx - gx * half, cy - gy * half]
                nb = [cx + gx * half, cy + gy * half]
                n = count_crossings(seg, na, nb)
                if n > best[0]:
                    best = (n, na, nb)

        if best[0] >= max(before * MIN_GAIN, before + 5):
            line["a"] = [round(best[1][0], 4), round(best[1][1], 4)]
            line["b"] = [round(best[2][0], 4), round(best[2][1], 4)]
            line["tuned"] = True
            print(f"{line['id']:14s} moved: {before} -> {best[0]} crossings")
        else:
            print(f"{line['id']:14s} kept: {before} crossings (best alternative {best[0]})")

    GATES.write_text(json.dumps(gates, indent=1))


if __name__ == "__main__":
    main()

"""When has a ship arrived at a port? The rule that settles arrival markets.

A ship has arrived when, inside the port area, it is either
  - reporting AIS navigational status 1 (at anchor) or 5 (moored), or
  - doing under 1 knot for at least 30 minutes (two or more positions spanning 30 minutes).
The arrival time is the first position that meets the rule. Anchoring in the port's anchorage
counts, as an "arrived ship" does in charter parties: from there the delay is the port's, not the voyage's.

Port area: the port-approach box in data/gates.json when there is one, else 8 nm around the port.

The oracle (server) settles an arrival market:
  - arrival found before the deadline   -> resolve(id, arrival_unix)   -> NO (on time), can be early
  - deadline passed with no arrival     -> resolve(id, deadline_unix)  -> YES (late)
  - ship silent for 6 h+ at the deadline (no AIS) -> resolveInvalid(id): every share pays 0.5

Pure functions: pass in positions, get an answer. No network, stdlib only.
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

from model import gc_nm, NEAR_PORT_NM  # noqa: F401  (same folder)

ROOT = Path(__file__).resolve().parents[2]
SLOW_KN = 1.0
DWELL = timedelta(minutes=30)
SILENT = timedelta(hours=6)
STOPPED_STATUS = {"1", "5"}  # at anchor, moored


def _boxes():
    g = json.loads((ROOT / "data" / "gates.json").read_text())
    return {b["id"]: b for b in g.get("boxes", [])}


def port_area(port, gate_id=None):
    """A function (lat, lon) -> inside? for the port."""
    boxes = _boxes()
    box = boxes.get(gate_id or port["name"].lower().replace(" ", "_"))
    if box and box.get("kind") == "port":  # {"lon": [w, e], "lat": [s, n]}
        (x0, x1), (y0, y1) = sorted(box["lon"]), sorted(box["lat"])
        near = lambda lat, lon: gc_nm(lat, lon, float(port["lat"]), float(port["lon"])) <= NEAR_PORT_NM
        return lambda lat, lon: (x0 <= lon <= x1 and y0 <= lat <= y1) or near(lat, lon)
    plat, plon = float(port["lat"]), float(port["lon"])
    return lambda lat, lon: gc_nm(lat, lon, plat, plon) <= NEAR_PORT_NM


def _t(p):
    t = p["time"] if "time" in p else p["time_utc"]
    return t if isinstance(t, datetime) else datetime.fromisoformat(str(t).replace("Z", "+00:00"))


def find_arrival(positions, inside):
    """First arrival time in a ship's positions (dicts with time, lat, lon, sog, nav_status), or None."""
    slow_since = None
    for p in sorted(positions, key=_t):
        t = _t(p)
        if not inside(float(p["lat"]), float(p["lon"])):
            slow_since = None
            continue
        if str(p.get("nav_status", "")).split(".")[0] in STOPPED_STATUS:
            return t
        if float(p.get("sog") or 99) < SLOW_KN:
            slow_since = slow_since or t
            if t - slow_since >= DWELL:
                return slow_since
        else:
            slow_since = None
    return None


def settle(positions, inside, deadline, now):
    """What the oracle should do now: ('wait', None), ('resolve', unix_value) or ('invalid', None)."""
    arrived = find_arrival(positions, inside)
    if arrived and arrived < deadline:
        return "resolve", int(arrived.timestamp())  # on time: NO
    if now < deadline:
        return "wait", None
    last = max((_t(p) for p in positions), default=None)
    if arrived:
        return "resolve", int(arrived.timestamp())  # arrived, but at/after the deadline: YES
    if last is None or deadline - last > SILENT:
        return "invalid", None  # went dark: can't tell
    return "resolve", int(deadline.timestamp())  # still at sea at the deadline: YES

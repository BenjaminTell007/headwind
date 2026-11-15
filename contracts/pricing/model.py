"""Pricing model: the starting odds for a market, from the ship and trade data we have.

The main product is a ship-arrival market: "Will <ship> arrive at <port> after <deadline>?"
YES = late. A trade manager hedging a shipment buys YES; it pays if the cargo is late.

P(late) comes from a forecast of the arrival time:

    hours to go = sea distance / (speed x weather factor)
                + strait disruption delay   (straits on the way that are running below normal)
                + port waiting time         (the destination's current congestion)

blended with the crew's reported ETA when it is plausible, and an uncertainty that grows with
distance, rough weather and disrupted straits. Arrival time ~ Normal(mean, sigma), so

    P(late) = 1 - Phi((deadline - expected arrival) / sigma)

Comtrade's lane cargo mix doesn't move the odds; it sets the cost of a day of delay
(Hummels & Schaur 2013) for the suggested hedge size.

Stdlib only, so the server can import it without new packages. Live inputs (the ship, weather)
are fetched when not passed in; everything else comes from data/processed/.
"""

import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "processed"
SERVER = "https://headway-production-83bb4bd7.up.railway.app"

TYPICAL_KNOTS = {"cargo": 15.0, "tanker": 12.5, "passenger": 16.0, "other": 11.0, "unknown": 12.0}
ROUTE_FACTOR = 1.2  # sea distance / great-circle distance, for short and medium legs
NEAR_PORT_NM = 8.0  # inside this, a slow ship counts as arrived (see arrival.py)

# Extra days if a strait on the way is closed and ships reroute (Cape of Good Hope for the Red Sea).
REROUTE_DAYS = {
    "Suez Canal": 9.2, "Bab el-Mandeb Strait": 9.2, "Strait of Hormuz": 4.0, "Panama Canal": 6.0,
    "Malacca Strait": 2.5, "Gibraltar Strait": 3.0, "Bosporus Strait": 2.0,
}
# Hummels & Schaur: one day of delay costs 0.6% to 2.1% of cargo value, more for time-sensitive goods.
COST_PER_DAY_PCT = {
    "Machinery & electronics": 2.1, "Instruments, clocks & arms": 2.1, "Vehicles & transport": 1.6,
    "Chemicals & pharma": 1.4, "Textiles & clothing": 1.3, "Furniture, toys & misc.": 1.0,
    "Plastics & rubber": 0.9, "Base metals": 0.8, "Food & agriculture": 1.2, "Mineral fuels & ores": 0.6,
}


# ------------------------------------------------------------------ data

def _load(name):
    return json.loads((DATA / name).read_text())


@lru_cache(maxsize=None)
def ports():
    """Ports by normalised name and by LOCODE (no space), from PortWatch."""
    out = {}
    for p in _load("portwatch_ports.json"):
        out.setdefault(p["name"].lower(), p)
        if p.get("locode"):
            out.setdefault(p["locode"].replace(" ", "").upper(), p)
    return out


def find_port(query):
    q = query.strip()
    p = ports().get(q.replace(" ", "").upper()) or ports().get(q.lower())
    if not p:
        raise KeyError(f"unknown port: {query}")
    return p


def port_code(p):
    return (p.get("locode") or p["id"]).replace(" ", "").upper()


@lru_cache(maxsize=None)
def chokepoints():
    """Strait name -> (lat, lon, latest traffic / baseline)."""
    status = _load("chokepoint_status.json")["chokepoints"]
    places = {w["name"]: w for w in _load("weather_snapshot.json")["places"] if w.get("kind") == "chokepoint"}
    out = {}
    for name, s in status.items():
        if name in places:
            out[name] = (places[name]["lat"], places[name]["lon"], s["latest_ratio"])
    return out


@lru_cache(maxsize=None)
def port_congestion():
    """Port name -> latest weekly calls / baseline weekly calls (1.0 = normal)."""
    base = _load("port_baselines.json")["ports"]
    weekly = _load("port_calls_weekly.json")
    out = {}
    for name, b in base.items():
        w = weekly.get(name, {})
        series = w.get("total") or []
        if len(series) >= 2 and b.get("calls_per_day_mean"):
            # mean of the last two weeks, in case the latest one is partial
            out[name.lower()] = (series[-1] + series[-2]) / 2 / (7 * b["calls_per_day_mean"])
    return out


# ------------------------------------------------------------------ geometry

def gc_nm(lat1, lon1, lat2, lon2):
    """Great-circle distance in nautical miles."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 3440.065 * math.asin(math.sqrt(a))


def sea_nm(lat1, lon1, lat2, lon2):
    """Sea-route distance: the searoute package if installed, else great circle x ROUTE_FACTOR."""
    try:
        import searoute  # optional, heavy; in scripts/requirements.txt

        route = searoute.searoute([lon1, lat1], [lon2, lat2], units="naut")
        return float(route["properties"]["length"]), "searoute"
    except Exception:
        return gc_nm(lat1, lon1, lat2, lon2) * ROUTE_FACTOR, "great circle x1.2"


def straits_ahead(lat, lon, plat, plon):
    """Straits roughly on the way: going through them adds little to the distance."""
    direct = gc_nm(lat, lon, plat, plon)
    out = []
    for name, (clat, clon, ratio) in chokepoints().items():
        via = gc_nm(lat, lon, clat, clon) + gc_nm(clat, clon, plat, plon)
        if via <= direct * 1.15 + 150 and gc_nm(lat, lon, clat, clon) > 20:
            out.append((name, ratio))
    return out


# ------------------------------------------------------------------ live inputs

def _get_json(url, timeout=8):
    req = urllib.request.Request(url, headers={"user-agent": "headway-pricing"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def fetch_ship(query):
    return _get_json(f"{SERVER}/api/ship/{urllib.parse.quote(str(query))}")


def fetch_weather(lat, lon):
    """Wave height (m) and wind (knots) at a point, from Open-Meteo. Falls back to calm-ish defaults."""
    out = {"wave_m": None, "wind_kn": None, "source": "open-meteo"}
    try:
        m = _get_json("https://marine-api.open-meteo.com/v1/marine?" + urllib.parse.urlencode(
            {"latitude": round(lat, 3), "longitude": round(lon, 3), "current": "wave_height"}))
        out["wave_m"] = m.get("current", {}).get("wave_height")
        f = _get_json("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(
            {"latitude": round(lat, 3), "longitude": round(lon, 3), "current": "wind_speed_10m", "wind_speed_unit": "kn"}))
        out["wind_kn"] = f.get("current", {}).get("wind_speed_10m")
    except Exception:
        out["source"] = "default (weather unavailable)"
    return out


# ------------------------------------------------------------------ the model

def _phi(z):
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def _parse_ais_eta(eta, now):
    """AIS ETA is 'MM-DD HH:MM' with no year, typed by the crew. Returns a datetime or None."""
    try:
        md, hm = eta.split()
        month, day = (int(x) for x in md.split("-"))
        hour, minute = (int(x) for x in hm.split(":"))
        if not (1 <= month <= 12 and 1 <= day <= 31 and hour < 24 and minute < 60):
            return None
        for year in (now.year, now.year + 1):
            t = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
            if t > now - timedelta(days=2):
                return t
    except Exception:
        return None
    return None


def cargo_cost_per_day(ship_type, port_name):
    """Cost of one day of delay as % of cargo value, from the Comtrade product mix of lanes into this port."""
    mix = _load("lane_cargo_mix.json")["lanes"]
    lanes = [v for k, v in mix.items() if k.split("-")[-1].lower() == port_name.lower()]
    if not lanes or ship_type == "tanker":
        return (0.6 if ship_type == "tanker" else 1.2), "default for vessel type"
    sections = lanes[0]["by_section"]
    pct = sum(s["share"] * COST_PER_DAY_PCT.get(s["section"], 1.0) for s in sections) / max(
        sum(s["share"] for s in sections), 1e-9)
    return round(pct, 2), f"Comtrade mix {lanes[0]['from_country']} to {lanes[0]['to_country']}"


def price_arrival(ship, port, deadline, now=None, weather=None):
    """P(the ship arrives at `port` at or after `deadline`), with the working shown.

    ship: dict from /api/ship (lat, lon, sog, type_group, eta, name, imo, mmsi, time)
    port: dict from find_port()
    deadline: aware datetime
    """
    now = now or datetime.now(timezone.utc)
    lat, lon = float(ship["lat"]), float(ship["lon"])
    plat, plon = float(port["lat"]), float(port["lon"])
    group = ship.get("type_group") or "unknown"

    dist, dist_method = sea_nm(lat, lon, plat, plon)
    sog = float(ship.get("sog") or 0)
    at_port = gc_nm(lat, lon, plat, plon) <= NEAR_PORT_NM
    speed = sog if sog >= 3 else TYPICAL_KNOTS.get(group, 12.0)

    weather = weather or fetch_weather(lat, lon)
    wave = weather.get("wave_m") or 1.5
    wind = weather.get("wind_kn") or 12
    slow = min(0.35, 0.04 * max(0.0, wave - 2.0) + 0.005 * max(0.0, wind - 20))
    sail_h = 0.0 if at_port else dist / (speed * (1 - slow))

    # Straits on the way running below normal: expected reroute delay and extra uncertainty.
    strait_h, strait_sd, strait_notes = 0.0, 0.0, []
    for name, ratio in straits_ahead(lat, lon, plat, plon):
        shortfall = max(0.0, 1.0 - ratio)
        if shortfall > 0.05:
            extra = REROUTE_DAYS.get(name, 1.0) * 24
            strait_h += shortfall * extra * 0.5
            strait_sd += shortfall * extra * 0.5
            strait_notes.append(f"{name} at {ratio:.0%} of normal")

    # Port congestion: waiting time grows with calls above the baseline.
    cong = port_congestion().get(port["name"].lower(), 1.0)
    wait_h = 6.0 * max(0.5, cong) ** 2

    model_h = sail_h + strait_h + wait_h
    expected = now + timedelta(hours=model_h)

    # Crew ETA: trust it half when it is within 3 days of the model.
    crew_eta = _parse_ais_eta(ship.get("eta") or "", now)
    eta_note = "no usable crew ETA"
    if crew_eta and abs((crew_eta - expected).total_seconds()) < 3 * 86400 \
            and (ship.get("destination") or "").strip():
        expected = expected + (crew_eta - expected) / 2
        eta_note = f"blended with crew ETA {crew_eta:%b %d %H:%M}"

    sigma_h = math.sqrt(
        (2.0 + 0.06 * sail_h) ** 2          # speed and routing error grows with distance
        + (0.03 * sail_h * max(0.0, wave - 2.5)) ** 2  # rough seas
        + strait_sd ** 2
        + (3.0 * cong) ** 2                 # berth/anchorage wait
    )
    margin_h = (deadline - expected).total_seconds() / 3600
    p_late = 1 - _phi(margin_h / sigma_h)

    cost_pct, cost_source = cargo_cost_per_day(group, port["name"])
    return {
        "p_yes": p_late,
        "expected_arrival": expected.isoformat(timespec="minutes"),
        "sigma_hours": round(sigma_h, 1),
        "hours_to_spare": round(margin_h, 1),
        "inputs": {
            "ship": {k: ship.get(k) for k in ("name", "imo", "mmsi", "type_group", "lat", "lon", "sog", "destination", "eta", "time")},
            "port": {"name": port["name"], "code": port_code(port), "lat": plat, "lon": plon},
            "distance_nm": round(dist), "distance_method": dist_method,
            "speed_kn": round(speed, 1), "weather": weather, "speed_loss_pct": round(slow * 100, 1),
            "sail_hours": round(sail_h, 1), "strait_delay_hours": round(strait_h, 1), "straits": strait_notes,
            "port_congestion": round(cong, 2), "port_wait_hours": round(wait_h, 1), "eta": eta_note,
            "delay_cost_pct_per_day": cost_pct, "delay_cost_source": cost_source,
        },
    }


def suggest_hedge(cargo_usd, p_yes, hours_late_if_late, cost_pct_per_day, usd_per_mon):
    """Cover = the loss if late: cargo x days late x cost per day. In MON at the demo rate."""
    loss_usd = cargo_usd * (hours_late_if_late / 24) * cost_pct_per_day / 100
    return {"loss_usd": round(loss_usd), "cover_mon": loss_usd / usd_per_mon, "fair_premium_mon": p_yes * loss_usd / usd_per_mon}


if __name__ == "__main__":
    import sys

    q = sys.argv[1] if len(sys.argv) > 1 else "COSCO SAGITTARIUS"
    s = fetch_ship(q)
    p = find_port(sys.argv[2] if len(sys.argv) > 2 else (s.get("destination") or "Rotterdam").split(">")[-1].strip().title())
    dl = datetime.now(timezone.utc) + timedelta(hours=float(sys.argv[3]) if len(sys.argv) > 3 else 24)
    print(json.dumps(price_arrival(s, p, dl), indent=1, default=str))

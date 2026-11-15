"""Precompute sea lanes between major ports with searoute.

For each lane I compute:
  - the normal shortest route (Arctic routes closed)
  - an alternative route that avoids the canal it normally uses
    (Suez lanes get a Cape of Good Hope alternative, Panama lanes get one
    that avoids Panama)
  - distance in nautical miles and days at a typical speed
  - which PortWatch chokepoints the route passes near

Outputs (data/processed/):
  lanes.geojson       normal routes, one feature per lane
  lanes_alt.geojson   alternative routes for lanes that use Suez or Panama
  lane_table.csv      one row per lane with distances, days and chokepoints

Run:  ~/.venvs/chokepoint/bin/python -I scripts/build_lanes.py
"""
import json
import math
from pathlib import Path

import pandas as pd
import searoute as sr

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "processed"
OUT.mkdir(parents=True, exist_ok=True)
CHOKEPOINTS = ROOT / "data" / "raw" / "portwatch" / "chokepoints.csv"

# Typical speeds in knots. Container ships slow-steam around 14 to 16.
SPEED_KNOTS = {"container": 15, "tanker": 13, "bulk": 13}

# A route "passes" a chokepoint if it comes within this many nautical miles
# of the chokepoint's PortWatch point.
NEAR_NM = 75

# Ports as (lon, lat). Points sit just off the port so searoute snaps cleanly.
PORTS = {
    "Shanghai": (122.05, 30.6),
    "Ningbo": (121.9, 29.9),
    "Shenzhen": (114.3, 22.55),
    "Busan": (129.05, 35.08),
    "Kaohsiung": (120.3, 22.6),
    "Tokyo": (139.7, 35.4),
    "Singapore": (103.8, 1.25),
    "Port Klang": (101.35, 3.0),
    "Port Hedland": (118.6, -20.3),
    "Nhava Sheva": (72.95, 18.95),
    "Colombo": (79.85, 6.95),
    "Jebel Ali": (55.0, 25.0),
    "Ras Tanura": (50.17, 26.65),
    "Durban": (31.05, -29.87),
    "Lagos": (3.38, 6.43),
    "Piraeus": (23.6, 37.94),
    "Genoa": (8.9, 44.4),
    "Valencia": (-0.3, 39.45),
    "Rotterdam": (4.0, 51.95),
    "Antwerp": (4.3, 51.3),
    "Hamburg": (9.9, 53.55),
    "Felixstowe": (1.35, 51.95),
    "New York": (-74.05, 40.6),
    "Savannah": (-80.9, 32.08),
    "Houston": (-94.8, 29.3),
    "Los Angeles": (-118.27, 33.73),
    "Vancouver": (-123.1, 49.3),
    "Santos": (-46.3, -23.98),
    "Constanta": (28.75, 44.1),
    "Gdansk": (18.75, 54.45),
}

# (origin, destination, vessel type, trade group)
LANES = [
    ("Shanghai", "Rotterdam", "container", "Asia-Europe"),
    ("Ningbo", "Hamburg", "container", "Asia-Europe"),
    ("Shenzhen", "Antwerp", "container", "Asia-Europe"),
    ("Busan", "Rotterdam", "container", "Asia-Europe"),
    ("Singapore", "Rotterdam", "container", "Asia-Europe"),
    ("Kaohsiung", "Felixstowe", "container", "Asia-Europe"),
    ("Shanghai", "Piraeus", "container", "Asia-Med"),
    ("Shenzhen", "Genoa", "container", "Asia-Med"),
    ("Shanghai", "Los Angeles", "container", "Transpacific"),
    ("Busan", "Los Angeles", "container", "Transpacific"),
    ("Shenzhen", "Los Angeles", "container", "Transpacific"),
    ("Tokyo", "Los Angeles", "container", "Transpacific"),
    ("Busan", "Vancouver", "container", "Transpacific"),
    ("Shanghai", "New York", "container", "Asia-US East"),
    ("Shenzhen", "Savannah", "container", "Asia-US East"),
    ("Rotterdam", "New York", "container", "Transatlantic"),
    ("Hamburg", "Savannah", "container", "Transatlantic"),
    ("Felixstowe", "New York", "container", "Transatlantic"),
    ("Valencia", "Houston", "container", "Transatlantic"),
    ("Nhava Sheva", "Rotterdam", "container", "India-Europe"),
    ("Nhava Sheva", "New York", "container", "India-US"),
    ("Colombo", "Singapore", "container", "Intra-Asia"),
    ("Shanghai", "Lagos", "container", "Asia-Africa"),
    ("Lagos", "Rotterdam", "container", "Africa-Europe"),
    ("Ras Tanura", "Ningbo", "tanker", "Gulf-Asia"),
    ("Ras Tanura", "Tokyo", "tanker", "Gulf-Asia"),
    ("Ras Tanura", "Rotterdam", "tanker", "Gulf-Europe"),
    ("Jebel Ali", "Nhava Sheva", "tanker", "Gulf-India"),
    ("Houston", "Rotterdam", "tanker", "US-Europe"),
    ("Houston", "Ningbo", "tanker", "US-Asia"),
    ("Santos", "Shanghai", "bulk", "Brazil-Asia"),
    ("Santos", "Rotterdam", "bulk", "Brazil-Europe"),
    ("Port Hedland", "Shanghai", "bulk", "Australia-Asia"),
    ("Durban", "Shanghai", "bulk", "Africa-Asia"),
    ("Constanta", "Piraeus", "bulk", "Black Sea-Med"),
    ("Constanta", "Rotterdam", "bulk", "Black Sea-Europe"),
    ("Gdansk", "Rotterdam", "container", "Baltic-Europe"),
]


def haversine_nm(lon1, lat1, lon2, lat2):
    r_nm = 3440.065  # Earth radius in nautical miles
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r_nm * math.asin(math.sqrt(a))


def densify(coords, step_nm=50):
    """Add points along long segments so the chokepoint check doesn't skip gaps."""
    out = [coords[0]]
    for (lon1, lat1), (lon2, lat2) in zip(coords[:-1], coords[1:]):
        d = haversine_nm(lon1, lat1, lon2, lat2)
        n = max(1, int(d // step_nm))
        for k in range(1, n + 1):
            t = k / n
            out.append((lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t))
    return out


def chokepoints_near(coords, chokepoints):
    dense = densify(coords)
    hits = []
    for _, cp in chokepoints.iterrows():
        closest = min(haversine_nm(lon, lat, cp["lon"], cp["lat"]) for lon, lat in dense)
        if closest <= NEAR_NM:
            hits.append(cp["portname"])
    return hits


def route(origin, destination, restrictions):
    # Always keep 'northwest' restricted, otherwise searoute opens Arctic routes.
    feature = sr.searoute(
        list(PORTS[origin]),
        list(PORTS[destination]),
        units="naut",
        restrictions=["northwest"] + restrictions,
        append_orig_dest=True,
        return_passages=True,
    )
    return feature


def main():
    chokepoints = pd.read_csv(CHOKEPOINTS)

    normal_features = []
    alt_features = []
    rows = []

    for origin, destination, vessel, group in LANES:
        lane_id = f"{origin}-{destination}".replace(" ", "_")
        speed = SPEED_KNOTS[vessel]

        normal = route(origin, destination, [])
        coords = normal["geometry"]["coordinates"]
        nm = normal["properties"]["length"]
        passages = normal["properties"].get("traversed_passages", [])
        near = chokepoints_near(coords, chokepoints)

        row = {
            "lane_id": lane_id,
            "origin": origin,
            "destination": destination,
            "vessel": vessel,
            "group": group,
            "nm": round(nm),
            "days": round(nm / speed / 24, 1),
            "passages": "|".join(passages),
            "chokepoints": "|".join(near),
            "alt_kind": "",
            "alt_nm": None,
            "alt_days": None,
            "extra_nm": None,
            "extra_days": None,
        }

        normal_features.append({
            "type": "Feature",
            "geometry": normal["geometry"],
            "properties": {k: row[k] for k in ["lane_id", "origin", "destination", "vessel", "group", "nm", "days", "chokepoints"]},
        })

        # Alternative route if the lane relies on a canal.
        alt_restrictions = None
        if "suez" in passages:
            row["alt_kind"] = "cape"
            alt_restrictions = ["suez", "babalmandab", "panama"]
        elif "panama" in passages:
            row["alt_kind"] = "no_panama"
            alt_restrictions = ["panama"]

        if alt_restrictions is not None:
            alt = route(origin, destination, alt_restrictions)
            alt_nm = alt["properties"]["length"]
            row["alt_nm"] = round(alt_nm)
            row["alt_days"] = round(alt_nm / speed / 24, 1)
            row["extra_nm"] = round(alt_nm - nm)
            row["extra_days"] = round((alt_nm - nm) / speed / 24, 1)
            alt_features.append({
                "type": "Feature",
                "geometry": alt["geometry"],
                "properties": {
                    "lane_id": lane_id,
                    "alt_kind": row["alt_kind"],
                    "nm": row["alt_nm"],
                    "days": row["alt_days"],
                    "chokepoints": "|".join(chokepoints_near(alt["geometry"]["coordinates"], chokepoints)),
                },
            })

        rows.append(row)
        print(f"{lane_id:28s} {row['nm']:6d} nm  {row['days']:5.1f} d  alt {row['alt_kind'] or '-':9s} +{row['extra_days'] or 0} d")

    (OUT / "lanes.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": normal_features}))
    (OUT / "lanes_alt.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": alt_features}))
    pd.DataFrame(rows).to_csv(OUT / "lane_table.csv", index=False)

    ports = pd.DataFrame([{"port": k, "lon": v[0], "lat": v[1]} for k, v in PORTS.items()])
    ports.to_csv(OUT / "ports.csv", index=False)


if __name__ == "__main__":
    main()

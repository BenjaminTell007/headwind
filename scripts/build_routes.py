"""Build the full route network: every corridor between world regions, plus
the real shipping legs from PortWatch.

Two layers.

1. Corridors. I split the world's coasts into 21 regions, each with one hub
   port, and route every pair of hubs with searoute. That's 210 corridors, so
   every major trade route is covered, not a hand-picked few. For each corridor
   I record which closable passages it uses and, for each one, what happens if
   that passage shuts: the alternative route's extra distance and days, or
   "blocked" if there's no way round (Hormuz, Bosporus).

2. Network legs. PortWatch's maritime connections are the port-to-port legs
   ships actually sail, with a flow estimate. I route the biggest ones so the
   globe can draw the real network with line widths.

Inputs:  data/raw/portwatch/chokepoints.csv, connections.csv
Outputs (data/processed/):
  corridors.geojson       normal route for each corridor
  corridors_alt.geojson   one alternative per corridor per passage it uses
  corridor_table.csv      one row per corridor
  corridor_alts.csv       one row per corridor and passage group
  regions.json            the regions and their hubs
  network_legs.geojson    the biggest real shipping legs, with flow

Run:  ~/.venvs/chokepoint/bin/python -I scripts/build_routes.py
"""
import json
import math
import warnings
from itertools import combinations
from pathlib import Path

import pandas as pd
import searoute as sr

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "processed"
RAW = ROOT / "data" / "raw" / "portwatch"

SPEED_KNOTS = 15          # container ship slow-steaming speed
NEAR_NM = 75              # a route "passes" a chokepoint if it comes this close
N_NETWORK_LEGS = 600      # how many real legs to route
MIN_LEG_KM = 300          # skip tiny hops between neighbouring ports

# Region -> (hub port, lon, lat)
REGIONS = {
    "East Asia": ("Shanghai", 122.05, 30.6),
    "Northeast Asia": ("Busan", 129.05, 35.08),
    "Southeast Asia": ("Singapore", 103.8, 1.25),
    "South Asia": ("Nhava Sheva", 72.95, 18.95),
    "Middle East Gulf": ("Jebel Ali", 55.0, 25.0),
    "Red Sea": ("Jeddah", 39.1, 21.45),
    "East Mediterranean": ("Piraeus", 23.6, 37.94),
    "West Mediterranean": ("Valencia", -0.3, 39.45),
    "Black Sea": ("Constanta", 28.75, 44.1),
    "North Europe": ("Rotterdam", 4.0, 51.95),
    "Baltic": ("Gdansk", 18.75, 54.45),
    "West Africa": ("Lagos", 3.38, 6.43),
    "East Africa": ("Mombasa", 39.7, -4.1),
    "Southern Africa": ("Durban", 31.05, -29.87),
    "North America East": ("New York", -74.05, 40.6),
    "US Gulf": ("Houston", -94.8, 29.3),
    "North America West": ("Los Angeles", -118.27, 33.73),
    "Caribbean": ("Kingston", -76.8, 17.95),
    "South America East": ("Santos", -46.3, -23.98),
    "South America West": ("Callao", -77.2, -12.05),
    "Oceania": ("Sydney", 151.3, -33.95),
}

# Passages searoute can close, grouped the way they fail together.
# Each group maps to the PortWatch chokepoints that measure it.
PASSAGE_GROUPS = {
    "red_sea":   {"passages": ["suez", "babalmandab"], "chokepoints": ["Suez Canal", "Bab el-Mandeb Strait"]},
    "panama":    {"passages": ["panama"],       "chokepoints": ["Panama Canal"]},
    "malacca":   {"passages": ["malacca"],      "chokepoints": ["Malacca Strait"]},
    "sunda":     {"passages": ["sunda"],        "chokepoints": ["Sunda Strait"]},
    "hormuz":    {"passages": ["ormuz"],        "chokepoints": ["Strait of Hormuz"]},
    "bosporus":  {"passages": ["bosporus"],     "chokepoints": ["Bosporus Strait"]},
    "gibraltar": {"passages": ["gibraltar"],    "chokepoints": ["Gibraltar Strait"]},
    "cape":      {"passages": ["south_africa"], "chokepoints": ["Cape of Good Hope"]},
    "magellan":  {"passages": ["chili"],        "chokepoints": ["Magellan Strait"]},
    "bering":    {"passages": ["bering"],       "chokepoints": ["Bering Strait"]},
}


def haversine_nm(lon1, lat1, lon2, lat2):
    r_nm = 3440.065
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r_nm * math.asin(math.sqrt(a))


def densify(coords, step_nm=50):
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


def route(origin, destination, closed):
    """Shortest sea route with some passages closed. Returns None if there's no way through."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        feature = sr.searoute(
            list(origin), list(destination), units="naut",
            # 'northwest' stays closed so searoute doesn't use Arctic routes.
            restrictions=["northwest"] + closed,
            append_orig_dest=True, return_passages=True,
        )
    if feature["properties"]["length"] == 0 or len(feature["geometry"]["coordinates"]) < 2:
        return None
    return feature


def slug(text):
    return text.lower().replace(" ", "_").replace("/", "_")


def build_corridors(chokepoints):
    features = []
    alt_features = []
    rows = []
    alt_rows = []

    for a, b in combinations(REGIONS.keys(), 2):
        hub_a, lon_a, lat_a = REGIONS[a]
        hub_b, lon_b, lat_b = REGIONS[b]
        corridor_id = f"{slug(a)}__{slug(b)}"

        normal = route((lon_a, lat_a), (lon_b, lat_b), [])
        if normal is None:
            print(f"  no route for {corridor_id}")
            continue
        nm = normal["properties"]["length"]
        days = nm / SPEED_KNOTS / 24
        passages = normal["properties"].get("traversed_passages", [])
        groups = [g for g, spec in PASSAGE_GROUPS.items() if any(p in passages for p in spec["passages"])]
        near = chokepoints_near(normal["geometry"]["coordinates"], chokepoints)

        rows.append({
            "corridor_id": corridor_id, "region_a": a, "region_b": b, "hub_a": hub_a, "hub_b": hub_b,
            "nm": round(nm), "days": round(days, 1),
            "passage_groups": "|".join(groups), "chokepoints": "|".join(near),
        })
        features.append({
            "type": "Feature", "geometry": normal["geometry"],
            "properties": {"corridor_id": corridor_id, "region_a": a, "region_b": b, "nm": round(nm),
                           "days": round(days, 1), "passage_groups": groups, "chokepoints": near},
        })

        for group in groups:
            closed = list(PASSAGE_GROUPS[group]["passages"])
            # When the Red Sea shuts, ships go round the Cape. searoute would
            # sometimes send them through Panama instead (a few miles shorter on
            # paper), which isn't what happened in 2024, so close Panama too.
            if group == "red_sea" and "panama" not in passages:
                closed.append("panama")
            alt = route((lon_a, lat_a), (lon_b, lat_b), closed)
            # Closing a passage can never make the shortest route shorter. If
            # searoute comes back shorter, it couldn't reach one of the hubs
            # (Jebel Ali behind Hormuz, Constanta behind the Bosporus) and
            # measured to the nearest point it could reach. That's a blocked route.
            if alt is not None and alt["properties"]["length"] < nm * 0.999:
                alt = None
            if alt is None:
                alt_rows.append({"corridor_id": corridor_id, "group": group, "blocked": True,
                                 "alt_nm": None, "alt_days": None, "extra_nm": None, "extra_days": None, "alt_via": ""})
                continue
            alt_nm = alt["properties"]["length"]
            alt_passages = alt["properties"].get("traversed_passages", [])
            alt_rows.append({
                "corridor_id": corridor_id, "group": group, "blocked": False,
                "alt_nm": round(alt_nm), "alt_days": round(alt_nm / SPEED_KNOTS / 24, 1),
                "extra_nm": round(alt_nm - nm), "extra_days": round((alt_nm - nm) / SPEED_KNOTS / 24, 1),
                "alt_via": "|".join(alt_passages),
            })
            alt_features.append({
                "type": "Feature", "geometry": alt["geometry"],
                "properties": {"corridor_id": corridor_id, "closed": group, "nm": round(alt_nm),
                               "extra_days": round((alt_nm - nm) / SPEED_KNOTS / 24, 1), "via": alt_passages},
            })

    (OUT / "corridors.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    (OUT / "corridors_alt.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": alt_features}))
    table = pd.DataFrame(rows)
    alts = pd.DataFrame(alt_rows)
    table.to_csv(OUT / "corridor_table.csv", index=False)
    alts.to_csv(OUT / "corridor_alts.csv", index=False)
    regions = {name: {"hub": hub, "lon": lon, "lat": lat} for name, (hub, lon, lat) in REGIONS.items()}
    (OUT / "regions.json").write_text(json.dumps({"regions": regions, "passage_groups": PASSAGE_GROUPS,
                                                  "speed_knots": SPEED_KNOTS}, indent=1))

    print(f"corridors: {len(table)}, alternatives: {len(alts)} ({int(alts['blocked'].sum())} blocked)")
    use = alts.groupby("group").agg(corridors=("corridor_id", "count"), blocked=("blocked", "sum"),
                                    mean_extra_days=("extra_days", "mean")).round(1)
    print(use.to_string())
    used = set("|".join(table["chokepoints"]).split("|"))
    print("PortWatch chokepoints on no corridor:", sorted(set(chokepoints["portname"]) - used))


def build_network_legs(chokepoints):
    path = RAW / "connections.csv"
    if not path.exists():
        print("connections.csv not there yet, skipping network legs (run pull_portwatch_network.py)")
        return
    legs = pd.read_csv(path)
    legs = legs[legs["distance_km"] >= MIN_LEG_KM]

    # Treat A->B and B->A as one leg and add the flows.
    legs["key"] = legs.apply(lambda r: "|".join(sorted([r["from_id"], r["to_id"]])), axis=1)
    flow = legs.groupby("key")["flow_per_day"].sum()
    legs = legs.sort_values("flow_per_day", ascending=False).drop_duplicates("key")
    legs["flow_both_ways"] = legs["key"].map(flow)
    legs = legs.sort_values("flow_both_ways", ascending=False).head(N_NETWORK_LEGS)

    features = []
    for _, leg in legs.iterrows():
        feature = route((leg["from_lon"], leg["from_lat"]), (leg["to_lon"], leg["to_lat"]), [])
        if feature is None:
            continue
        coords = feature["geometry"]["coordinates"]
        features.append({
            "type": "Feature", "geometry": feature["geometry"],
            "properties": {
                "from": leg["from_name"].split("_")[0], "to": leg["to_name"].split("_")[0],
                "from_iso3": leg["from_iso3"], "to_iso3": leg["to_iso3"],
                "flow_per_day": round(float(leg["flow_both_ways"])),
                "nm": round(feature["properties"]["length"]),
                "chokepoints": chokepoints_near(coords, chokepoints),
            },
        })
    (OUT / "network_legs.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    long_haul = sum(1 for f in features if f["properties"]["nm"] > 2500)
    print(f"network legs: {len(features)} routed, {long_haul} over 2,500 nm")


def main():
    chokepoints = pd.read_csv(RAW / "chokepoints.csv")
    build_corridors(chokepoints)
    build_network_legs(chokepoints)


if __name__ == "__main__":
    main()

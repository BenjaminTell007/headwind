"""Build one point per country for the globe arcs, plus simplified outlines.

A trade arc needs somewhere to land in each country. Sources, in order:
  1. hand-set anchors for big countries where the geometric centre is a bad
     place for an arc to land (USA, Canada, Russia and a few others)
  2. Natural Earth 110m countries: a point guaranteed to be inside the
     largest polygon
  3. IMF PortWatch's country points, for small islands Natural Earth's 110m
     map leaves out

Outputs (data/processed/):
  countries.json     ISO3 -> name, lat, lon, source of the point, Comtrade code
  countries.geojson  simplified Natural Earth outlines with ISO3

Run:  ~/.venvs/chokepoint/bin/python -I scripts/build_countries.py
"""
import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
import pyogrio

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "processed"
# Natural Earth 110m countries. This copy ships with the pyogrio package.
SHP = Path(pyogrio.__file__).parent / "tests/fixtures/naturalearth_lowres/naturalearth_lowres.shp"

# Natural Earth leaves the ISO code blank for these.
FIX_ISO = {"Norway": "NOR", "France": "FRA", "Kosovo": "XKX"}

# (lat, lon) anchors where the polygon's own point lands somewhere odd.
ANCHOR = {
    "USA": (39.0, -98.0), "CAN": (54.0, -100.0), "RUS": (56.0, 40.0), "FRA": (46.6, 2.4),
    "NOR": (61.0, 9.0), "CHN": (33.0, 108.0), "AUS": (-25.0, 134.0), "BRA": (-10.0, -52.0),
    "IDN": (-2.0, 113.0), "MYS": (4.0, 102.0), "JPN": (36.0, 138.0), "GBR": (53.0, -1.5),
    "CHL": (-33.5, -70.7), "NZL": (-42.0, 172.0),
}


def main():
    world = gpd.read_file(SHP)
    for name, iso in FIX_ISO.items():
        world.loc[world["name"] == name, "iso_a3"] = iso
    world = world[world["iso_a3"] != "-99"]

    points = {}
    for _, row in world.iterrows():
        geometry = row["geometry"]
        # For countries made of several pieces, use the biggest piece.
        if geometry.geom_type == "MultiPolygon":
            geometry = max(geometry.geoms, key=lambda g: g.area)
        point = geometry.representative_point()
        points[row["iso_a3"]] = {"name": row["name"], "lat": round(point.y, 3), "lon": round(point.x, 3), "point_source": "natural_earth"}

    for iso, (lat, lon) in ANCHOR.items():
        if iso in points:
            points[iso]["lat"] = lat
            points[iso]["lon"] = lon
            points[iso]["point_source"] = "hand_anchor"

    portwatch = pd.read_csv(ROOT / "data" / "raw" / "portwatch" / "countries.csv")
    # PortWatch's table also has aggregates (World, G7, Euro Area...). Skip those.
    portwatch = portwatch[portwatch["economy_type"] == "country"]
    for _, row in portwatch.iterrows():
        if row["ISO3"] not in points and isinstance(row["ISO3"], str):
            points[row["ISO3"]] = {"name": row["country"], "lat": round(float(row["lat"]), 3),
                                   "lon": round(float(row["lon"]), 3), "point_source": "portwatch"}

    # Attach Comtrade partner codes so trade data can be joined by ISO3.
    partners = json.loads((ROOT / "data" / "raw" / "comtrade" / "partnerAreas.json").read_text())["results"]
    for partner in partners:
        iso = partner.get("PartnerCodeIsoAlpha3")
        if iso in points and not partner.get("isGroup"):
            points[iso]["comtrade_code"] = partner["id"]
    # Comtrade calls Taiwan "Other Asia, nes" (490) and the USA 842.
    if "TWN" in points:
        points["TWN"]["comtrade_code"] = 490
    if "USA" in points:
        points["USA"]["comtrade_code"] = 842

    (OUT / "countries.json").write_text(json.dumps(points, indent=1, ensure_ascii=False))

    # Simplified outlines (about 0.1 degree) to keep the file small.
    outlines = world[["name", "iso_a3", "geometry"]].copy()
    outlines["geometry"] = outlines["geometry"].simplify(0.1, preserve_topology=True)
    outlines.to_file(OUT / "countries.geojson", driver="GeoJSON")

    sources = pd.Series([p["point_source"] for p in points.values()]).value_counts().to_dict()
    print(f"countries.json: {len(points)} countries {sources}")

    # Which trade partners still have no point?
    totals = pd.read_csv(OUT / "us_partner_totals.csv")
    recent = totals[totals["month"] >= totals["month"].max()[:4] + "-01"]
    size = recent.groupby(["partner", "iso3"])[["imports", "exports"]].sum().sum(axis=1).sort_values(ascending=False).reset_index()
    missing = size[~size["iso3"].isin(points.keys())]
    covered = 1 - missing[0].sum() / size[0].sum()
    print(f"share of US trade value with a country point: {covered:.2%}")
    print("largest partners without a point:", missing.head(8)[["partner", "iso3"]].values.tolist())


if __name__ == "__main__":
    main()

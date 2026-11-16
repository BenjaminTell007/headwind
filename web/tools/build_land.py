"""Build the globe's land dots and country outlines for the page.

Reads data/processed/countries.geojson (Natural Earth, simplified) and writes
web/data/land.json:
  dots     flat list [lat*100, lon*100, ...] for points on an even grid over
           the sphere that fall on land
  borders  list of rings, each a flat list [lon*10, lat*10, ...]
  countries   list of {name, iso} in file order
  dot_country for each dot, the index of its country in `countries` (-1 if none)
  ring_country for each border ring, the index of its country
  (the globe uses the last three to light up a country under the cursor)

Run from the repo root:
  ~/.venvs/chokepoint/bin/python -I web/tools/build_land.py
"""
import json
import math
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "data" / "processed" / "countries.geojson"
OUT = ROOT / "web" / "data" / "land.json"

N_SPHERE = 70000   # candidate points on the sphere before the land mask


def main():
    geo = json.loads(SRC.read_text())
    shapes = [shape(f["geometry"]) for f in geo["features"]]
    from shapely.ops import unary_union
    land = prep(unary_union(shapes))
    prepared = [prep(s) for s in shapes]
    bounds = [s.bounds for s in shapes]
    countries = [{"name": f["properties"].get("name", ""), "iso": f["properties"].get("iso_a3", "")} for f in geo["features"]]

    def country_of(lon, lat):
        for k, (x0, y0, x1, y1) in enumerate(bounds):
            if x0 <= lon <= x1 and y0 <= lat <= y1 and prepared[k].contains(Point(lon, lat)):
                return k
        return -1

    dots = []
    dot_country = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(N_SPHERE):
        y = 1 - 2 * (i + 0.5) / N_SPHERE
        r = math.sqrt(1 - y * y)
        a = golden * i
        lat = math.degrees(math.asin(y))
        lon = math.degrees(math.atan2(r * math.sin(a), r * math.cos(a)))
        if land.contains(Point(lon, lat)):
            dots += [round(lat * 100), round(lon * 100)]
            dot_country.append(country_of(lon, lat))

    borders = []
    ring_country = []
    for k, s in enumerate(shapes):
        polys = list(s.geoms) if s.geom_type == "MultiPolygon" else [s]
        for p in polys:
            ring = []
            for lon, lat in p.exterior.coords:
                ring += [round(lon * 10), round(lat * 10)]
            if len(ring) >= 8:
                borders.append(ring)
                ring_country.append(k)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"dots": dots, "borders": borders, "countries": countries, "dot_country": dot_country, "ring_country": ring_country}, separators=(",", ":")))
    print(f"{len(dots) // 2} land dots, {len(borders)} border rings, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()

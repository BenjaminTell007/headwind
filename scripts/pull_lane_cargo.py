"""Typical cargo on each lane, for the "likely cargo" panel.

For a lane from port A (country X) to port B (country Y), the typical cargo is
what country Y imports from country X, by HS chapter, from UN Comtrade annual
data. This is a country-level product mix, not what any one ship carries, and
it includes goods that move by air or land.

Run after pull_comtrade.py has finished (they share a rate limit):
  ~/.venvs/chokepoint/bin/python -I scripts/pull_lane_cargo.py

Writes data/raw/comtrade/lane_cargo_calls/*.json (cache) and
data/processed/lane_cargo_mix.json
"""
import json
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "comtrade"
CALLS = RAW / "lane_cargo_calls"
CALLS.mkdir(parents=True, exist_ok=True)
OUT = ROOT / "data" / "processed"

URL = "https://comtradeapi.un.org/public/v1/preview/C/A/HS"
YEARS = ["2024", "2023"]   # use 2024, fall back to 2023 if a reporter hasn't filed yet

# Port -> (country name, Comtrade code).
# Taiwan is "Other Asia, nes" (490) in Comtrade and only exists as a partner.
PORT_COUNTRY = {
    "Shanghai": ("China", 156), "Ningbo": ("China", 156), "Shenzhen": ("China", 156),
    "Busan": ("South Korea", 410), "Kaohsiung": ("Taiwan", 490), "Tokyo": ("Japan", 392),
    "Singapore": ("Singapore", 702), "Port Klang": ("Malaysia", 458),
    "Port Hedland": ("Australia", 36), "Nhava Sheva": ("India", 699), "Colombo": ("Sri Lanka", 144),
    "Jebel Ali": ("United Arab Emirates", 784), "Ras Tanura": ("Saudi Arabia", 682),
    "Durban": ("South Africa", 710), "Lagos": ("Nigeria", 566), "Piraeus": ("Greece", 300),
    "Genoa": ("Italy", 380), "Valencia": ("Spain", 724), "Rotterdam": ("Netherlands", 528),
    "Antwerp": ("Belgium", 56), "Hamburg": ("Germany", 276), "Felixstowe": ("United Kingdom", 826),
    "New York": ("United States", 842), "Savannah": ("United States", 842),
    "Houston": ("United States", 842), "Los Angeles": ("United States", 842),
    "Vancouver": ("Canada", 124), "Santos": ("Brazil", 76),
    "Constanta": ("Romania", 642), "Gdansk": ("Poland", 616),
}


def call(name, params):
    path = CALLS / f"{name}.json"
    if path.exists():
        return json.loads(path.read_text())
    for attempt in range(40):
        try:
            response = requests.get(URL, params=params, timeout=90)
        except requests.RequestException as err:
            # A dropped connection or timeout: wait a bit and try again.
            print(f"    network error ({type(err).__name__}), retrying")
            time.sleep(15)
            continue
        try:
            payload = response.json()
        except ValueError:
            payload = {"statusCode": response.status_code}
        # 429 is the per-second limit, 403 "Quota Exceeded" is a short block
        # after many calls. Both clear if I wait.
        if response.status_code in (429, 403) or payload.get("statusCode") in (429, 403):
            # The server says how long to wait in the Retry-After header.
            wait = int(response.headers.get("Retry-After", 10 + attempt * 10))
            print(f"    rate limited, waiting {wait + 5}s")
            time.sleep(wait + 5)
            continue
        response.raise_for_status()
        path.write_text(json.dumps(payload))
        time.sleep(1.5)
        return payload
    raise RuntimeError(f"gave up on {name}")


def main():
    lanes = pd.read_csv(OUT / "lane_table.csv")
    hs = pd.DataFrame(json.loads((RAW / "HS.json").read_text())["results"])
    chapter_names = hs[hs["aggrLevel"] == 2].set_index("id")["text"].str.split(" - ", n=1).str[1].to_dict()

    # Import the section mapping from build_trade so both files agree.
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from build_trade import section_for

    out = {"source": "UN Comtrade annual imports by HS chapter, reported by the destination country",
           "caveat": "Country-level product mix for the lane's two countries. Not a ship manifest, and it includes air and land trade.",
           "lanes": {}}

    for _, lane in lanes.iterrows():
        origin_name, origin_code = PORT_COUNTRY[lane["origin"]]
        dest_name, dest_code = PORT_COUNTRY[lane["destination"]]

        # Taiwan can't be a reporter. For lanes ending there I'd need mirror
        # data; none of my lanes do, so just guard against it.
        if dest_code == 490:
            print(f"  skip {lane['lane_id']}: Taiwan is not a Comtrade reporter")
            continue

        rows = []
        used_year = None
        for year in YEARS:
            params = {"reporterCode": dest_code, "partnerCode": origin_code, "period": year,
                      "flowCode": "M", "cmdCode": "AG2"}
            payload = call(f"{dest_code}_from_{origin_code}_{year}", params)
            rows = payload.get("data", [])
            if len(rows) > 0:
                used_year = year
                break

        if len(rows) == 0:
            print(f"  no data for {lane['lane_id']} ({dest_name} imports from {origin_name})")
            continue

        frame = pd.DataFrame(rows)[["cmdCode", "primaryValue"]]
        frame["cmdCode"] = frame["cmdCode"].astype(str).str.zfill(2)
        frame = frame[frame["cmdCode"].str.fullmatch(r"\d\d")]
        frame["section"] = frame["cmdCode"].apply(section_for)
        total = frame["primaryValue"].sum()

        by_section = frame.groupby("section")["primaryValue"].sum().sort_values(ascending=False)
        by_chapter = frame.sort_values("primaryValue", ascending=False).head(8)

        out["lanes"][lane["lane_id"]] = {
            "from_country": origin_name,
            "to_country": dest_name,
            "year": used_year,
            "total_usd": round(float(total)),
            "by_section": [{"section": s, "share": round(float(v / total), 4)} for s, v in by_section.items() if v > 0],
            "top_chapters": [{"hs2": r["cmdCode"], "name": chapter_names.get(r["cmdCode"], r["cmdCode"]),
                              "share": round(float(r["primaryValue"] / total), 4)} for _, r in by_chapter.iterrows()],
        }
        top = out["lanes"][lane["lane_id"]]["by_section"][0]
        print(f"  {lane['lane_id']:26s} {used_year}  {top['section']} {top['share']:.0%}")

    (OUT / "lane_cargo_mix.json").write_text(json.dumps(out))
    print(f"{len(out['lanes'])} of {len(lanes)} lanes written")


if __name__ == "__main__":
    main()

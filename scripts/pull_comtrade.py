"""Pull monthly US trade by partner and HS chapter from UN Comtrade.

The Census trade API now needs a key, so this uses Comtrade's public preview
API instead (no key, max 500 rows per call, roughly 1 call per second).

Two passes:
  1. Total US imports and exports with every partner, every month.
     Used to rank partners and for the trade-pair markets.
  2. HS chapter (2-digit) breakdown for the top partners, both directions,
     every month.
     Used for the trade bridge ribbons and the "likely cargo" panel.

Every API response is cached as its own JSON file in data/raw/comtrade/calls/,
so if the script dies (rate limits) you can rerun it and it picks up where it
stopped.

Run:  ~/.venvs/chokepoint/bin/python -I scripts/pull_comtrade.py
"""
import json
import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "comtrade"
CALLS = RAW / "calls"
CALLS.mkdir(parents=True, exist_ok=True)

URL = "https://comtradeapi.un.org/public/v1/preview/C/M/HS"
USA = 842

FIRST_MONTH = "2023-01"
LAST_MONTH = "2026-08"   # latest month Comtrade had for the US on 2026-11-14
N_TOP_PARTNERS = 20
# Always include these even if they fall outside the top 20 (tariff stories).
ALWAYS_INCLUDE = [757]   # Switzerland

# Comtrade partner codes that are aggregates, not countries.
NOT_COUNTRIES = {0, 97, 290, 472, 492, 527, 568, 577, 637, 838, 839, 849, 879, 899}


def month_list():
    months = pd.period_range(FIRST_MONTH, LAST_MONTH, freq="M")
    return [m.strftime("%Y%m") for m in months]


def call(name, params):
    """One API call, cached to disk. Retries on rate limits."""
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
        # 429 is the per-second limit, 403 "Quota Exceeded" is a short block
        # after many calls. Both clear if I wait.
        if response.status_code in (429, 403):
            # The server says how long to wait in the Retry-After header.
            wait = int(response.headers.get("Retry-After", 10 + attempt * 10))
            print(f"    rate limited, waiting {wait + 5}s")
            time.sleep(wait + 5)
            continue
        response.raise_for_status()
        payload = response.json()
        if payload.get("statusCode") == 429:
            time.sleep(2 + attempt * 2)
            continue
        if payload.get("count", 0) >= 500:
            print(f"  WARNING {name} hit the 500 row cap, data may be cut off")
        path.write_text(json.dumps(payload))
        time.sleep(1.2)
        return payload
    raise RuntimeError(f"gave up on {name} after repeated rate limits")


def to_frame(payload):
    keep = ["period", "flowCode", "partnerCode", "cmdCode", "primaryValue"]
    rows = payload.get("data", [])
    if len(rows) == 0:
        return pd.DataFrame(columns=keep)
    return pd.DataFrame(rows)[keep]


def main():
    months = month_list()

    # Pass 1: totals with every partner, one call per month and direction.
    print(f"Pass 1: totals, {len(months)} months x 2 directions")
    frames = []
    for month in months:
        for flow in ["M", "X"]:
            params = {"reporterCode": USA, "period": month, "flowCode": flow, "cmdCode": "TOTAL"}
            payload = call(f"total_{flow}_{month}", params)
            frames.append(to_frame(payload))
        print(f"  {month} done")
    totals = pd.concat(frames, ignore_index=True)
    totals = totals[~totals["partnerCode"].isin(NOT_COUNTRIES)]
    totals.to_csv(RAW / "us_totals_by_partner.csv", index=False)

    # Rank partners by total trade (imports + exports) over the last 12 months.
    last12 = months[-12:]
    recent = totals[totals["period"].astype(str).isin(last12)]
    ranking = recent.groupby("partnerCode")["primaryValue"].sum().sort_values(ascending=False)
    top = list(ranking.index[:N_TOP_PARTNERS])
    for code in ALWAYS_INCLUDE:
        if code not in top:
            top.append(code)
    print(f"  top partners: {top}")

    # Pass 2: HS chapters for the top partners, every month.
    # The preview API allows one period per call but several partners, so
    # five partners per call keeps us under the 500 row cap (~97 chapters x 5).
    print("Pass 2: HS chapters for top partners, every month")
    groups = [top[i:i + 5] for i in range(0, len(top), 5)]
    frames = []
    # Newest months first, so the last 12 (which the ribbons need) come first.
    for month in reversed(months):
        for flow in ["M", "X"]:
            for group in groups:
                params = {
                    "reporterCode": USA,
                    "partnerCode": ",".join(str(p) for p in group),
                    "period": month,
                    "flowCode": flow,
                    "cmdCode": "AG2",
                }
                payload = call(f"hs2_{month}_{flow}_{group[0]}", params)
                frames.append(to_frame(payload))
        print(f"  {month} done")
    chapters = pd.concat(frames, ignore_index=True)
    chapters.to_csv(RAW / "us_hs2_top_partners.csv", index=False)
    print(f"Done: {len(totals)} total rows, {len(chapters)} chapter rows")


if __name__ == "__main__":
    main()

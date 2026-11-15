"""Build the port, event and port-call files the page loads.

Inputs (data/raw/portwatch/, from pull_portwatch_ports.py):
  ports.csv, disruptions.csv, daily_port_calls.csv

Outputs (data/processed/):
  portwatch_ports.json   every PortWatch port, trimmed to what the globe needs
  events.json            timeline events for the replay scrubber:
                           - PortWatch's own trade disruption events
                           - a short hand-entered list of trade events, each
                             with a source and a before/after check against
                             the transit data
                           - PortWatch natural hazard events that hit ports
  port_calls_weekly.json weekly port calls by vessel type for the lane ports
  port_baselines.json    recent daily port calls per lane port (mean, median,
                         quartiles), for sizing port arrival markets

Run:  ~/.venvs/chokepoint/bin/python -I scripts/build_ports_events.py
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "portwatch"
OUT = ROOT / "data" / "processed"

# Trade events I entered by hand. `check` names a chokepoint and two windows
# (before, after) so the script can show the change in average daily transits.
HAND_EVENTS = [
    {"date": "2021-03-23", "end": "2021-03-29", "kind": "blockage", "title": "Ever Given blocks the Suez Canal",
     "where": ["Suez Canal"], "source": "widely reported; visible in PortWatch Suez counts",
     "check": ("Suez Canal", "2021-03-10", "2021-03-22", "2021-03-24", "2021-03-28")},
    {"date": "2023-11-19", "end": None, "kind": "conflict", "title": "Houthis seize the Galaxy Leader, Red Sea attacks begin",
     "where": ["Bab el-Mandeb Strait", "Suez Canal", "Cape of Good Hope"], "source": "widely reported; PortWatch dates its Red Sea disruption from 2023-12-16",
     "check": ("Bab el-Mandeb Strait", "2023-10-01", "2023-11-18", "2024-01-15", "2024-02-15")},
    {"date": "2025-04-02", "end": None, "kind": "tariff", "title": "US announces 'Liberation Day' reciprocal tariffs",
     "where": [], "source": "widely reported", "check": None},
    {"date": "2025-08-01", "end": None, "kind": "tariff", "title": "US sets a 39% tariff on Swiss goods (in force a week later)",
     "where": [], "source": "JCK, Swissinfo, Bloomberg", "check": None},
    {"date": "2025-11-14", "end": None, "kind": "tariff", "title": "US and Switzerland agree a framework cutting the tariff to 15%",
     "where": [], "source": "Bloomberg, Swissinfo, 2025-11-14", "check": None},
    {"date": "2026-02-28", "end": None, "kind": "conflict", "title": "US and Israeli strikes on Iran begin, Hormuz traffic collapses",
     "where": ["Strait of Hormuz"], "source": "Al Jazeera, MDPI study; PortWatch dates its Hormuz disruption from 2026-03-01",
     "check": ("Strait of Hormuz", "2026-02-01", "2026-02-27", "2026-03-03", "2026-03-31")},
    {"date": "2026-06-17", "end": None, "kind": "conflict", "title": "Preliminary US-Iran agreement, Hormuz partly reopens",
     "where": ["Strait of Hormuz"], "source": "Al Jazeera, 2026-07-09",
     "check": ("Strait of Hormuz", "2026-06-01", "2026-06-17", "2026-06-18", "2026-07-05")},
]

HAZARD_NAMES = {"TC": "cyclone", "EQ": "earthquake", "FL": "flood", "DR": "drought", "WF": "wildfire", "VO": "volcano"}


def clean(value):
    if pd.isna(value):
        return None
    return value


def build_ports():
    ports = pd.read_csv(RAW / "ports.csv")
    out = []
    for _, p in ports.iterrows():
        out.append({
            "id": p["portid"],
            "name": p["portname"],
            "country": p["country"],
            "iso3": clean(p["ISO3"]),
            "lat": round(float(p["lat"]), 4),
            "lon": round(float(p["lon"]), 4),
            "locode": clean(p["LOCODE"]),
            "vessels": int(p["vessel_count_total"]),
            "container": int(p["vessel_count_container"]),
            "tanker": int(p["vessel_count_tanker"]),
            "dry_bulk": int(p["vessel_count_dry_bulk"]),
            "top_industries": [x for x in [clean(p["industry_top1"]), clean(p["industry_top2"]), clean(p["industry_top3"])] if x],
        })
    out.sort(key=lambda r: -r["vessels"])
    (OUT / "portwatch_ports.json").write_text(json.dumps(out))
    print(f"portwatch_ports.json: {len(out)} ports")
    return ports


def build_events(ports):
    transits = pd.read_csv(ROOT / "data" / "raw" / "portwatch" / "daily_transits.csv", parse_dates=["date"])
    pivot = transits.pivot(index="date", columns="portname", values="n_total")
    chokepoint_names = pd.read_csv(RAW / "chokepoints.csv").set_index("portid")["portname"].to_dict()
    port_names = ports.set_index("portid")["portname"].to_dict()

    events = []

    # Hand-entered trade events, each checked against the transit data.
    for e in HAND_EVENTS:
        entry = {"date": e["date"], "end": e["end"], "kind": e["kind"], "title": e["title"],
                 "where": e["where"], "source": e["source"], "origin": "hand-entered"}
        if e["check"] is not None:
            name, a, b, c, d = e["check"]
            before = float(pivot.loc[a:b, name].mean())
            after = float(pivot.loc[c:d, name].mean())
            entry["data_check"] = {"chokepoint": name, "per_day_before": round(before, 1),
                                   "per_day_after": round(after, 1), "windows": [a, b, c, d]}
            print(f"  {e['date']} {e['title'][:48]:48s} {name}: {before:.1f} -> {after:.1f} per day")
        events.append(entry)

    # PortWatch's own events.
    raw = pd.read_csv(RAW / "disruptions.csv")
    for _, r in raw.iterrows():
        affected = []
        if isinstance(r["affectedports"], str):
            for pid in r["affectedports"].split(";"):
                pid = pid.strip()
                affected.append(chokepoint_names.get(pid) or port_names.get(pid) or pid)
        if r["eventtype"] == "OT":
            kind = "trade disruption"
        else:
            kind = HAZARD_NAMES.get(r["eventtype"], r["eventtype"])
            # Keep natural hazards only if they hit at least one port.
            if r["n_affectedports"] == 0 or len(affected) == 0:
                continue
        events.append({
            "date": r["fromdate"],
            "end": clean(r["todate"]),
            "kind": kind,
            "title": r["htmlname"],
            "where": affected,
            "country": clean(r["country"]),
            "lat": clean(r["lat"]),
            "lon": clean(r["long"]),
            "source": "IMF PortWatch disruptions database",
            "origin": "portwatch",
        })

    events.sort(key=lambda e: e["date"])
    (OUT / "events.json").write_text(json.dumps(events, indent=1))
    kinds = pd.Series([e["kind"] for e in events]).value_counts().to_dict()
    print(f"events.json: {len(events)} events {kinds}")


def build_port_calls():
    daily = pd.read_csv(RAW / "daily_port_calls.csv", parse_dates=["date"])
    types = ["portcalls_container", "portcalls_tanker", "portcalls_dry_bulk", "portcalls_general_cargo", "portcalls_roro", "portcalls"]

    weekly = daily.set_index("date").groupby("lane_port")[types + ["import", "export"]].resample("W-SUN").sum().reset_index()
    # Drop weeks that don't have all 7 days (the first and last weeks of the data).
    days = daily.set_index("date").groupby("lane_port")["portcalls"].resample("W-SUN").count().reset_index(name="days")
    weekly = weekly.merge(days, on=["lane_port", "date"])
    weekly = weekly[weekly["days"] == 7].drop(columns="days")
    weekly_out = {}
    for name, group in weekly.groupby("lane_port"):
        entry = {"week_ending": group["date"].dt.strftime("%Y-%m-%d").tolist()}
        for t in types:
            key = t.replace("portcalls_", "") if t != "portcalls" else "total"
            entry[key] = group[t].astype(int).tolist()
        entry["import_tonnes"] = group["import"].round().astype(int).tolist()
        entry["export_tonnes"] = group["export"].round().astype(int).tolist()
        weekly_out[name] = entry
    (OUT / "port_calls_weekly.json").write_text(json.dumps(weekly_out))

    # Baselines from the last 90 days of data.
    last = daily["date"].max()
    recent = daily[daily["date"] > last - pd.Timedelta(days=90)]
    baselines = {"window": [(last - pd.Timedelta(days=89)).strftime("%Y-%m-%d"), last.strftime("%Y-%m-%d")], "ports": {}}
    for name, group in recent.groupby("lane_port"):
        calls = group["portcalls"]
        baselines["ports"][name] = {
            "portid": group["portid"].iloc[0],
            "portwatch_name": group["portname"].iloc[0],
            "calls_per_day_mean": round(float(calls.mean()), 1),
            "calls_per_day_median": float(calls.median()),
            "calls_per_day_p25": float(calls.quantile(0.25)),
            "calls_per_day_p75": float(calls.quantile(0.75)),
            "container_per_day_mean": round(float(group["portcalls_container"].mean()), 1),
            "tanker_per_day_mean": round(float(group["portcalls_tanker"].mean()), 1),
        }
    (OUT / "port_baselines.json").write_text(json.dumps(baselines, indent=1))
    print(f"port_calls_weekly.json and port_baselines.json: {len(weekly_out)} ports, data to {last.date()}")


def main():
    ports = build_ports()
    build_events(ports)
    build_port_calls()


if __name__ == "__main__":
    main()

"""Turn the aisstream logs into gate counts, market thresholds, live overview
numbers and preset ship candidates.

Run after ais_logger.py has collected a few hours of data:
  ~/.venvs/chokepoint/bin/python -I scripts/summarize_live.py

Outputs (data/processed/):
  gate_crossings.csv     one row per crossing (gate, ship, time, direction)
  gate_thresholds.json   per gate: crossings per 10 minutes (mean, median,
                         quartiles), ships seen, suggested threshold, and whether
                         coverage looks good enough for a live market
  live_overview.json     ships tracked, average speed by type, share of ships
                         more than 50 nm from any route (lanes, corridors, network legs)
  preset_candidates.csv  cargo ships underway, heading to a port on one of my
                         lanes, currently close to that lane

  --selftest  build fake tracks and check the crossing logic
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
LIVE = Path(os.environ.get("HEADWAY_LIVE_DIR", ROOT / "data" / "live"))
OUT = ROOT / "data" / "processed"
GATES = ROOT / "data" / "gates.json"
LANES = OUT / "lanes.geojson"

WINDOW = "10min"           # live market length
MAX_GAP_MINUTES = 30       # don't join two positions further apart than this
MIN_SHIPS_PER_HOUR = 6     # below this a gate is too quiet or poorly covered
OFF_LANE_NM = 50

# AIS ship type codes: 70-79 cargo, 80-89 tanker.
def type_group(code):
    if pd.isna(code):
        return "unknown"
    code = int(code)
    if 70 <= code <= 79:
        return "cargo"
    if 80 <= code <= 89:
        return "tanker"
    if 60 <= code <= 69:
        return "passenger"
    return "other"


# Names and UN/LOCODEs that crews type into the destination field.
PORT_ALIASES = {
    "Rotterdam": ["ROTTERDAM", "NLRTM", "RTM"],
    "Hamburg": ["HAMBURG", "DEHAM"],
    "Antwerp": ["ANTWERP", "BEANR"],
    "Felixstowe": ["FELIXSTOWE", "GBFXT"],
    "Piraeus": ["PIRAEUS", "GRPIR"],
    "Genoa": ["GENOA", "GENOVA", "ITGOA"],
    "Valencia": ["VALENCIA", "ESVLC"],
    "Los Angeles": ["LOS ANGELES", "LONG BEACH", "USLAX", "USLGB"],
    "Vancouver": ["VANCOUVER", "CAVAN"],
    "New York": ["NEW YORK", "NEWARK", "USNYC", "USEWR"],
    "Savannah": ["SAVANNAH", "USSAV"],
    "Houston": ["HOUSTON", "USHOU"],
    "Shanghai": ["SHANGHAI", "CNSHA", "YANGSHAN"],
    "Ningbo": ["NINGBO", "CNNGB"],
    "Shenzhen": ["SHENZHEN", "YANTIAN", "CNSZX", "CNYTN"],
    "Busan": ["BUSAN", "PUSAN", "KRPUS"],
    "Singapore": ["SINGAPORE", "SGSIN"],
    "Tokyo": ["TOKYO", "YOKOHAMA", "JPTYO", "JPYOK"],
    "Nhava Sheva": ["NHAVA SHEVA", "INNSA", "JNPT"],
    "Santos": ["SANTOS", "BRSSZ"],
}


def parse_time(series):
    # aisstream times look like "2026-11-14 23:01:02.123 +0000 UTC"
    cleaned = series.astype(str).str.replace(" UTC", "", regex=False)
    return pd.to_datetime(cleaned, utc=True, errors="coerce", format="mixed")


def load(kind):
    paths = sorted(LIVE.glob(f"{kind}_*.csv"))
    if len(paths) == 0:
        return pd.DataFrame()
    frame = pd.concat([pd.read_csv(p) for p in paths], ignore_index=True)
    frame["time"] = parse_time(frame["time_utc"])
    return frame.dropna(subset=["time"])


from geometry import segments_cross  # noqa: E402  (kept importable from here too)


def find_crossings(positions, gates):
    events = []
    positions = positions.sort_values(["mmsi", "time"])
    for mmsi, track in positions.groupby("mmsi"):
        lons = track["lon"].to_numpy()
        lats = track["lat"].to_numpy()
        times = track["time"].to_numpy()
        for i in range(1, len(track)):
            gap = (times[i] - times[i - 1]) / np.timedelta64(1, "m")
            if gap > MAX_GAP_MINUTES:
                continue
            p1 = (lons[i - 1], lats[i - 1])
            p2 = (lons[i], lats[i])
            for line in gates["lines"]:
                if segments_cross(p1, p2, line["a"], line["b"]):
                    events.append({"gate": line["id"], "mmsi": mmsi, "time": times[i],
                                   "direction": "a_to_b_left" if (p2[0] - p1[0]) * (line["b"][1] - line["a"][1]) - (p2[1] - p1[1]) * (line["b"][0] - line["a"][0]) > 0 else "a_to_b_right"})
            for box in gates["boxes"]:
                inside_before = box["lon"][0] <= p1[0] <= box["lon"][1] and box["lat"][0] <= p1[1] <= box["lat"][1]
                inside_now = box["lon"][0] <= p2[0] <= box["lon"][1] and box["lat"][0] <= p2[1] <= box["lat"][1]
                if inside_now and not inside_before:
                    events.append({"gate": box["id"], "mmsi": mmsi, "time": times[i], "direction": "enter"})
    frame = pd.DataFrame(events, columns=["gate", "mmsi", "time", "direction"])
    # Make sure time is a real UTC datetime column, including when there are no crossings yet.
    frame["time"] = pd.to_datetime(frame["time"], utc=True)
    return frame


MARKET_LENGTHS = [10, 15, 30, 60]   # minutes, shortest first
MIN_MEAN_PER_MARKET = 4             # a market needs at least this many crossings on average to be worth trading


def gate_stats(crossings, positions, gates):
    # Only count 10-minute windows when the logger was actually receiving data.
    # The Mac slept for parts of the night, and empty windows from that would
    # look like quiet gates.
    per_window = positions.set_index("time").resample(WINDOW).size()
    active = per_window[per_window >= 0.25 * per_window.median()].index
    hours = len(active) * pd.Timedelta(WINDOW) / pd.Timedelta(hours=1)

    stats = {}
    all_gates = [g["id"] for g in gates["lines"]] + [g["id"] for g in gates["boxes"]]
    for gate_id in all_gates:
        events = crossings[crossings["gate"] == gate_id]
        counts = events.set_index("time").resample(WINDOW).size().reindex(active, fill_value=0)
        ships_per_hour = float(counts.sum()) / hours if hours > 0 else 0.0

        entry = {
            "hours_with_data": round(hours, 1),
            "crossings": int(counts.sum()),
            "ships_per_hour": round(ships_per_hour, 1),
        }

        # For each market length, add up consecutive active windows into
        # blocks of that length and look at the spread of counts.
        recommended = None
        for minutes in MARKET_LENGTHS:
            k = minutes // 10
            series = counts.to_numpy()
            blocks = [series[i:i + k].sum() for i in range(0, len(series) - k + 1, k)]
            if len(blocks) == 0:
                continue
            blocks = pd.Series(blocks)
            entry[f"per_{minutes}min"] = {
                "mean": round(float(blocks.mean()), 1),
                "median": float(blocks.median()),
                "p25": float(blocks.quantile(0.25)),
                "p75": float(blocks.quantile(0.75)),
            }
            if recommended is None and blocks.mean() >= MIN_MEAN_PER_MARKET:
                # "At least N crossings" with N at the median is roughly an even-odds market.
                threshold = max(1, int(round(blocks.median())))
                share_yes = float((blocks >= threshold).mean())
                recommended = {"minutes": minutes, "threshold": threshold, "historical_yes_share": round(share_yes, 2)}

        entry["recommended_market"] = recommended
        entry["usable_for_live_market"] = recommended is not None and ships_per_hour >= MIN_SHIPS_PER_HOUR
        stats[gate_id] = entry
    return stats


def lane_points(step_deg=0.25):
    # Every route I have geometry for: my hand-picked lanes, the 210 corridors
    # and the real network legs.
    features = []
    for name in ["lanes.geojson", "corridors.geojson", "corridors_alt.geojson", "network_legs.geojson"]:
        path = OUT / name
        if path.exists():
            features.extend(json.loads(path.read_text())["features"])
    pts = []
    for feature in features:
        coords = feature["geometry"]["coordinates"]
        for (x1, y1), (x2, y2) in zip(coords[:-1], coords[1:]):
            n = max(1, int(max(abs(x2 - x1), abs(y2 - y1)) / step_deg))
            for k in range(n):
                t = k / n
                pts.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    return np.array(pts)


def nm_to_nearest_lane(lons, lats, pts, chunk=2000):
    """Distance in nm from each ship to the nearest lane point (equirectangular, fine for a 50 nm cutoff)."""
    out = np.empty(len(lons))
    plon = np.radians(pts[:, 0])
    plat = np.radians(pts[:, 1])
    for s in range(0, len(lons), chunk):
        lo = np.radians(np.asarray(lons[s:s + chunk]))[:, None]
        la = np.radians(np.asarray(lats[s:s + chunk]))[:, None]
        dlon = (plon[None, :] - lo + np.pi) % (2 * np.pi) - np.pi
        x = dlon * np.cos((plat[None, :] + la) / 2)
        y = plat[None, :] - la
        out[s:s + chunk] = 3440.065 * np.sqrt(x * x + y * y).min(axis=1)
    return out


def match_port(destination):
    if not isinstance(destination, str):
        return None
    text = destination.upper()
    # Crews often write "FROM>TO" (e.g. "NL RTM>US NYC"); the destination is the last part.
    if ">" in text:
        text = text.split(">")[-1]
    squashed = text.replace(" ", "")   # "US NYC" -> "USNYC"
    for port, aliases in PORT_ALIASES.items():
        for alias in aliases:
            if alias in text or alias.replace(" ", "") in squashed:
                return port
    return None


def live_overview_and_presets(sample, static):
    latest_time = sample["time"].max()
    recent = sample[sample["time"] >= latest_time - pd.Timedelta(hours=1)]
    recent = recent.sort_values("time").groupby("mmsi").tail(1)

    ships = static.sort_values("time").groupby("mmsi").tail(1)[["mmsi", "imo", "name", "type", "destination", "eta", "draught", "length"]]
    ships = ships.rename(columns={"name": "static_name"})
    recent = recent.merge(ships, on="mmsi", how="left")
    recent["group"] = recent["type"].apply(type_group)

    underway = recent[(recent["sog"] >= 3) & (recent["sog"] < 40) & recent["group"].isin(["cargo", "tanker"])].copy()
    pts = lane_points()
    underway["nm_to_lane"] = nm_to_nearest_lane(underway["lon"].to_numpy(), underway["lat"].to_numpy(), pts)

    overview = {
        "as_of": latest_time.isoformat(),
        "ships_tracked_last_hour": int(len(recent)),
        "cargo_and_tankers_underway": int(len(underway)),
        "avg_speed_knots": {g: round(float(v), 1) for g, v in underway.groupby("group")["sog"].mean().items()},
        "share_more_than_50nm_off_lane_pct": round(100 * float((underway["nm_to_lane"] > OFF_LANE_NM).mean()), 1) if len(underway) else None,
        "method": "Latest position per ship in the last hour of the thinned sample. Underway = 3 to 40 knots. "
                  "Off lane = more than 50 nm from every route I have geometry for (lanes, corridors, network legs). Free AIS coverage is patchy offshore.",
    }

    underway["dest_port"] = underway["destination"].apply(match_port)
    candidates = underway[(underway["group"] == "cargo") & underway["dest_port"].notna() &
                          (underway["nm_to_lane"] < 100) & (underway["sog"] >= 8)]
    candidates = candidates.sort_values("length", ascending=False)
    cols = ["mmsi", "imo", "static_name", "type", "destination", "dest_port", "eta", "draught", "length", "lat", "lon", "sog", "cog", "nm_to_lane", "time"]
    return overview, candidates[cols].head(25)


def selftest():
    gates = {"lines": [{"id": "test_line", "a": [0.0, -1.0], "b": [0.0, 1.0]}],
             "boxes": [{"id": "test_box", "lon": [2.0, 3.0], "lat": [-1.0, 1.0]}]}
    t0 = pd.Timestamp("2026-11-14 12:00", tz="UTC")
    rows = []
    # Ship 1 crosses the line west to east, then enters the box.
    for k, lon in enumerate([-0.5, -0.1, 0.2, 1.0, 2.5]):
        rows.append({"mmsi": 1, "lon": lon, "lat": 0.0, "time": t0 + pd.Timedelta(minutes=5 * k)})
    # Ship 2 passes north of the line's end, should not count.
    for k, lon in enumerate([-0.5, 0.5]):
        rows.append({"mmsi": 2, "lon": lon, "lat": 2.0, "time": t0 + pd.Timedelta(minutes=5 * k)})
    # Ship 3 crosses but with a 2 hour gap, should not count.
    rows.append({"mmsi": 3, "lon": -0.5, "lat": 0.0, "time": t0})
    rows.append({"mmsi": 3, "lon": 0.5, "lat": 0.0, "time": t0 + pd.Timedelta(hours=2)})
    crossings = find_crossings(pd.DataFrame(rows), gates)
    print(crossings)
    assert list(crossings["gate"]) == ["test_line", "test_box"], "crossing logic is wrong"
    assert list(crossings["mmsi"]) == [1, 1]
    print("selftest passed")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return

    gates = json.loads(GATES.read_text())
    positions = load("gates")
    sample = load("sample")
    static = load("static")
    if len(positions) == 0 or len(sample) == 0:
        sys.exit("No logs in data/live yet. Run ais_logger.py first.")

    # Live markets count trade ships only: cargo (AIS type 70-79) and tankers
    # (80-89). Ferries and harbour craft cross the same gate all day.
    types = static.sort_values("time").groupby("mmsi")["type"].last()
    trade = set(types[types.between(70, 89)].index)
    crossings = find_crossings(positions[positions["mmsi"].isin(trade)], gates)
    # One crossing per ship per gate per hour, so a ship drifting back and
    # forth across a line at anchor counts once.
    crossings = crossings.sort_values("time")
    crossings["hour"] = crossings["time"].dt.floor("60min")
    crossings = crossings.drop_duplicates(subset=["gate", "mmsi", "hour"]).drop(columns="hour")
    crossings["vessel_group"] = crossings["mmsi"].map(types).apply(type_group)
    crossings.to_csv(OUT / "gate_crossings.csv", index=False)
    stats = gate_stats(crossings, positions, gates)
    (OUT / "gate_thresholds.json").write_text(json.dumps(stats, indent=2))

    overview, presets = live_overview_and_presets(sample, static)
    (OUT / "live_overview.json").write_text(json.dumps(overview, indent=2))
    presets.to_csv(OUT / "preset_candidates.csv", index=False)

    rows = []
    for gate_id, s in stats.items():
        rec = s["recommended_market"] or {}
        rows.append({"gate": gate_id, "hours": s["hours_with_data"], "crossings": s["crossings"],
                     "per_hour": s["ships_per_hour"], "market_min": rec.get("minutes"),
                     "threshold": rec.get("threshold"), "yes_share": rec.get("historical_yes_share"),
                     "usable": s["usable_for_live_market"]})
    table = pd.DataFrame(rows).sort_values("crossings", ascending=False)
    print(table[table["crossings"] > 0].to_string(index=False))
    print(f"{int((table['crossings'] == 0).sum())} gates had no crossings")
    print(json.dumps(overview, indent=2))
    print(f"{len(presets)} preset candidates written")


if __name__ == "__main__":
    main()

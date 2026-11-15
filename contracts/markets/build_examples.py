"""Build contracts/markets/examples.json: example markets drawn from the current ship data.

Every market says what it settles on, its threshold as the integer the contract stores,
and a starting price (prior) taken from history, so it opens near fair odds.

    python3 -I contracts/markets/build_examples.py

Reads only data/processed/ (no network). Groups:
- weekly:    total transits per strait next week (all 28 PortWatch straits)
- collapse:  "will traffic fall below its bad-week level", the hedge markets for key straits
- vessel:    one vessel type through one strait (Hormuz tankers, Suez containers, Cape containers...)
- route:     corridor transit time and efficiency, and the world index
- trade:     next unreleased month of US imports from the top partners
- live:      30 to 60 minute gate-crossing markets, opened on demand
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "processed"
OUT = Path(__file__).resolve().parent / "examples.json"

SEED_MON = 0.2  # default seed per market
FEATURED_SEED_MON = 1.0  # deeper pools for the demo markets
FEE_BPS = 100  # 1%
PRIOR_WEEKS = 12  # starting price = smoothed share of the last 12 weeks that would have settled YES

FEATURED = {
    "weekly_suez_canal", "collapse_suez_canal", "vessel_strait_of_hormuz_tanker",
    "collapse_bab_el_mandeb_strait", "live_singapore", "trade_us_imports_china",
    "route_days_east_asia__north_europe",
}

COLLAPSE_STRAITS = [
    "Suez Canal", "Bab el-Mandeb Strait", "Strait of Hormuz", "Panama Canal",
    "Malacca Strait", "Taiwan Strait", "Bosporus Strait", "Gibraltar Strait",
]
VESSEL_MARKETS = [  # (strait, PortWatch type field, words)
    ("Strait of Hormuz", "tanker", "tankers"),
    ("Suez Canal", "container", "container ships"),
    ("Suez Canal", "tanker", "tankers"),
    ("Cape of Good Hope", "container", "container ships"),
    ("Bab el-Mandeb Strait", "container", "container ships"),
    ("Panama Canal", "container", "container ships"),
    ("Malacca Strait", "tanker", "tankers"),
    ("Bosporus Strait", "tanker", "tankers"),
]
VESSEL_COLOUR = {"container": "#f08a3c", "tanker": "#8f82f2", "dry_bulk": "#46b36f",
                 "general_cargo": "#ea86b5", "roro": "#e9c84b", None: "#f2f2f2"}


def slug(text):
    return "".join(c if c.isalnum() else "_" for c in text.lower()).strip("_").replace("__", "_")


def prior_bps(hits, n):
    """Laplace-smoothed share of history that would have settled YES, clamped to 5%..95%."""
    p = (hits + 1) / (n + 2)
    return int(round(min(max(p, 0.05), 0.95) * 10_000))


def end_of_day(date_str):
    return datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc)


def nice(x):
    """Round a threshold to something a person would write."""
    if x >= 1000:
        return int(round(x, -1))
    return int(round(x))


def market(id_, group, question, series, threshold, is_above, close, prior, settles_on, why,
           threshold_display, vessel_type=None, close_minutes=None):
    base = id_.rsplit("_", 1)[0] if id_[-1].isdigit() else id_
    m = {
        "id": id_,
        "group": group,
        "question": question,
        "series": series,
        "threshold": int(threshold),
        "threshold_display": threshold_display,
        "is_above": is_above,
        "close_time": close.isoformat().replace("+00:00", "Z") if close else None,
        "close_minutes": close_minutes,
        "fee_bps": FEE_BPS,
        "prior_yes_bps": prior,
        "seed_mon": FEATURED_SEED_MON if base in FEATURED else SEED_MON,
        "featured": base in FEATURED,
        "colour": VESSEL_COLOUR[vessel_type],
        "settles_on": settles_on,
        "why": why,
    }
    return m


def main():
    seeds = json.loads((DATA / "market_seeds.json").read_text())
    weekly = json.loads((DATA / "chokepoint_weekly.json").read_text())
    gates = json.loads((DATA / "gate_thresholds.json").read_text())
    live_now = json.loads((DATA / "live_overview.json").read_text())

    out = []

    # The next week PortWatch hasn't reported: same window as market_seeds.json
    week = seeds["weekly"][0]["week"]
    close = end_of_day(seeds["weekly"][0]["closes"])  # trading stops when the week starts
    week_label = datetime.fromisoformat(week[1]).strftime("%b %-d, %Y")
    portwatch = "IMF PortWatch daily transit counts, summed Monday to Sunday"

    # --- weekly totals: thresholds from market_seeds, priors from the last 52 weeks
    for s in seeds["weekly"]:
        name = s["series"].split(":")[1]
        hist = weekly[name]["total"][-PRIOR_WEEKS:]
        hits = sum((v >= s["threshold"]) == s["is_above"] for v in hist)
        if s["threshold"] == 0:
            continue  # Kerch: zero traffic, not a market anyone would trade
        out.append(market(
            s["id"], "weekly", s["question"], s["series"], s["threshold"], s["is_above"], close,
            prior_bps(hits, len(hist)), portwatch,
            f"Met in {hits} of the last {len(hist)} weeks; last 8: {s['last_8_weeks']}",
            f"{s['threshold']} ships",
        ))

    # --- collapse: below the 10th percentile of the last 52 weeks (the hedge a shipper buys)
    for name in COLLAPSE_STRAITS:
        hist = weekly[name]["total"][-52:]
        th = nice(sorted(hist)[len(hist) // 10])
        recent = hist[-PRIOR_WEEKS:]
        hits = sum(v < th for v in recent)
        id_ = f"collapse_{slug(name)}_{week[1].replace('-', '')}"
        out.append(market(
            id_, "collapse",
            f"Will fewer than {th} ships transit the {name} in the week ending {week_label}?",
            f"portwatch:{name}:weekly_transits", th, False, close, prior_bps(hits, len(recent)),
            portwatch,
            f"10th percentile of the last {len(hist)} weeks; below it in {hits} of the last {len(recent)}. "
            f"Latest week: {hist[-1]}. YES pays if traffic collapses: a hedge for cargo routed through it.",
            f"under {th} ships",
        ))

    # --- vessel type: median of the last 8 weeks, so it opens near 50%
    for name, field, words in VESSEL_MARKETS:
        hist = weekly[name][field][-PRIOR_WEEKS:]
        th = nice(median(hist[-8:]))
        hits = sum(v >= th for v in hist)
        id_ = f"vessel_{slug(name)}_{field}_{week[1].replace('-', '')}"
        out.append(market(
            id_, "vessel",
            f"Will at least {th} {words} transit the {name} in the week ending {week_label}?",
            f"portwatch:{name}:weekly_{field}", th, True, close, prior_bps(hits, len(hist)),
            f"IMF PortWatch daily transit counts for {words}, summed Monday to Sunday",
            f"Median of the last 8 weeks; met in {hits} of the last {len(hist)}. Last 8: {hist[-8:]}",
            f"{th} {words}", vessel_type=field,
        ))

    # --- route efficiency: days and efficiency x1000 onchain
    for s in seeds["route"]:
        hist = s["last_8_weeks"]
        hits = sum((v >= s["threshold"]) == s["is_above"] for v in hist)
        days = s["series"].endswith("expected_days")
        out.append(market(
            s["id"], "route", s["question"], s["series"], round(s["threshold"] * 1000), s["is_above"],
            close, prior_bps(hits, len(hist)), s["settles_on"],
            f"Met in {hits} of the last 8 weeks: {hist}",
            f"{s['threshold']} days" if days else f"{s['threshold']} index",
        ))

    # --- trade: the next month with no data yet (October 2026, released early December)
    trade_close = datetime(2026, 12, 1, tzinfo=timezone.utc)
    for s in seeds["trade"]:
        partner = s["series"].split(":")[3]
        last3 = s["last_3_months"]
        avg = sum(last3.values()) / len(last3)
        th = round(avg / 1e8) * 1e8  # nearest $0.1B
        hits = sum(v >= th for v in last3.values())
        out.append(market(
            f"trade_us_imports_{slug(partner)}_202610", "trade",
            f"Will US imports from {partner} be at least ${th / 1e9:.1f}B in October 2026?",
            s["series"], th, True, trade_close, prior_bps(hits, len(last3)),
            "US-reported monthly imports (Census, released early December)",
            "Threshold is the average of the last 3 months: "
            + ", ".join(f"{k} ${v / 1e9:.1f}B" for k, v in last3.items()),
            f"${th / 1e9:.1f}B",
        ))

    # --- live gates: use the logger's tuned thresholds; close time is set when the keeper opens them
    for gate_id, g in gates.items():
        rec = g.get("recommended_market")
        if not g.get("usable_for_live_market") or not rec:
            continue
        name = gate_id.replace("_", " ").title().replace("Singapore Port", "Port of Singapore approach")
        out.append(market(
            f"live_{gate_id}", "live",
            f"Will at least {rec['threshold']} cargo ships and tankers cross the {name} gate "
            f"in the next {rec['minutes']} minutes?",
            f"gate:{gate_id}:{rec['minutes']}min", rec["threshold"], True, None,
            prior_bps(round(rec["historical_yes_share"] * 100), 100),
            "Gate crossings counted by the server from the live aisstream feed (/api/gates/{id}/count)",
            f"{g['ships_per_hour']} ships an hour over {g['hours_with_data']} logged hours; "
            f"YES in {rec['historical_yes_share']:.0%} of past windows",
            f"{rec['threshold']} ships", close_minutes=rec["minutes"],
        ))

    doc = {
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "data_through": seeds["data_through"],
        "live_snapshot": {k: live_now[k] for k in ("as_of", "ships_tracked_last_hour",
                                                   "cargo_and_tankers_underway", "avg_speed_knots")},
        "scaling": "threshold is the onchain integer: route days and efficiency x1000, dollars whole, counts as is",
        "total_seed_mon": round(sum(m["seed_mon"] for m in out), 2),
        "markets": out,
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    groups = {}
    for m in out:
        groups[m["group"]] = groups.get(m["group"], 0) + 1
    print(f"{len(out)} markets {groups}, seed total {doc['total_seed_mon']} MON -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

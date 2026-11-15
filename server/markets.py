"""Market list for the page: /api/markets and /api/markets/{id}.

Joins the market definitions in data/processed/market_seeds.json with what's
onchain. Until the contracts are deployed and the keeper is running, the
`chain` block of every market is empty (nulls) and the response shape is
otherwise final, so the page can be built against it now.

Things the keeper will use from here:
  - to_onchain(series, value)      the one place numbers are scaled to integers
  - live_window(minutes, now)      the clock-aligned window a live market covers
  - set_chain(key, **fields)       record a market's onchain id, pools, outcome
  - chain_key(market)              the registry key for a market (live: per window)

Replay seeds carry the real outcome (`actual`, `outcome`). Those stay on the
server: the API never sends them before the market is resolved onchain, so
the answer can't leak to the page ahead of the demo.
"""
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

ROOT = Path(__file__).resolve().parent.parent
SEEDS_FILE = ROOT / "data" / "processed" / "market_seeds.json"

GROUPS = ("live", "weekly", "route", "trade", "replay")

# Route and trade seeds don't carry a close time. Route markets cover the same
# week as the weekly ones (which close 2026-11-16), and trade markets settle on
# data released weeks from now, so both stop taking positions at the same time.
FORWARD_CLOSE = datetime(2026, 11, 16, tzinfo=timezone.utc)

COUNT_CACHE_SECONDS = 10

# Set by app.py to its gate_count function, so live markets can show the count
# so far without importing app.py (which would be a circular import).
gate_counter = None

router = APIRouter()


# ---------- scaling: the one place numbers become onchain integers ----------

def unit_and_scale(series):
    """(unit, multiplier) for a series string. PLAN.md: days and efficiency
    times 1000, dollars in whole dollars, counts as they are."""
    kind = series.split(":")[-1]
    if series.startswith("gate:") or kind == "weekly_transits":
        return "ships", 1
    if kind == "expected_days":
        return "days", 1000
    if kind in ("efficiency", "index"):
        return "efficiency", 1000
    if series.startswith("comtrade:"):
        return "USD", 1
    raise ValueError(f"unknown series kind: {series}")


def to_onchain(series, value):
    _, scale = unit_and_scale(series)
    return int(round(value * scale))


# ---------- time ----------

def live_window(minutes, now=None):
    """The window a live market covers right now, lined up with the clock:
    30-minute markets open at :00 and :30, 60-minute markets on the hour.
    The server, the keeper and the page's countdown all agree this way, even
    after a restart."""
    now = now or datetime.now(timezone.utc)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = int((now - midnight).total_seconds() // 60)
    opens = midnight + timedelta(minutes=elapsed - elapsed % minutes)
    return opens, opens + timedelta(minutes=minutes)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z") if dt else None


# ---------- seeds ----------

_seeds = {"mtime": None, "by_id": {}}
_seeds_lock = threading.Lock()


def seeds():
    """id -> (group, seed). Reloaded when the file changes."""
    with _seeds_lock:
        mtime = SEEDS_FILE.stat().st_mtime
        if mtime != _seeds["mtime"]:
            data = json.loads(SEEDS_FILE.read_text())
            by_id = {}
            for group in GROUPS:
                for seed in data.get(group, []):
                    by_id[seed["id"]] = (group, seed)
            _seeds.update(mtime=mtime, by_id=by_id)
        return _seeds["by_id"]


def seed_series(group, seed):
    if group == "live":
        return f"gate:{seed['gate']}:{seed['minutes']}min"
    return seed["series"]


# ---------- onchain registry (filled by the keeper) ----------

_chain = {}
_chain_lock = threading.Lock()

EMPTY_CHAIN = {"market_id": None, "yes_pool": None, "no_pool": None, "odds_yes": None,
               "resolved": False, "outcome_yes": None, "value": None}


def chain_key(market_id, opens_at=None):
    """Registry key. Live markets get one onchain market per window."""
    return f"{market_id}@{iso(opens_at)}" if opens_at else market_id


def set_chain(key, **fields):
    """Keeper calls this after createMarket / on PositionTaken / after resolve."""
    with _chain_lock:
        entry = _chain.setdefault(key, dict(EMPTY_CHAIN))
        entry.update(fields)
        yes, no = entry.get("yes_pool"), entry.get("no_pool")
        if yes is not None and no is not None and yes + no > 0:
            entry["odds_yes"] = yes / (yes + no)


def get_chain(key):
    with _chain_lock:
        return dict(_chain.get(key, EMPTY_CHAIN))


# ---------- live counts ----------

_counts = {}
_counts_lock = threading.Lock()


def count_so_far(gate, opens_at):
    """Cargo ships and tankers across the gate since the window opened.
    Cached briefly so a page polling every few seconds doesn't recount."""
    if gate_counter is None:
        return None
    key = (gate, opens_at)
    now = time.monotonic()
    with _counts_lock:
        hit = _counts.get(key)
        if hit and now - hit[0] < COUNT_CACHE_SECONDS:
            return hit[1]
    try:
        count = gate_counter(gate, since=opens_at.isoformat())["count"]
    except Exception as err:  # a bad count shouldn't take down the market list
        print("gate count error:", gate, err)
        return None
    with _counts_lock:
        _counts[key] = (now, count)
        for k in [k for k in _counts if k[1] < opens_at - timedelta(hours=3)]:
            del _counts[k]  # forget old windows
    return count


# ---------- building one market ----------

def history_for(group, seed):
    if group == "live":
        return {"historical_yes_share": seed.get("historical_yes_share"),
                "ships_per_hour": seed.get("ships_per_hour")}
    if group == "weekly":
        return {"last_8_weeks": seed.get("last_8_weeks"), "week": seed.get("week")}
    if group == "route":
        return {"last_8_weeks": seed.get("last_8_weeks"), "normal_days": seed.get("normal_days"),
                "efficiency_now": seed.get("efficiency_now")}
    if group == "trade":
        return {"last_3_months": seed.get("last_3_months")}
    if group == "replay":
        return {"normal_days": seed.get("normal_days")}  # never `actual` or `outcome`
    return {}


def build(market_id, group, seed, now):
    series = seed_series(group, seed)
    unit, _ = unit_and_scale(series)
    out = {
        "id": market_id,
        "group": group,
        "question": seed["question"],
        "series": series,
        "threshold": seed["threshold"],
        "threshold_onchain": to_onchain(series, seed["threshold"]),
        "unit": unit,
        "is_above": seed["is_above"],
        "opens_at": None,
        "closes_at": None,
        "status": None,
        "settles_on": seed.get("settles_on"),
        "history": history_for(group, seed),
        "live": None,
        "story": seed.get("story"),
    }

    opens = None
    if group == "live":
        opens, closes = live_window(seed["minutes"], now)
        out.update(opens_at=iso(opens), closes_at=iso(closes), status="open",
                   live={"gate": seed["gate"], "minutes": seed["minutes"],
                         "count_so_far": count_so_far(seed["gate"], opens)})
    elif group == "replay":
        out["status"] = "replay"  # the keeper gives it a real close time when it opens one
    else:
        closes = (datetime.fromisoformat(seed["closes"]).replace(tzinfo=timezone.utc)
                  if seed.get("closes") else FORWARD_CLOSE)
        out.update(closes_at=iso(closes), status="open" if now < closes else "closed")

    chain = get_chain(chain_key(market_id, opens))
    out["chain"] = chain
    if chain["resolved"]:
        out["status"] = "resolved"
    elif chain.get("closes_at"):  # keeper-set close time (replay markets)
        out["closes_at"] = chain["closes_at"]
        out["status"] = "open" if now < datetime.fromisoformat(chain["closes_at"].replace("Z", "+00:00")) else "closed"
    return out


# ---------- routes ----------

@router.get("/api/markets")
def list_markets(
    group: str | None = Query(None, description="live, weekly, route, trade or replay"),
    status: str | None = Query(None, description="open, closed, resolved or replay"),
):
    if group and group not in GROUPS:
        raise HTTPException(400, f"group must be one of {', '.join(GROUPS)}")
    now = datetime.now(timezone.utc)
    out = []
    for market_id, (g, seed) in seeds().items():
        if group and g != group:
            continue
        market = build(market_id, g, seed, now)
        if status and market["status"] != status:
            continue
        out.append(market)
    return {"now": iso(now), "count": len(out), "markets": out}


@router.get("/api/markets/{market_id}")
def one_market(market_id: str):
    found = seeds().get(market_id)
    if found is None:
        raise HTTPException(404, f"no market {market_id}")
    return build(market_id, *found, datetime.now(timezone.utc))

"""Market list for the page: /api/markets and /api/markets/{id}.

The list is Xavi's contracts/markets/examples.json (the markets the keeper opens),
matched to what's actually onchain, plus every ship-arrival market opened from the
page. The chain is the source of truth: markets are found by reading the contract,
not from the keeper's memory, so this works on any server that has the deployments
file, keeper or not.

Each market carries the fields the page already reads (web/js/main.js): id, group,
question, series, threshold, closes, gate, minutes, probYes, chainId,
historical_yes_share. `chainId` is the onchain market to trade, or null if it isn't
open yet. `probYes` is the live price when it's onchain, else the starting prior.

Live gate markets: trading closes when the window starts, so a live card has two
onchain markets in play. `chainId` is the one taking positions now (the NEXT window);
`live.counting` is the window whose ships are crossing right now; `live.last` is the
latest settled window.

Thresholds are the onchain integers from examples.json, never rescaled here
(CHAIN_SERVER.md item 3). `threshold_display` is the readable version.
"""
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from server.chain import chain

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "contracts" / "markets" / "examples.json"
WEI = 10**18
OPEN, YES, NO, INVALID = 0, 1, 2, 3
OUTCOME_NAME = {OPEN: None, YES: "YES", NO: "NO", INVALID: "INVALID"}
REFRESH_SECONDS = 8          # how stale onchain prices may be
COUNT_CACHE_SECONDS = 10

# Set by app.py to its gate_count function.
gate_counter = None

router = APIRouter()


# ---------- helpers the keeper uses ----------

def live_window(minutes, now=None):
    """The clock-aligned window covering `now`: 30-minute windows start at :00 and :30,
    60-minute windows on the hour."""
    now = now or datetime.now(timezone.utc)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = int((now - midnight).total_seconds() // 60)
    opens = midnight + timedelta(minutes=elapsed - elapsed % minutes)
    return opens, opens + timedelta(minutes=minutes)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def chain_key(market_id, opens_at=None):
    """The keeper's name for a market: the example id, plus the window start for live ones."""
    return f"{market_id}@{iso(opens_at)}" if opens_at else market_id


def set_chain(key, **fields):
    """Kept for the keeper; the list now reads the chain directly, so nothing to do."""


def ts(unix):
    return datetime.fromtimestamp(int(unix), timezone.utc)


# ---------- examples ----------

_examples = {"mtime": None, "list": []}


def examples():
    mtime = EXAMPLES.stat().st_mtime
    if mtime != _examples["mtime"]:
        _examples.update(mtime=mtime, list=json.loads(EXAMPLES.read_text())["markets"])
    return _examples["list"]


# ---------- what's onchain ----------

class OnchainIndex:
    """Every market on the contract, refreshed every few seconds. Settled markets never
    change, so they're read once and kept."""

    def __init__(self):
        self.lock = threading.Lock()
        self.markets = {}        # id -> market dict
        self.final = set()       # ids that are resolved and vault-settled
        self.updated = 0.0
        self.error = None

    def get(self):
        """The latest read. Requests never wait on the chain once the background thread
        has done its first pass."""
        if not self.updated:
            self._refresh()
        with self.lock:
            return dict(self.markets)

    def refresh_forever(self):
        while True:
            self._refresh()
            time.sleep(REFRESH_SECONDS)

    def _refresh(self):
        if not chain.ready():
            self.error = chain.why_off
            self.updated = time.monotonic()
            return
        try:
            count = chain.markets.functions.marketCount().call()
            fresh = {}
            for mid in range(count):
                if mid in self.final:
                    continue
                m = chain.get_market(mid)
                m["id"] = mid
                fresh[mid] = m
            with self.lock:
                self.markets.update(fresh)
                for mid, m in fresh.items():
                    if m["outcome"] != OPEN and m["vaultSettled"]:
                        self.final.add(mid)
            self.error = None
        except Exception as err:  # keep serving the last good read
            self.error = str(err)[:200]
        self.updated = time.monotonic()


def start():
    threading.Thread(target=index.refresh_forever, daemon=True).start()


index = OnchainIndex()


def chain_block(m):
    """The onchain part of a market card."""
    if m is None:
        return None
    pool = m["yesReserve"] + m["noReserve"]
    return {
        "market_id": m["id"],
        "price_yes": m["priceYes"] / WEI,
        "yes_reserve_mon": m["yesReserve"] / WEI,
        "no_reserve_mon": m["noReserve"] / WEI,
        "pool_mon": pool / WEI,
        "collateral_mon": m["collateral"] / WEI,
        "max_collateral_mon": m["maxCollateral"] / WEI,
        "fee_bps": m["feeBps"],
        "close": iso(ts(m["closeTime"])),
        "resolve_by": iso(ts(m["resolveBy"])),
        "outcome": OUTCOME_NAME[m["outcome"]],
        "value": m["value"] if m["outcome"] != OPEN else None,
        "vault_settled": m["vaultSettled"],
    }


def status_of(m, now):
    if m is None:
        return "not_open"
    if m["outcome"] != OPEN:
        return "resolved"
    return "open" if now < ts(m["closeTime"]) else "closed"


# ---------- live counts ----------

_counts = {}
_counts_lock = threading.Lock()


def count_between(gate, start, end):
    """Cargo ships and tankers across the gate in [start, end), cached briefly."""
    if gate_counter is None:
        return None
    key = (gate, start, end)
    now = time.monotonic()
    with _counts_lock:
        hit = _counts.get(key)
        if hit and now - hit[0] < COUNT_CACHE_SECONDS:
            return hit[1]
    try:
        count = gate_counter(gate, since=start.isoformat(), until=end.isoformat())["count"]
    except Exception as err:
        print("gate count error:", gate, err)
        return None
    with _counts_lock:
        _counts[key] = (now, count)
        for k in [k for k in _counts if now - _counts[k][0] > 600]:
            del _counts[k]
    return count


# ---------- building the list ----------

def base(ex):
    return {
        "id": ex["id"],
        "group": ex["group"],
        "question": ex["question"],
        "series": ex["series"],
        "threshold": ex["threshold"],
        "threshold_display": ex.get("threshold_display"),
        "is_above": ex["is_above"],
        "featured": ex.get("featured", False),
        "settles_on": ex.get("settles_on"),
        "why": ex.get("why"),
        "prior_yes": ex["prior_yes_bps"] / 10_000,
    }


def build_fixed(ex, onchain, now):
    """A weekly, collapse, vessel, route or trade market: one onchain market at most."""
    match = [m for m in onchain if m["series"] == ex["series"] and m["threshold"] == ex["threshold"]
             and m["isAbove"] == ex["is_above"]]
    m = max(match, key=lambda x: x["id"]) if match else None
    out = base(ex)
    out.update(
        closes=iso(ts(m["closeTime"])) if m else ex.get("close_time"),
        status=status_of(m, now),
        chainId=m["id"] if m and status_of(m, now) == "open" else None,
        probYes=m["priceYes"] / WEI if m else out["prior_yes"],
        chain=chain_block(m),
    )
    return out


def build_live(ex, onchain, now):
    """A live gate: the window taking positions, the window being counted, the last result."""
    gate = ex["series"].split(":")[1]
    minutes = ex["close_minutes"]
    mine = sorted((m for m in onchain if m["series"] == ex["series"]), key=lambda m: m["closeTime"])
    trading = next((m for m in mine if m["outcome"] == OPEN and ts(m["closeTime"]) > now), None)
    counting = next((m for m in mine if m["outcome"] == OPEN and ts(m["closeTime"]) <= now
                     < ts(m["closeTime"]) + timedelta(minutes=minutes)), None)
    done = [m for m in mine if m["outcome"] != OPEN]
    last = done[-1] if done else None

    def window(m):
        start = ts(m["closeTime"])
        return start, start + timedelta(minutes=minutes)

    out = base(ex)
    out.update(
        gate=gate,
        minutes=minutes,
        historical_yes_share=out["prior_yes"],
        question=trading["question"] if trading else ex["question"],
        closes=iso(ts(trading["closeTime"])) if trading else None,
        status="open" if trading else "not_open",
        chainId=trading["id"] if trading else None,
        probYes=trading["priceYes"] / WEI if trading else out["prior_yes"],
        chain=chain_block(trading),
        live={
            "trading": None if not trading else {
                "market_id": trading["id"], "window_start": iso(window(trading)[0]),
                "window_end": iso(window(trading)[1]), "trading_closes": iso(window(trading)[0])},
            "counting": None if not counting else {
                "market_id": counting["id"], "question": counting["question"],
                "window_start": iso(window(counting)[0]), "window_end": iso(window(counting)[1]),
                "count_so_far": count_between(gate, *window(counting)), "threshold": ex["threshold"],
                "price_yes_at_close": counting["priceYes"] / WEI},
            "last": None if not last else {
                "market_id": last["id"], "question": last["question"],
                "window_start": iso(window(last)[0]), "window_end": iso(window(last)[1]),
                "count": last["value"] if last["outcome"] != INVALID else None,
                "outcome": OUTCOME_NAME[last["outcome"]]},
        },
    )
    return out


def build_arrival(m, now):
    """A ship-arrival hedge opened from the page. Not in examples.json, so built from the chain."""
    _, ship, port = m["series"].split(":")
    return {
        "id": f"arrival_{m['id']}",
        "group": "arrival",
        "question": m["question"],
        "series": m["series"],
        "threshold": m["threshold"],
        "threshold_display": f"deadline {iso(ts(m['threshold']))}",
        "is_above": m["isAbove"],
        "featured": False,
        "settles_on": "AIS position at the port (contracts/pricing/arrival.py)",
        "why": None,
        "prior_yes": None,
        "ship": ship,
        "port": port,
        "deadline": iso(ts(m["threshold"])),
        "closes": iso(ts(m["closeTime"])),
        "status": status_of(m, now),
        "chainId": m["id"] if status_of(m, now) == "open" else None,
        "probYes": m["priceYes"] / WEI,
        "chain": chain_block(m),
    }


def all_markets():
    now = datetime.now(timezone.utc)
    onchain = list(index.get().values())
    out = []
    for ex in examples():
        out.append(build_live(ex, onchain, now) if ex["group"] == "live" else build_fixed(ex, onchain, now))
    for m in onchain:
        if m["series"].startswith("arrival:"):
            out.append(build_arrival(m, now))
    return now, out


# ---------- routes ----------

@router.get("/api/markets")
def list_markets(
    group: str | None = Query(None, description="live, weekly, collapse, vessel, route, trade or arrival"),
    status: str | None = Query(None, description="open, closed, resolved or not_open"),
    onchain: bool = Query(False, description="only markets that exist onchain"),
):
    now, markets = all_markets()
    if group:
        markets = [m for m in markets if m["group"] == group]
    if status:
        markets = [m for m in markets if m["status"] == status]
    if onchain:
        markets = [m for m in markets if m["chain"] is not None or (m.get("live") or {}).get("counting")]
    # Featured and tradable first, so the page's first cards are the ones people can use.
    markets.sort(key=lambda m: (m["chainId"] is None, not m["featured"]))
    return {"now": iso(now), "count": len(markets), "chain_error": index.error, "markets": markets}


@router.get("/api/markets/{market_id}")
def one_market(market_id: str):
    _, markets = all_markets()
    found = next((m for m in markets if m["id"] == market_id), None)
    if found is None:
        raise HTTPException(404, f"no market {market_id}")
    return found

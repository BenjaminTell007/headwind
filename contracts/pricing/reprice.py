"""Keep market prices current: re-run the model on fresh data and trade toward it.

Trading is what moves an FPMM's price, so on its own a market only reacts to people. This module
lets a market-making bot (the server's keeper) re-price open markets as the world changes:
  - the ship moves, slows down or speeds up (fresh AIS position and speed)
  - it passes a strait, which then drops out of the forecast
  - the weather where it is now changes
  - ships pile up at, or clear out of, the destination port (live queue, PortQueue below)
  - time passes: less distance left means less uncertainty, so the odds firm up toward 0 or 1
and when the model's probability has moved further from the market price than the fees,
it buys the cheap side through the normal Markets.buy, capped per step and per market.

Everything here is pure math or reads data; sending the transaction is the keeper's job:

    from contracts.pricing import reprice
    plan = reprice.plan_for_market(market, now=now, ship_lookup=..., queue=port_queue,
                                   spent_wei=spent_so_far[id])
    if plan:  chain.send(markets.functions.buy(id, plan["yes"], plan["min_shares"]), value=plan["amount_wei"])

`market` is the dict from chain.get_market(id) (yesReserve, noReserve, feeBps, series, threshold,
closeTime, outcome). Only `arrival:` markets are re-priced live for now; the strait, route and trade
markets close before their period starts, so there's no new information while they trade.

Math (fixed-product pool, y YES and n NO, k = y n, price p = n / (y + n)):
buying YES with x (after fee) makes n' = n + x and y' = k / n', so p' = n'^2 / (k + n'^2).
To reach a target p':  n' = sqrt(k p' / (1 - p')),  x = n' - n.   Buying NO is the mirror:
y' = sqrt(k (1 - p') / p'),  x = y' - y.  Gross amount sent = x / (1 - fee).
"""

import math
import sys
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import model  # noqa: E402

WEI = 10**18

# Policy for the bot. Conservative: it nudges prices, it doesn't make them.
BAND = 0.03                 # act only if |model - market| > fee + BAND
MAX_STEP_MON = 0.05         # most it spends on one market per run
MAX_PER_MARKET_MON = 0.30   # most it ever puts into one market
MIN_TRADE_MON = 0.002       # skip dust trades (gas costs ~0.007 MON)
P_MIN, P_MAX = 0.02, 0.98   # never push a price to certainty; settlement does that
STEP_TOWARD = 0.5           # each run moves the price this fraction of the way to the model, so one
                            # noisy reading (AIS speed jumps 10-15%) can't swing a market; a lasting
                            # change still gets there over a few runs


def trade_to(y, n, fee_bps, p_target):
    """Exact trade that moves the pool price to p_target. Returns (buy_yes, gross_wei) or None.
    y, n are the pool's YES and NO reserves in wei."""
    p_target = min(max(p_target, P_MIN), P_MAX)
    k = y * n
    p_now = n / (y + n)
    if abs(p_target - p_now) < 1e-9:
        return None
    if p_target > p_now:   # YES too cheap: buy YES, which adds to n
        x = math.isqrt(int(k * p_target / (1 - p_target))) - n
        yes = True
    else:                  # YES too dear: buy NO, which adds to y
        x = math.isqrt(int(k * (1 - p_target) / p_target)) - y
        yes = False
    if x <= 0:
        return None
    gross = -(-x * 10_000 // (10_000 - fee_bps))   # ceil(x / (1 - fee))
    return yes, gross


def price_after(y, n, fee_bps, yes, gross):
    """Pool price after a buy of `gross` wei, the same integer math as Markets._buy."""
    x = gross - gross * fee_bps // 10_000
    k = y * n
    if yes:
        n1 = n + x
        y1 = -(-k // n1)
    else:
        y1 = y + x
        n1 = -(-k // y1)
    return n1 / (y1 + n1), (y + x - y1) if yes else (n + x - n1)


# Each ship's recent speed reports, kept for as long as the keeper process runs. AIS speed jumps
# 10-15% report to report, so the model uses the median of the last 90 minutes instead of the
# latest value. Module-level so the keeper gets it without any change on its side.
SPEED_WINDOW = timedelta(minutes=90)
_speeds = {}   # ship id -> deque[(time, sog)]


def smoothed_ship(ship, now):
    """The ship with `sog` replaced by its median over the last 90 minutes (moving reports only)."""
    sid = str(ship.get("imo") or ship.get("mmsi"))
    try:
        sog = float(ship.get("sog"))
    except (TypeError, ValueError):
        return ship
    h = _speeds.setdefault(sid, deque())
    h.append((now, sog))
    while h and now - h[0][0] > SPEED_WINDOW:
        h.popleft()
    moving = sorted(s for _, s in h if s >= 3)
    if sog < 3 or not moving:   # stopped or slowing for port: use what it's doing now
        return ship
    return dict(ship, sog=moving[len(moving) // 2], sog_latest=sog, sog_reports=len(moving))


class PortQueue:
    """Ships stopped at a port now vs the last few hours, from the server's live ship memory.
    A ratio above 1 means the port is backing up. Keep one instance alive in the keeper."""

    def __init__(self, window=timedelta(hours=6)):
        self.window = window
        self.history = {}   # port name -> deque[(time, count)]

    @staticmethod
    def count_stopped(port, ships):
        inside = model.gc_nm
        plat, plon = float(port["lat"]), float(port["lon"])
        return sum(1 for s in ships
                   if s.get("lat") is not None and float(s.get("sog") or 0) < 1.0
                   and inside(float(s["lat"]), float(s["lon"]), plat, plon) <= 12.0)

    def factor(self, port, ships, now):
        c = self.count_stopped(port, ships)
        h = self.history.setdefault(port["name"], deque())
        h.append((now, c))
        while h and now - h[0][0] > self.window:
            h.popleft()
        past = sorted(x for _, x in h)
        ref = past[len(past) // 2] if past else c
        return (c / ref) if ref else 1.0


def ships_near(port, ships_lookup):
    """Live ships around a port from the server: ships_lookup(bbox) -> list of ship dicts."""
    lat, lon = float(port["lat"]), float(port["lon"])
    d = 0.25
    return ships_lookup(f"{lon - d},{lat - d},{lon + d},{lat + d}")


def fair_probability(market, now=None, ship_lookup=None, ships_lookup=None, queue=None):
    """The model's P(YES) for an open market with today's data, or None if this kind isn't re-priced.
    Returns (p, why) where why is the model's working for logs and the page."""
    now = now or datetime.now(timezone.utc)
    series = market["series"]
    if not series.startswith("arrival:"):
        return None
    _, ship_id, port_code = series.split(":")
    ship = (ship_lookup or model.fetch_ship)(ship_id)
    if not ship or "lat" not in ship:
        return None
    ship = smoothed_ship(ship, now)
    port = model.find_port(port_code)
    deadline = datetime.fromtimestamp(int(market["threshold"]), tz=timezone.utc)
    qf = 1.0
    if queue is not None and ships_lookup is not None:
        try:
            qf = queue.factor(port, ships_near(port, ships_lookup), now)
        except Exception:
            qf = 1.0
    priced = model.price_arrival(ship, port, deadline, now=now, queue_factor=qf)
    if priced["already_arrived"] and now < deadline:
        return None   # the keeper settles it NO; don't trade on it
    priced["inputs"]["queue_factor"] = round(qf, 2)
    return priced["p_yes"], priced


def plan_for_market(market, now=None, ship_lookup=None, ships_lookup=None, queue=None, spent_wei=0):
    """What the bot should buy on one market now, or None. `spent_wei`: what it has put in so far."""
    now = now or datetime.now(timezone.utc)
    if int(market.get("outcome", 0)) != 0 or now.timestamp() >= int(market["closeTime"]) - 60:
        return None
    fp = fair_probability(market, now, ship_lookup, ships_lookup, queue)
    if fp is None:
        return None
    p_model, why = fp
    y, n, fee = int(market["yesReserve"]), int(market["noReserve"]), int(market["feeBps"])
    p_now = n / (y + n)
    if abs(p_model - p_now) <= fee / 10_000 + BAND:
        return None
    t = trade_to(y, n, fee, p_now + STEP_TOWARD * (p_model - p_now))
    if not t:
        return None
    yes, gross = t
    budget = min(int(MAX_STEP_MON * WEI), int(MAX_PER_MARKET_MON * WEI) - int(spent_wei))
    gross = min(gross, budget)
    if gross < MIN_TRADE_MON * WEI:
        return None
    p_after, shares = price_after(y, n, fee, yes, gross)
    return {
        "yes": yes,
        "amount_wei": gross,
        "min_shares": shares * 97 // 100,   # 3% slippage guard
        "p_market": round(p_now, 4),
        "p_model": round(p_model, 4),
        "p_after": round(p_after, 4),
        "why": why,
    }

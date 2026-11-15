"""The keeper: opens the demo markets, then settles them. CHAIN_SERVER.md items 2, 4 and 5.

Every CYCLE_SECONDS it:
  1. Opens each chosen market from contracts/markets/examples.json once (Xavi's priors and
     terms via pricing.quote.example_quote, signed with the server key).
  2. Live gate markets: keeps the NEXT clock-aligned window's market open for trading while
     the current window runs. Trading closes when the window starts, so people take positions
     first and then watch the ships cross. When a window ends, it counts the gate between the
     window's start and end, resolves, and calls settleVault.
  3. Arrival markets opened from the page: tracks each ship's positions and settles with
     Xavi's pricing.arrival.settle, then settleVault.
Weekly, route and trade markets settle on data released after the demo, so the keeper
leaves them open; anyone can call them invalid after resolveBy.

Only one keeper may run per deployment (two would open duplicates and clash on nonces),
so it starts only where HEADWAY_KEEPER=1. Set that on Railway, not on laptops.
  KEEPER_GROUPS   which examples to open: "featured" (default), "all", or groups
                  like "featured,live" (weekly, collapse, vessel, route, trade, live)

What it has opened is saved in keeper_state.json next to the ship logs (the Railway
volume), so a restart doesn't open anything twice.
"""
import json
import os
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

from contracts.pricing import quote as pricing  # noqa: F401  (puts contracts/pricing on sys.path)
import arrival as arrival_rule  # noqa: E402  (Xavi's contracts/pricing/arrival.py)
import model as pricing_model  # noqa: E402

from server import markets as market_list
from server.chain import chain, setting

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "contracts" / "markets" / "examples.json"
CYCLE_SECONDS = 20
LIVE_SETTLE_DELAY = timedelta(seconds=90)   # let the logger write the window's last positions
OPEN_LEAD_MIN = timedelta(minutes=2)        # don't open a window that starts in under 2 minutes
RETRY_AFTER = timedelta(minutes=2)          # after a failed open, wait this long before trying again
LIVE_RESOLVE_GRACE = timedelta(hours=2)     # resolveBy for live markets, past the window end

# Set by app.py.
gate_counter = None     # gate_count(gate_id, since=..., until=...)
ship_lookup = None      # find_ship(query) -> ship dict with mmsi, lat, lon, sog, nav_status, time
live_dir = None         # where keeper_state.json goes


def now_utc():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def parse(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


class Keeper:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"opened": {}}      # key -> {market_id, close, window_end, resolved, settled, ...}
        self.failed = {}                 # key -> last failure time (not saved)
        self.tracks = {}                 # mmsi -> positions seen, for arrival markets (not saved)
        self.log = []                    # recent actions, for /api/keeper
        self.running = False
        self.last_cycle = None

    # ---------- state ----------

    def _path(self):
        return Path(live_dir or ROOT / "data" / "live") / "keeper_state.json"

    def load(self):
        p = self._path()
        if p.exists():
            self.state = json.loads(p.read_text())
            # A state file from another deployment would point at the wrong markets.
            if chain.ready() and self.state.get("markets") not in (None, chain.markets.address):
                self.note(f"state file is for {self.state.get('markets')}, starting fresh")
                self.state = {"opened": {}}

    def save(self):
        p = self._path()
        p.parent.mkdir(parents=True, exist_ok=True)
        self.state["markets"] = chain.markets.address if chain.ready() else None
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=1))
        tmp.replace(p)

    def note(self, text):
        line = f"{now_utc():%H:%M:%S} {text}"
        print("keeper:", text)
        self.log = (self.log + [line])[-60:]

    # ---------- which markets ----------

    def chosen(self):
        groups = set(setting("KEEPER_GROUPS", "featured").split(","))
        examples = json.loads(EXAMPLES.read_text())["markets"]
        return [m for m in examples
                if "all" in groups or m["group"] in groups or ("featured" in groups and m.get("featured"))]

    # ---------- opening ----------

    def _open(self, key, m, now, close=None, window=None):
        """Sign and send createMarket for one example. Returns True if it opened."""
        last_fail = self.failed.get(key)
        if last_fail and now - last_fail < RETRY_AFTER:
            return False
        try:
            q = chain.quote_from_json(pricing.example_quote(m, now=now)["quote"])
            if window:  # live: trading runs until the window starts, settles after it ends
                start, end = window
                q["closeTime"] = int(start.timestamp())
                q["resolveBy"] = int((end + LIVE_RESOLVE_GRACE).timestamp())
                q["question"] = live_question(m, start, end)
            market_id = chain.create_market(q)
        except Exception as err:
            self.failed[key] = now
            self.note(f"open {key} failed: {err}")
            return False
        self.state["opened"][key] = {
            "example": m["id"], "group": m["group"], "series": m["series"], "market_id": market_id,
            "close": iso(datetime.fromtimestamp(q["closeTime"], timezone.utc)),
            "window_start": iso(window[0]) if window else None,
            "window_end": iso(window[1]) if window else None,
            "resolved": False, "settled": False, "opened_at": iso(now),
        }
        self.save()
        market_list.set_chain(key, market_id=market_id, closes_at=self.state["opened"][key]["close"])
        self.note(f"opened #{market_id} {key}")
        return True

    def open_markets(self, now):
        for m in self.chosen():
            if m["group"] == "live":
                minutes = m["close_minutes"]
                _, current_end = market_list.live_window(minutes, now)
                start, end = current_end, current_end + timedelta(minutes=minutes)
                if start - now < OPEN_LEAD_MIN:  # too close to the start to be worth trading
                    continue
                key = market_list.chain_key(m["id"], start)
                if key not in self.state["opened"]:
                    self._open(key, m, now, window=(start, end))
            else:
                if m["id"] in self.state["opened"]:
                    continue
                if parse(m["close_time"]) <= now + timedelta(minutes=5):
                    continue  # already closed or about to
                self._open(m["id"], m, now)

    # ---------- settling ----------

    def _finish(self, key, entry, how, value=None):
        """Resolve (or call invalid), then settleVault. Each step is saved, so a crash halfway
        picks up where it stopped."""
        mid = entry["market_id"]
        if not entry["resolved"]:
            if how == "invalid":
                chain.resolve_invalid(mid)
            else:
                chain.resolve(mid, value)
            entry["resolved"] = True
            entry["value"] = value
            self.save()
            outcome = "INVALID" if how == "invalid" else value
            self.note(f"resolved #{mid} {key}: {outcome}")
        if not entry["settled"]:
            chain.settle_vault(mid)
            entry["settled"] = True
            self.save()
            self.note(f"settleVault #{mid}")
        m = chain.get_market(mid)
        market_list.set_chain(key, resolved=True, outcome_yes=m["outcome"] == 1, value=m["value"])

    def settle_live(self, now):
        for key, e in list(self.state["opened"].items()):
            if e["group"] != "live" or e["settled"]:
                continue
            end = parse(e["window_end"])
            if now < end + LIVE_SETTLE_DELAY:
                continue
            gate = e["series"].split(":")[1]
            try:
                count = None if e["resolved"] else gate_counter(gate, since=e["window_start"].replace("Z", "+00:00"),
                                                                until=e["window_end"].replace("Z", "+00:00"))["count"]
                self._finish(key, e, "resolve", count)
            except Exception as err:
                self.note(f"settle {key} failed: {err}")

    def settle_arrivals(self, now):
        """Arrival markets come from the page, so find them onchain."""
        try:
            count = chain.markets.functions.marketCount().call()
        except Exception as err:
            self.note(f"marketCount failed: {err}")
            return
        known = {e["market_id"] for e in self.state["opened"].values()}
        arrivals = self.state.setdefault("arrivals", {})  # market id -> {resolved, settled}
        for mid in range(count):
            if mid in known or arrivals.get(str(mid), {}).get("settled"):
                continue
            try:
                m = chain.get_market(mid)
            except Exception:
                continue
            if not m["series"].startswith("arrival:"):
                continue
            entry = arrivals.setdefault(str(mid), {"market_id": mid, "resolved": m["outcome"] != 0, "settled": False})
            try:
                _, ship_id, port_code = m["series"].split(":")
                ship = ship_lookup(ship_id)
                self.tracks.setdefault(ship["mmsi"], {})[ship["time"]] = ship  # one point per report
                deadline = datetime.fromtimestamp(m["threshold"], timezone.utc)
                if not entry["resolved"]:
                    port = pricing_model.find_port(port_code)
                    positions = list(self.tracks[ship["mmsi"]].values())
                    how, value = arrival_rule.settle(positions, arrival_rule.port_area(port), deadline, now)
                    if how == "wait":
                        continue
                    self._finish(f"arrival#{mid}", entry, how, value)
                else:
                    self._finish(f"arrival#{mid}", entry, "resolve")
            except Exception as err:
                # A ship we can't see: after the deadline + 6 h, call it invalid so money isn't stuck.
                if not entry["resolved"] and now > datetime.fromtimestamp(m["threshold"], timezone.utc) + arrival_rule.SILENT:
                    try:
                        self._finish(f"arrival#{mid}", entry, "invalid")
                    except Exception as err2:
                        self.note(f"arrival #{mid} invalid failed: {err2}")
                elif "no ship matching" not in str(err):
                    self.note(f"arrival #{mid}: {err}")
            self.save()

    # ---------- loop ----------

    def cycle(self):
        now = now_utc()
        with self.lock:
            self.open_markets(now)
            self.settle_live(now)
            self.settle_arrivals(now)
            self.last_cycle = iso(now)

    def run_forever(self):
        if not chain.ready():
            print("keeper: chain not set up, not starting:", chain.why_off)
            return
        self.load()
        for key, e in self.state["opened"].items():  # tell /api/markets what's already onchain
            market_list.set_chain(key, market_id=e["market_id"], closes_at=e["close"], resolved=e["resolved"])
        self.running = True
        self.note(f"started: markets {chain.markets.address}, groups {setting('KEEPER_GROUPS', 'featured')}")
        while True:
            try:
                self.cycle()
            except Exception:
                traceback.print_exc()
            time.sleep(CYCLE_SECONDS)

    def status(self):
        with self.lock:
            return {"running": self.running, "last_cycle": self.last_cycle,
                    "opened": self.state["opened"], "arrivals": self.state.get("arrivals", {}),
                    "log": self.log[-20:]}


def live_question(m, start, end):
    """'... in the next 30 minutes?' -> '... between 20:00 and 20:30 UTC?' (trading closes at 20:00)."""
    q = m["question"]
    for phrase in (f"in the next {m['close_minutes']} minutes", "in the next hour"):
        if phrase in q:
            return q.replace(phrase, f"between {start:%H:%M} and {end:%H:%M} UTC")
    return q.rstrip("?") + f" ({start:%H:%M} to {end:%H:%M} UTC)?"


keeper = Keeper()


def start():
    if os.environ.get("HEADWAY_KEEPER") == "1":
        threading.Thread(target=keeper.run_forever, daemon=True).start()
    else:
        print("keeper: off (set HEADWAY_KEEPER=1 on the one server that should run it)")

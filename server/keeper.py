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
import math
import os
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

from contracts.pricing import quote as pricing  # noqa: F401  (puts contracts/pricing on sys.path)
import arrival as arrival_rule  # noqa: E402  (Xavi's contracts/pricing/arrival.py)
import model as pricing_model  # noqa: E402
from contracts.pricing import reprice  # noqa: E402  (Xavi's market-making step, CHAIN_SERVER.md item 7)

from server import markets as market_list
from server.chain import chain, setting

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "contracts" / "markets" / "examples.json"
CYCLE_SECONDS = 20
LIVE_SETTLE_DELAY = timedelta(seconds=90)   # let the logger write the window's last positions
OPEN_LEAD_MIN = timedelta(minutes=2)        # don't open a window that starts in under 2 minutes
RETRY_AFTER = timedelta(minutes=2)          # after a failed open, wait this long before trying again
LIVE_RESOLVE_GRACE = timedelta(hours=2)     # resolveBy for live markets, past the window end
# Re-pricing bot (arrival markets only). Xavi's reprice.py caps each step at 0.05 MON and each
# market at 0.30 MON; these caps protect the gas the keeper itself needs from the same key.
REPRICE_EVERY = timedelta(minutes=3)
REPRICE_TOTAL_MON = float(os.environ.get("KEEPER_REPRICE_BUDGET_MON", "1.0"))  # all markets together
REPRICE_KEEP_MON = 1.0                      # never trade if the server key would drop below this
# Demo round: a short gate market started by hand (POST /api/demo/start), so a full
# bet -> count -> settle loop fits on stage whenever the slot starts.
DEMO_BET_SECONDS = 120                      # betting open this long
DEMO_COUNT_SECONDS = 180                    # then real ships are counted this long
DEMO_SETTLE_DELAY = timedelta(seconds=25)   # logger flushes every 5 s, the server reads every 3 s
DEMO_SEED_MON = 0.5                         # a thin pool, so each bet visibly moves the odds
DEMO_FALLBACK_RATE = 20.0                   # trade ships an hour, if the last hour's count is unusable
DEMO_TICK_SECONDS = 5                       # how often a due demo round is checked between cycles

# Set by app.py.
gate_counter = None     # gate_count(gate_id, since=..., until=...)
ship_lookup = None      # find_ship(query) -> ship dict with mmsi, lat, lon, sog, nav_status, time
ships_in_bbox = None    # ships_in_bbox("minLon,minLat,maxLon,maxLat") -> list of ship dicts
live_dir = None         # where keeper_state.json goes


def now_utc():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def parse(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


class DemoBusy(Exception):
    """A demo round is already running."""


class Keeper:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"opened": {}}      # key -> {market_id, close, window_end, resolved, settled, ...}
        self.failed = {}                 # key -> last failure time (not saved)
        self.tracks = {}                 # mmsi -> positions seen, for arrival markets (not saved)
        self.log = []                    # recent actions, for /api/keeper
        self.running = False
        self.last_cycle = None
        self.open_arrivals = {}          # market id -> latest getMarket, for the re-pricing bot
        self.last_reprice = None
        self.port_queue = reprice.PortQueue()  # remembers each port's recent queue

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

    # ---------- retiring markets the page no longer lists ----------

    def retire_orphans(self, now):
        """Markets the keeper opened from an example that is no longer in examples.json (the
        Nov 16 strait and route markets, re-issued with _c17 ids so they close after the demo).
        The page doesn't list them, so their vault seed would sit idle until resolveBy, two weeks
        out. If nobody traded in one (its collateral and LP are still exactly the vault's seed),
        call it invalid and settleVault: the vault gets its seed back in full and no trader is
        affected. A market someone traded in is kept and settles the normal way."""
        ids = {m["id"] for m in json.loads(EXAMPLES.read_text())["markets"]}
        for key, e in list(self.state["opened"].items()):
            if e["group"] == "live" or e["settled"] or e.get("kept"):
                continue
            if e.get("example", key) in ids:
                continue
            mid = e["market_id"]
            try:
                m = chain.get_market(mid)
                if m["vaultSettled"]:           # done already (by anyone): just record it
                    e["resolved"] = e["settled"] = True
                    self.save()
                    continue
                if m["outcome"] != 0:           # resolved already: only settleVault is left
                    e["resolved"] = True
                elif m["collateral"] != m["vaultSeed"] or m["lpSupply"] != m["vaultSeed"]:
                    e["kept"] = True
                    self.save()
                    self.note(f"#{mid} {key} is no longer listed but has trades: left to settle normally")
                    continue
                self._finish(key, e, "invalid")
                self.note(f"retired #{mid} {key}: no trades, seed back in the vault")
            except Exception as err:
                self.note(f"retire #{mid} {key} failed: {err}")

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
        self.open_arrivals.pop(mid, None)
        self.redeem_bot(mid)

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
            if m["outcome"] == 0:
                m["id"] = mid
                self.open_arrivals[mid] = m
            else:
                self.open_arrivals.pop(mid, None)
            try:
                _, ship_id, port_code = m["series"].split(":")
                ship = ship_lookup(ship_id)
                self.tracks.setdefault(ship["mmsi"], {})[ship["time"]] = ship  # one point per report
                deadline = datetime.fromtimestamp(m["threshold"], timezone.utc)
                if not entry["resolved"]:
                    port = find_port_code(port_code)
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

    # ---------- demo round ----------

    def demo_rounds(self):
        return self.state.setdefault("demo", {})

    def start_demo(self, gate="singapore", bet_seconds=DEMO_BET_SECONDS, count_seconds=DEMO_COUNT_SECONDS,
                   threshold=None):
        """Open one short gate market now. Betting runs for bet_seconds, then cargo ships and
        tankers crossing the gate are counted for count_seconds, then it settles. One at a time."""
        if not self.running:
            raise RuntimeError("the keeper isn't running on this server (HEADWAY_KEEPER=1 and the chain set up)")
        with self.lock:
            active = [e for e in self.demo_rounds().values() if not e["settled"]]
            if active:
                raise DemoBusy(active[0])
            # How busy is the gate right now? Sets the fair starting odds, and the threshold
            # if none was given (the one closest to a coin flip).
            try:
                rate = float(gate_counter(gate, minutes=60)["count"])
            except Exception:
                rate = 0.0
            if rate < 3:
                rate = DEMO_FALLBACK_RATE
            lam = rate * count_seconds / 3600
            at_least = lambda k: 1 - sum(math.exp(-lam) * lam**i / math.factorial(i) for i in range(k))
            if threshold is None:
                threshold = min(range(1, int(lam * 2) + 3), key=lambda k: abs(at_least(k) - 0.5))
            prior = at_least(threshold)

            now = now_utc()
            close = now + timedelta(seconds=bet_seconds)
            close = close.replace(microsecond=0) + timedelta(seconds=(-close.second) % 10)  # tidy :00, :10, ...
            end = close + timedelta(seconds=count_seconds)
            name = gate.replace("_", " ").title()
            ships = "cargo ship or tanker" if threshold == 1 else "cargo ships and tankers"
            question = (f"Demo round: will at least {threshold} {ships} cross the {name} gate "
                        f"between {close:%H:%M:%S} and {end:%H:%M:%S} UTC?")
            series = f"gate:{gate}:demo{count_seconds}s"
            q = pricing.build("live", question, series, f"gate:{gate}", threshold, True, close, prior, now=now)
            q["seed"] = int(DEMO_SEED_MON * 10**18)
            q["resolveBy"] = int((end + LIVE_RESOLVE_GRACE).timestamp())
            market_id = chain.create_market(chain.quote_from_json(q))
            entry = {
                "market_id": market_id, "gate": gate, "threshold": threshold, "question": question,
                "series": series, "prior_yes": round(prior, 4), "ships_per_hour": round(rate, 1),
                "opened_at": iso(now), "bet_closes": iso(close), "count_start": iso(close), "count_end": iso(end),
                "resolved": False, "settled": False,
            }
            self.demo_rounds()[str(market_id)] = entry
            self.save()
            self.note(f"demo round #{market_id}: at least {threshold} at {gate}, betting to {close:%H:%M:%S}, "
                      f"counting to {end:%H:%M:%S}")
            return dict(entry)

    def settle_demo(self, now):
        for mid, e in list(self.demo_rounds().items()):
            if e["settled"] or now < parse(e["count_end"]) + DEMO_SETTLE_DELAY:
                continue
            try:
                count = None if e["resolved"] else gate_counter(
                    e["gate"], since=e["count_start"].replace("Z", "+00:00"),
                    until=e["count_end"].replace("Z", "+00:00"))["count"]
                self._finish(f"demo#{mid}", e, "resolve", count)
            except Exception as err:
                self.note(f"settle demo #{mid} failed: {err}")

    def demo_tick(self):
        """Between full cycles, settle a demo round the moment it's due."""
        now = now_utc()
        if any(not e["settled"] and now >= parse(e["count_end"]) + DEMO_SETTLE_DELAY
               for e in self.state.get("demo", {}).values()):
            with self.lock:
                self.settle_demo(now)

    def demo_status(self):
        """The latest demo round with its phase, for /api/demo and the start page."""
        rounds = self.state.get("demo", {})
        if not rounds:
            return None
        e = dict(rounds[max(rounds, key=int)])
        now = now_utc()
        start, end = parse(e["count_start"]), parse(e["count_end"])
        e["phase"] = ("settled" if e["settled"] else "betting" if now < start else "counting" if now < end
                      else "settling")
        if e["phase"] in ("counting", "settling") and gate_counter is not None:
            try:
                e["count_so_far"] = gate_counter(e["gate"], since=e["count_start"].replace("Z", "+00:00"),
                                                 until=e["count_end"].replace("Z", "+00:00"))["count"]
            except Exception:
                e["count_so_far"] = None
        if e["settled"] and e.get("value") is not None:
            e["outcome"] = "YES" if e["value"] >= e["threshold"] else "NO"
        e["now"] = iso(now)
        return e

    # ---------- re-pricing bot ----------

    def _bot(self, mid):
        return self.state.setdefault("bot", {}).setdefault(str(mid), {"spent": 0, "redeemed": False})

    def reprice_arrivals(self, now):
        """Every few minutes, trade open arrival markets toward Xavi's model on fresh data."""
        if self.last_reprice and now - self.last_reprice < REPRICE_EVERY:
            return
        self.last_reprice = now
        spent_total = sum(b["spent"] for b in self.state.get("bot", {}).values())
        for mid, m in list(self.open_arrivals.items()):
            bot = self._bot(mid)
            try:
                plan = reprice.plan_for_market(m, now=now, ship_lookup=_ship_or_empty,
                                               ships_lookup=ships_in_bbox, queue=self.port_queue,
                                               spent_wei=bot["spent"])
            except Exception as err:
                self.note(f"reprice #{mid}: {err}")
                continue
            if not plan:
                continue
            amount = plan["amount_wei"]
            if (spent_total + amount) / 1e18 > REPRICE_TOTAL_MON:
                self.note(f"reprice #{mid}: total budget {REPRICE_TOTAL_MON} MON used, skipping")
                return
            balance = chain.w3.eth.get_balance(chain.account.address)
            if (balance - amount) / 1e18 < REPRICE_KEEP_MON:
                self.note(f"reprice #{mid}: server key low ({balance / 1e18:.2f} MON), skipping")
                return
            try:
                chain.send(chain.markets.functions.buy(mid, plan["yes"], plan["min_shares"]), value=amount)
            except Exception as err:
                self.note(f"reprice #{mid} buy failed: {err}")
                continue
            bot["spent"] += amount
            spent_total += amount
            self.save()
            side = "YES" if plan["yes"] else "NO"
            self.note(f"reprice #{mid}: bought {side} {amount / 1e18:.3f} MON, "
                      f"{plan['p_market']} -> {plan['p_after']} (model {plan['p_model']})")

    def redeem_bot(self, mid):
        """After a market the bot traded settles, cash in its shares."""
        bot = self.state.get("bot", {}).get(str(mid))
        if not bot or not bot["spent"] or bot["redeemed"]:
            return
        try:
            chain.send(chain.markets.functions.redeem(mid))
            self.note(f"bot redeemed #{mid}")
        except Exception as err:
            if "NothingToPay" not in str(err):  # the bot was on the losing side
                self.note(f"bot redeem #{mid} failed: {err}")
                return
        bot["redeemed"] = True
        self.save()

    # ---------- loop ----------

    def cycle(self):
        now = now_utc()
        with self.lock:
            self.retire_orphans(now)   # first, so the freed seed is there for new markets
            self.open_markets(now)
            self.settle_live(now)
            self.settle_demo(now)
            self.settle_arrivals(now)
            self.reprice_arrivals(now)
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
            for _ in range(CYCLE_SECONDS // DEMO_TICK_SECONDS):
                time.sleep(DEMO_TICK_SECONDS)
                try:
                    self.demo_tick()
                except Exception:
                    traceback.print_exc()

    def status(self):
        with self.lock:
            return {"running": self.running, "last_cycle": self.last_cycle,
                    "opened": self.state["opened"], "arrivals": self.state.get("arrivals", {}),
                    "bot": self.state.get("bot", {}), "demo": self.state.get("demo", {}),
                    "log": self.log[-20:]}


_find_port = pricing_model.find_port


def find_port_code(code):
    """The port in an arrival series. Ports without a UN LOCODE go in as their id in capitals
    ("PORT815" for New York-New Jersey), which find_port doesn't read back, so try the id too."""
    try:
        return _find_port(code)
    except KeyError:
        by_id = {p["id"].upper(): p for p in pricing_model.ports().values()}
        if code.upper() in by_id:
            return by_id[code.upper()]
        raise


# Every pricing call (the quote, reprice.py, the arrival rule) goes through model.find_port, so
# give them all the fallback.
pricing_model.find_port = find_port_code


def _ship_or_empty(query):
    try:
        return ship_lookup(str(query))
    except Exception:
        return {}


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

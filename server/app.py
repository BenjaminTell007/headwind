"""Headway server.

What it does now:
  - serves everything in data/processed/ and data/gates.json at /data/...
  - follows the ship logger's CSV files (data/live/) and keeps the latest
    position of every ship in memory
  - /api/ships         latest positions, filterable by area, vessel type, age
  - /api/ship/{query}  look up one ship by MMSI, IMO or name ("find your ship")
  - /api/gates/{id}/count   live crossings of a gate in the last N minutes,
                            which is what resolves a live market

What's still to build (see PLAN.md):
  - /api/faucet        relayer sends test MON to new burner wallets
  - market resolver    calls resolve() on the contract when a market closes

The ship logger (scripts/ais_logger.py) runs separately and writes the CSVs this
server reads. The server never talks to aisstream itself, so the API key stays
in one place.

Run from the repo root:
  ~/.venvs/chokepoint/bin/python -m uvicorn server.app:app --port 8787 --reload

On Railway the same command runs with RUN_LOGGER=1, so the server also starts
the ship logger and keeps it running (see railway.json).
"""
import csv
import io
import json
import os
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
LIVE = Path(os.environ.get("HEADWAY_LIVE_DIR", ROOT / "data" / "live"))
PROCESSED = ROOT / "data" / "processed"
GATES_FILE = ROOT / "data" / "gates.json"

# Same crossing test the summary script uses, so live counts match the
# thresholds it set.
sys.path.insert(0, str(ROOT / "scripts"))
from geometry import segments_cross  # noqa: E402

POLL_SECONDS = 3
STARTED_AT = datetime.now(timezone.utc).isoformat(timespec="seconds")
START_BYTES = 12_000_000      # on start-up, read this much of the end of each log file
GATE_MEMORY_HOURS = 2         # keep this much gate-area history for live counts


def type_group(code):
    try:
        code = int(float(code))
    except (TypeError, ValueError):
        return "unknown"
    if 70 <= code <= 79:
        return "cargo"
    if 80 <= code <= 89:
        return "tanker"
    if 60 <= code <= 69:
        return "passenger"
    return "other"


def parse_time(text):
    # Logger times look like "2026-11-15 16:16:01.675397174 +0000 UTC".
    text = text.replace(" UTC", "").strip()
    date_part, _, rest = text.partition(" ")
    clock = rest.split(" ")[0]
    if "." in clock:
        whole, frac = clock.split(".")
        clock = f"{whole}.{frac[:6]}"
    try:
        return datetime.fromisoformat(f"{date_part}T{clock}+00:00")
    except ValueError:
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            return None


class Tailer:
    """Reads new lines from a growing CSV file."""

    def __init__(self, path):
        self.path = path
        self.header = None
        self.offset = 0
        self.buffer = ""
        self._try_header(first=True)

    def _try_header(self, first=False):
        """Read the header line once it's fully written. On a fresh server the
        logger creates its files a moment before it flushes the header, so this
        may take a few polls."""
        with open(self.path, "r", newline="") as f:
            line = f.readline()
            if not line.endswith("\n"):
                return False
            self.header = next(csv.reader([line]))
            if first:
                # Existing file: skip to the last START_BYTES so start-up is quick.
                header_end = f.tell()
                size = self.path.stat().st_size
                start = max(header_end, size - START_BYTES)
                f.seek(start)
                if start > header_end:
                    f.readline()  # skip the partial line we landed in
            self.offset = f.tell()
        return True

    def read_new(self):
        rows = []
        if self.header is None and not self._try_header():
            return rows
        with open(self.path, "r", newline="") as f:
            f.seek(self.offset)
            chunk = f.read()
            self.offset = f.tell()
        if not chunk:
            return rows
        text = self.buffer + chunk
        lines = text.split("\n")
        self.buffer = lines.pop()  # last piece may be half written
        for row in csv.reader(io.StringIO("\n".join(lines))):
            if len(row) == len(self.header):
                rows.append(dict(zip(self.header, row)))
        return rows


class ShipState:
    def __init__(self):
        self.lock = threading.Lock()
        self.latest = {}            # mmsi -> latest position dict
        self.static = {}            # mmsi -> static info dict
        self.gate_positions = deque()  # recent positions near gates, for live counts
        self.tailers = {}
        self.last_poll = None

    def _tailers_for(self, kind):
        for path in sorted(LIVE.glob(f"{kind}_*.csv")):
            if path not in self.tailers:
                self.tailers[path] = Tailer(path)
            yield self.tailers[path]

    def poll(self):
        new_static = {}
        for tailer in self._tailers_for("static"):
            for row in tailer.read_new():
                new_static[row["mmsi"]] = row

        new_positions = []
        new_gate = []
        for kind, target in [("sample", new_positions), ("gates", new_gate)]:
            for tailer in self._tailers_for(kind):
                for row in tailer.read_new():
                    when = parse_time(row["time_utc"])
                    if when is None:
                        continue
                    try:
                        target.append({
                            "mmsi": row["mmsi"], "name": row["name"], "time": when,
                            "lat": float(row["lat"]), "lon": float(row["lon"]),
                            "sog": float(row["sog"]) if row["sog"] else None,
                            "cog": float(row["cog"]) if row["cog"] else None,
                            "nav_status": row.get("nav_status", ""),  # arrival rule: 1 anchored, 5 moored
                        })
                    except ValueError:
                        continue

        cutoff = datetime.now(timezone.utc) - timedelta(hours=GATE_MEMORY_HOURS)
        with self.lock:
            self.static.update(new_static)
            for p in new_positions + new_gate:
                old = self.latest.get(p["mmsi"])
                if old is None or p["time"] >= old["time"]:
                    self.latest[p["mmsi"]] = p
            self.gate_positions.extend(new_gate)
            while self.gate_positions and self.gate_positions[0]["time"] < cutoff:
                self.gate_positions.popleft()
            self.last_poll = datetime.now(timezone.utc)

    def describe(self, p):
        s = self.static.get(p["mmsi"], {})
        return {
            "mmsi": p["mmsi"],
            "name": p["name"] or s.get("name", ""),
            "imo": s.get("imo"),
            "type": s.get("type"),
            "type_group": type_group(s.get("type")),
            "destination": s.get("destination"),
            "eta": s.get("eta"),
            "draught": s.get("draught"),
            "length": s.get("length"),
            "lat": p["lat"], "lon": p["lon"], "sog": p["sog"], "cog": p["cog"],
            "nav_status": p.get("nav_status"),
            "time": p["time"].isoformat(),
        }


state = ShipState()


def poll_forever():
    while True:
        try:
            if LIVE.exists():
                state.poll()
        except Exception as err:  # keep polling even if one read fails
            print("poll error:", err)
        time.sleep(POLL_SECONDS)


def run_logger_forever():
    """Run scripts/ais_logger.py as a child process and restart it if it ever exits.
    Used on Railway, where one start command has to run both the logger and the server."""
    while True:
        print("starting ship logger")
        child = subprocess.Popen([sys.executable, "-u", str(ROOT / "scripts" / "ais_logger.py")], cwd=ROOT)
        child.wait()
        print(f"ship logger exited with code {child.returncode}, restarting in 10s")
        time.sleep(10)


@asynccontextmanager
async def lifespan(app):
    # RUN_LOGGER=1 (set on Railway) makes the server start the ship logger too.
    # On a laptop that already runs the logger, leave it unset.
    if os.environ.get("RUN_LOGGER") == "1":
        if os.environ.get("AISSTREAM_API_KEY"):
            threading.Thread(target=run_logger_forever, daemon=True).start()
        else:
            print("RUN_LOGGER=1 but AISSTREAM_API_KEY is not set, so no live ships")
    threading.Thread(target=poll_forever, daemon=True).start()
    keeper_module.start()  # only where HEADWAY_KEEPER=1
    markets.start()  # keeps onchain prices for /api/markets fresh in the background
    yield


app = FastAPI(title="Headway", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
def health():
    with state.lock:
        return {
            # Railway sets this to the commit it deployed, so anyone can check
            # which version is live. Empty when running on a laptop.
            "commit": os.environ.get("RAILWAY_GIT_COMMIT_SHA", "")[:7] or "local",
            "started": STARTED_AT,
            "ships_in_memory": len(state.latest),
            "gate_positions_in_memory": len(state.gate_positions),
            "last_poll": state.last_poll.isoformat() if state.last_poll else None,
            "logger_files": sorted(p.name for p in LIVE.glob("*.csv")) if LIVE.exists() else [],
        }


@app.get("/api/ships")
def ships(
    max_age_minutes: int = Query(60, ge=1, le=1440),
    bbox: str | None = Query(None, description="min_lon,min_lat,max_lon,max_lat"),
    types: str | None = Query(None, description="comma list: cargo,tanker,passenger,other,unknown"),
    moving_only: bool = False,
    limit: int = Query(5000, ge=1, le=50000),
):
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)
    box = [float(v) for v in bbox.split(",")] if bbox else None
    wanted = set(types.split(",")) if types else None
    out = []
    with state.lock:
        for p in state.latest.values():
            if p["time"] < cutoff:
                continue
            if box and not (box[0] <= p["lon"] <= box[2] and box[1] <= p["lat"] <= box[3]):
                continue
            if moving_only and (p["sog"] is None or p["sog"] < 3):
                continue
            item = state.describe(p)
            if wanted and item["type_group"] not in wanted:
                continue
            out.append(item)
            if len(out) >= limit:
                break
    return {"count": len(out), "ships": out}


@app.get("/api/ship/{query}")
def find_ship(query: str):
    q = query.strip().upper()
    with state.lock:
        for mmsi, p in state.latest.items():
            s = state.static.get(mmsi, {})
            if q in (mmsi, str(s.get("imo", "")).split(".")[0]) or q == (p["name"] or s.get("name", "")).upper():
                return state.describe(p)
        # Fall back to a partial name match.
        for mmsi, p in state.latest.items():
            name = (p["name"] or state.static.get(mmsi, {}).get("name", "")).upper()
            if q and q in name:
                return state.describe(p)
    raise HTTPException(404, f"no ship matching {query}")


@app.get("/api/gates/{gate_id}/count")
def gate_count(gate_id: str, minutes: int = Query(30, ge=1, le=120), since: str | None = None,
               until: str | None = None):
    """Cargo ships and tankers that crossed the gate in the window.
    `since` (ISO time) overrides `minutes`, so a market can count from its open time."""
    gates = json.loads(GATES_FILE.read_text())
    line = next((g for g in gates["lines"] if g["id"] == gate_id), None)
    box = next((g for g in gates["boxes"] if g["id"] == gate_id), None)
    if line is None and box is None:
        raise HTTPException(404, f"no gate {gate_id}")

    start = datetime.fromisoformat(since) if since else datetime.now(timezone.utc) - timedelta(minutes=minutes)
    end = datetime.fromisoformat(until) if until else None  # a closed market window counts only up to its end
    with state.lock:
        trade = {m for m, s in state.static.items() if type_group(s.get("type")) in ("cargo", "tanker")}
        tracks = {}
        for p in state.gate_positions:
            if p["mmsi"] in trade:
                tracks.setdefault(p["mmsi"], []).append(p)

    crossed = {}
    for mmsi, track in tracks.items():
        track.sort(key=lambda p: p["time"])
        for a, b in zip(track[:-1], track[1:]):
            if b["time"] < start or (end and b["time"] >= end) or (b["time"] - a["time"]) > timedelta(minutes=30):
                continue
            p1, p2 = (a["lon"], a["lat"]), (b["lon"], b["lat"])
            if line is not None:
                hit = segments_cross(p1, p2, line["a"], line["b"])
            else:
                inside = lambda p: box["lon"][0] <= p[0] <= box["lon"][1] and box["lat"][0] <= p[1] <= box["lat"][1]
                hit = inside(p2) and not inside(p1)
            if hit and mmsi not in crossed:
                crossed[mmsi] = {"mmsi": mmsi, "name": b["name"], "time": b["time"].isoformat(),
                                 "type_group": type_group(state.static.get(mmsi, {}).get("type"))}
    return {"gate": gate_id, "since": start.isoformat(), "count": len(crossed),
            "ships": sorted(crossed.values(), key=lambda c: c["time"])}


from server import markets  # noqa: E402
markets.gate_counter = gate_count
app.include_router(markets.router)


from server.chain import ChainOff, TxFailed, chain  # noqa: E402
from server import quotes  # noqa: E402
quotes.ship_lookup = find_ship
app.include_router(quotes.router)

from server import keeper as keeper_module  # noqa: E402
keeper_module.gate_counter = gate_count
keeper_module.ship_lookup = find_ship


def ships_in_bbox(bbox, max_age_minutes=60):
    """Live ships inside "minLon,minLat,maxLon,maxLat" (the re-pricing bot's port queue)."""
    x0, y0, x1, y1 = (float(v) for v in bbox.split(","))
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)
    with state.lock:
        return [state.describe(p) for p in state.latest.values()
                if p["time"] >= cutoff and x0 <= p["lon"] <= x1 and y0 <= p["lat"] <= y1]


keeper_module.ships_in_bbox = ships_in_bbox
keeper_module.live_dir = LIVE


@app.get("/api/keeper")
def keeper_status():
    """What the keeper has opened and settled, and its recent actions."""
    return keeper_module.keeper.status()

# The contract already allows one drip per address. This caps how fast new
# addresses can drain the faucet. It's global, not per IP, because the whole
# demo audience shares one venue wifi address.
FAUCET_PER_MINUTE = 30
_faucet_times = deque()
_faucet_lock = threading.Lock()


class FaucetRequest(BaseModel):
    address: str


@app.get("/api/chain")
def chain_status():
    """Is the server connected to the contracts, and how much MON do the server key and faucet hold."""
    return chain.status()


@app.post("/api/faucet")
def faucet(req: FaucetRequest):
    """Send a new burner wallet its gas money: Faucet.drip(address), once per address."""
    if not chain.ready():
        raise HTTPException(503, f"chain not set up: {chain.why_off}")
    try:
        if chain.already_dripped(req.address):
            raise HTTPException(409, "this address already got its MON")
    except ValueError as err:
        raise HTTPException(400, str(err))
    now = time.monotonic()
    with _faucet_lock:
        while _faucet_times and now - _faucet_times[0] > 60:
            _faucet_times.popleft()
        if len(_faucet_times) >= FAUCET_PER_MINUTE:
            raise HTTPException(429, "faucet is busy, try again in a minute")
        _faucet_times.append(now)
    try:
        tx_hash, amount = chain.drip(req.address)
    except TxFailed as err:
        # AlreadyDripped can still happen if two requests for one address race.
        code = 409 if "AlreadyDripped" in str(err) else 502
        raise HTTPException(code, f"drip failed: {err}")
    except ChainOff as err:
        raise HTTPException(503, f"chain not set up: {err}")
    return {"address": req.address, "tx": tx_hash, "amount_wei": str(amount), "amount_mon": amount / 1e18}


@app.get("/", response_class=HTMLResponse)
def home():
    """A plain status page, so opening the server's link shows something."""
    now = datetime.now(timezone.utc)
    with state.lock:
        total = len(state.latest)
        recent = [p for p in state.latest.values() if p["time"] >= now - timedelta(minutes=30)]
        counts = {}
        for p in recent:
            group = type_group(state.static.get(p["mmsi"], {}).get("type"))
            counts[group] = counts.get(group, 0) + 1
        last = state.last_poll
    age = f"{(now - last).total_seconds():.0f} seconds ago" if last else "not yet"
    rows = "".join(f"<tr><td>{g}</td><td>{n:,}</td></tr>" for g, n in sorted(counts.items(), key=lambda kv: -kv[1]))
    links = [
        ("/api/health", "health"),
        ("/api/ships?types=cargo,tanker&moving_only=true&limit=20", "20 moving cargo ships and tankers"),
        ("/api/ship/COSCO", "find a ship by name (COSCO)"),
        ("/api/gates/singapore/count?minutes=30", "Singapore Strait crossings, last 30 minutes"),
        ("/data/overview.json", "overview numbers"),
        ("/docs", "all endpoints"),
    ]
    link_html = "".join(f'<li><a href="{href}">{label}</a></li>' for href, label in links)
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Headway server</title><meta http-equiv="refresh" content="15">
<style>body{{margin:0;background:#222;color:#ececec;font:14px/1.6 ui-monospace,"SF Mono",Menlo,monospace}}
main{{max-width:720px;margin:0 auto;padding:40px 16px}}h1{{font-weight:300;letter-spacing:.4em;margin:0}}
.tag{{color:#8c8c8c;font-size:11px;letter-spacing:.18em}}td{{padding:2px 24px 2px 0}}a{{color:#f08a3c}}</style></head>
<body><main><h1>HEADWAY</h1><p class="tag">SERVER: RUNNING · LAST READ OF THE SHIP LOG {age.upper()}</p>
<p>{total:,} ships in memory, {len(recent):,} seen in the last 30 minutes:</p><table>{rows}</table>
<p class="tag" style="margin-top:28px">TRY</p><ul>{link_html}</ul>
<p class="tag">This page refreshes every 15 seconds.</p></main></body></html>"""


@app.get("/data/gates.json")
def gates_file():
    return FileResponse(GATES_FILE)


# Static data last, so the routes above win.
app.mount("/data", StaticFiles(directory=PROCESSED), name="data")

"""Log live ship positions from aisstream.io.

What it keeps:
  - every position report from ships near a gate (for gate crossing counts)
  - a thinned global sample, one position per ship every 15 minutes
    (for the overview's live numbers and for picking preset ships)
  - static data per ship (name, type, destination, ETA, draught, size),
    written whenever it changes

Files go to data/live/, one set per UTC day:
  gates_YYYYMMDD.csv, sample_YYYYMMDD.csv, static_YYYYMMDD.csv

Needs a free aisstream API key in the environment:
  export AISSTREAM_API_KEY=...
  ~/.venvs/chokepoint/bin/python -I scripts/ais_logger.py

Leave it running overnight. Ctrl-C to stop. It reconnects on its own if the
connection drops.

  --selftest   run fake messages through the handler, no network, no key
"""
import asyncio
import csv
import json
import os
import ssl
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import certifi
import websockets

ROOT = Path(__file__).resolve().parent.parent
LIVE = ROOT / "data" / "live"
GATES = ROOT / "data" / "gates.json"
URL = "wss://stream.aisstream.io/v0/stream"

SAMPLE_EVERY_SECONDS = 15 * 60
GATE_BUFFER_DEG = 0.3   # keep every position within this many degrees of a gate
SILENCE_SECONDS = 60    # reconnect if no message arrives for this long

POSITION_FIELDS = ["time_utc", "mmsi", "name", "lat", "lon", "sog", "cog", "heading", "nav_status"]
STATIC_FIELDS = ["time_utc", "mmsi", "imo", "name", "callsign", "type", "destination",
                 "eta", "draught", "length", "width"]


def gate_boxes():
    """Bounding boxes (lon_min, lon_max, lat_min, lat_max) around every gate, with a buffer."""
    gates = json.loads(GATES.read_text())
    boxes = []
    for line in gates["lines"]:
        lons = [line["a"][0], line["b"][0]]
        lats = [line["a"][1], line["b"][1]]
        boxes.append((min(lons) - GATE_BUFFER_DEG, max(lons) + GATE_BUFFER_DEG,
                      min(lats) - GATE_BUFFER_DEG, max(lats) + GATE_BUFFER_DEG))
    for box in gates["boxes"]:
        boxes.append((box["lon"][0] - GATE_BUFFER_DEG, box["lon"][1] + GATE_BUFFER_DEG,
                      box["lat"][0] - GATE_BUFFER_DEG, box["lat"][1] + GATE_BUFFER_DEG))
    return boxes


def near_a_gate(lon, lat, boxes):
    for lon_min, lon_max, lat_min, lat_max in boxes:
        if lon_min <= lon <= lon_max and lat_min <= lat <= lat_max:
            return True
    return False


def pick(d, *keys):
    """Return the first key that exists (aisstream has used both cases over time)."""
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return None


class Logger:
    def __init__(self):
        LIVE.mkdir(parents=True, exist_ok=True)
        self.boxes = gate_boxes()
        self.last_sampled = {}   # mmsi -> unix time of last sample write
        self.last_static = {}    # mmsi -> tuple of static fields last written
        self.day = None
        self.files = {}
        self.writers = {}
        self.counts = {"position": 0, "gate": 0, "sample": 0, "static": 0}

    def open_day(self):
        day = datetime.now(timezone.utc).strftime("%Y%m%d")
        if day == self.day:
            return
        for f in self.files.values():
            f.close()
        self.day = day
        for kind, fields in [("gates", POSITION_FIELDS), ("sample", POSITION_FIELDS), ("static", STATIC_FIELDS)]:
            path = LIVE / f"{kind}_{day}.csv"
            new_file = not path.exists()
            f = open(path, "a", newline="")
            writer = csv.DictWriter(f, fieldnames=fields)
            if new_file:
                writer.writeheader()
            self.files[kind] = f
            self.writers[kind] = writer

    def handle(self, msg):
        self.open_day()
        kind = msg.get("MessageType")
        meta = msg.get("MetaData", {})
        body = msg.get("Message", {}).get(kind, {})
        mmsi = pick(meta, "MMSI")
        if mmsi is None:
            return
        now_iso = pick(meta, "time_utc", "TimeUtc") or datetime.now(timezone.utc).isoformat()

        if kind == "PositionReport":
            # Explicit None checks: a latitude of 0.0 is valid, so `or` won't do.
            lat = pick(body, "Latitude")
            if lat is None:
                lat = pick(meta, "Latitude", "latitude")
            lon = pick(body, "Longitude")
            if lon is None:
                lon = pick(meta, "Longitude", "longitude")
            if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
                return
            row = {
                "time_utc": now_iso,
                "mmsi": mmsi,
                "name": (pick(meta, "ShipName") or "").strip(),
                "lat": lat,
                "lon": lon,
                "sog": pick(body, "Sog"),
                "cog": pick(body, "Cog"),
                "heading": pick(body, "TrueHeading"),
                "nav_status": pick(body, "NavigationalStatus"),
            }
            self.counts["position"] += 1
            if near_a_gate(lon, lat, self.boxes):
                self.writers["gates"].writerow(row)
                self.counts["gate"] += 1
            now = time.time()
            if now - self.last_sampled.get(mmsi, 0) >= SAMPLE_EVERY_SECONDS:
                self.writers["sample"].writerow(row)
                self.last_sampled[mmsi] = now
                self.counts["sample"] += 1

        elif kind == "ShipStaticData":
            dims = pick(body, "Dimension") or {}
            eta = pick(body, "Eta") or {}
            length = None
            width = None
            if dims:
                length = (dims.get("A") or 0) + (dims.get("B") or 0)
                width = (dims.get("C") or 0) + (dims.get("D") or 0)
            eta_text = ""
            if eta:
                eta_text = f"{eta.get('Month', 0):02d}-{eta.get('Day', 0):02d} {eta.get('Hour', 0):02d}:{eta.get('Minute', 0):02d}"
            row = {
                "time_utc": now_iso,
                "mmsi": mmsi,
                "imo": pick(body, "ImoNumber"),
                "name": (pick(body, "Name") or pick(meta, "ShipName") or "").strip(),
                "callsign": (pick(body, "CallSign") or "").strip(),
                "type": pick(body, "Type"),
                "destination": (pick(body, "Destination") or "").strip(),
                "eta": eta_text,
                "draught": pick(body, "MaximumStaticDraught"),
                "length": length,
                "width": width,
            }
            key = tuple(row[k] for k in STATIC_FIELDS[1:])
            if self.last_static.get(mmsi) != key:
                self.writers["static"].writerow(row)
                self.last_static[mmsi] = key
                self.counts["static"] += 1

    def flush(self):
        for f in self.files.values():
            f.flush()


async def run(logger, api_key):
    subscription = {
        "APIKey": api_key,
        "BoundingBoxes": [[[-90, -180], [90, 180]]],   # [lat, lon] pairs, whole world
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    }
    # The python.org build of Python doesn't use the Mac's certificate store,
    # so point it at certifi's bundle or the TLS handshake fails.
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    backoff = 5
    while True:
        try:
            # ping_interval=None: aisstream doesn't answer client pings reliably,
            # and the library was closing a healthy connection over it. Instead
            # I watch the data itself and reconnect if nothing arrives for a while.
            async with websockets.connect(URL, max_size=None, ping_interval=None, ssl=ssl_context) as ws:
                # aisstream closes the connection if the subscription isn't sent within 3 seconds.
                await ws.send(json.dumps(subscription))
                print(datetime.now().strftime("%H:%M:%S"), "connected and subscribed")
                last_report = time.time()
                while True:
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=SILENCE_SECONDS)
                    except asyncio.TimeoutError:
                        print(datetime.now().strftime("%H:%M:%S"), f"no data for {SILENCE_SECONDS}s, reconnecting")
                        break
                    backoff = 5
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8")
                    msg = json.loads(raw)
                    if "error" in msg:
                        print("server error:", msg["error"])
                        continue
                    logger.handle(msg)
                    if time.time() - last_report > 60:
                        logger.flush()
                        print(datetime.now().strftime("%H:%M:%S"), logger.counts)
                        last_report = time.time()
        except Exception as err:
            # Catch everything (dropped connections, failed handshakes after the
            # Mac wakes from sleep, DNS errors) so the logger never dies overnight.
            print(datetime.now().strftime("%H:%M:%S"), f"connection dropped ({err}), retrying in {backoff}s")
        logger.flush()
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 120)


def selftest():
    """Push a few fake messages through the handler and print what got written."""
    global LIVE
    LIVE = ROOT / "data" / "live_selftest"
    logger = Logger()
    fake = [
        {"MessageType": "PositionReport",
         "MetaData": {"MMSI": 111, "ShipName": "TEST DOVER", "Latitude": 51.0, "Longitude": 1.45},
         "Message": {"PositionReport": {"Latitude": 51.0, "Longitude": 1.45, "Sog": 14.2, "Cog": 40.0, "TrueHeading": 41, "NavigationalStatus": 0}}},
        {"MessageType": "PositionReport",
         "MetaData": {"MMSI": 222, "ShipName": "TEST PACIFIC", "Latitude": 20.0, "Longitude": -150.0},
         "Message": {"PositionReport": {"Latitude": 20.0, "Longitude": -150.0, "Sog": 18.0, "Cog": 270.0, "TrueHeading": 270, "NavigationalStatus": 0}}},
        {"MessageType": "ShipStaticData",
         "MetaData": {"MMSI": 111, "ShipName": "TEST DOVER"},
         "Message": {"ShipStaticData": {"ImoNumber": 9000001, "Name": "TEST DOVER", "CallSign": "ABCD", "Type": 71,
                                        "Destination": "NLRTM", "Eta": {"Month": 11, "Day": 16, "Hour": 4, "Minute": 30},
                                        "MaximumStaticDraught": 13.5, "Dimension": {"A": 300, "B": 66, "C": 25, "D": 26}}}},
    ]
    for msg in fake:
        logger.handle(msg)
    logger.flush()
    print("counts:", logger.counts)
    for path in sorted(LIVE.glob("*.csv")):
        print("==", path.name)
        print(path.read_text())


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    api_key = os.environ.get("AISSTREAM_API_KEY")
    if not api_key:
        # Fall back to a local .env file in the project folder (not committed).
        env_file = ROOT / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("AISSTREAM_API_KEY="):
                    api_key = line.split("=", 1)[1].strip()
    if not api_key:
        sys.exit("Set AISSTREAM_API_KEY, or put AISSTREAM_API_KEY=... in Chokepoint/.env (free key from aisstream.io).")
    logger = Logger()
    try:
        asyncio.run(run(logger, api_key))
    except KeyboardInterrupt:
        logger.flush()
        print("stopped", logger.counts)


if __name__ == "__main__":
    main()

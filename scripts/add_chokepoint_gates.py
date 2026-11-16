"""Make sure every PortWatch chokepoint has a live gate.

Ten chokepoints have a hand-drawn line in data/gates.json. For the other 18
this adds a box around the PortWatch point (0.35 degrees each way), so the
logger records ships there and the summarizer can count ships entering.
A box is a rougher count than a line across the strait, but it covers every
strait without me drawing 18 more lines by hand.

Safe to run more than once: it replaces the boxes it added before.

Run:  ~/.venvs/chokepoint/bin/python -I scripts/add_chokepoint_gates.py
Then restart ais_logger.py so it picks up the new gates.
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
GATES = ROOT / "data" / "gates.json"
HALF = 0.35

# PortWatch chokepoint -> id of the hand-drawn line that already covers it.
HAS_LINE = {
    "Malacca Strait": "malacca", "Dover Strait": "dover", "Gibraltar Strait": "gibraltar",
    "Bosporus Strait": "bosporus", "Strait of Hormuz": "hormuz", "Bab el-Mandeb Strait": "bab_el_mandeb",
    "Suez Canal": "suez_south", "Panama Canal": "panama_pac", "Taiwan Strait": "taiwan",
    "Oresund Strait": "oresund",
}


def main():
    gates = json.loads(GATES.read_text())
    chokepoints = pd.read_csv(ROOT / "data" / "raw" / "portwatch" / "chokepoints.csv")

    # Drop boxes added by an earlier run, then add them fresh.
    gates["boxes"] = [b for b in gates["boxes"] if not b["id"].startswith("cp_")]
    added = 0
    for _, cp in chokepoints.iterrows():
        if cp["portname"] in HAS_LINE:
            continue
        gate_id = "cp_" + cp["portname"].lower().replace(" ", "_").replace("-", "_")
        gates["boxes"].append({
            "id": gate_id, "name": cp["portname"], "kind": "chokepoint",
            "lon": [round(cp["lon"] - HALF, 3), round(cp["lon"] + HALF, 3)],
            "lat": [round(cp["lat"] - HALF, 3), round(cp["lat"] + HALF, 3)],
        })
        added += 1

    # Record which gate measures which PortWatch chokepoint.
    gates["chokepoint_gate"] = dict(HAS_LINE)
    for box in gates["boxes"]:
        if box["id"].startswith("cp_"):
            gates["chokepoint_gate"][box["name"]] = box["id"]

    GATES.write_text(json.dumps(gates, indent=1))
    print(f"added {added} chokepoint boxes; {len(gates['lines'])} lines and {len(gates['boxes'])} boxes in total")
    print(f"{len(gates['chokepoint_gate'])} of {len(chokepoints)} PortWatch chokepoints have a gate")


if __name__ == "__main__":
    main()

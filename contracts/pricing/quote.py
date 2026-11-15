"""Build and sign market quotes for Markets.createMarket.

A quote fixes a market's terms and its starting price. The pricer key signs it (EIP-712) and the
contract checks the signature, so nobody can open a market at a price the model didn't give.

The server exposes this as POST /api/quote; the page sends the quote and signature to createMarket.

    from contracts.pricing.quote import arrival_quote
    q = arrival_quote("COSCO SAGITTARIUS", "Rotterdam", deadline, signer_key, markets_address)
    # -> {"quote": {...}, "signature": "0x...", "model": {...}, "hedge": {...}}

Needs `eth-account` for signing (pip install eth-account). Pricing itself is stdlib (model.py).
CLI:  python3 contracts/pricing/quote.py "COSCO SAGITTARIUS" Rotterdam 24   (hours to the deadline; prints unsigned)
"""

import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import model  # noqa: E402

CHAIN_ID = 10143
WEI = 10**18

# Policy: how big the vault's bet is on each kind of market, and the caps that limit manipulation.
POLICY = {
    "arrival": {"seed_mon": 1.0, "max_collateral_mon": 8.0, "creation_fee_mon": 0.01, "fee_bps": 200,
                "resolve_grace_h": 24},
    "weekly": {"seed_mon": 0.5, "max_collateral_mon": 20.0, "creation_fee_mon": 0.01, "fee_bps": 100,
               "resolve_grace_h": 24 * 14},
    "trade": {"seed_mon": 0.5, "max_collateral_mon": 20.0, "creation_fee_mon": 0.01, "fee_bps": 100,
              "resolve_grace_h": 24 * 30},
    "live": {"seed_mon": 0.3, "max_collateral_mon": 5.0, "creation_fee_mon": 0.0, "fee_bps": 100,
             "resolve_grace_h": 2},
}
QUOTE_TTL = timedelta(minutes=10)
PRIOR_MIN_BPS, PRIOR_MAX_BPS = 200, 9_800

QUOTE_TYPES = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "Quote": [
        {"name": "question", "type": "string"},
        {"name": "series", "type": "string"},
        {"name": "subject", "type": "bytes32"},
        {"name": "threshold", "type": "int256"},
        {"name": "isAbove", "type": "bool"},
        {"name": "closeTime", "type": "uint64"},
        {"name": "resolveBy", "type": "uint64"},
        {"name": "feeBps", "type": "uint16"},
        {"name": "priorYesBps", "type": "uint16"},
        {"name": "seed", "type": "uint256"},
        {"name": "maxCollateral", "type": "uint256"},
        {"name": "creationFee", "type": "uint256"},
        {"name": "expiry", "type": "uint64"},
        {"name": "quoteId", "type": "bytes32"},
    ],
}


def keccak_text(text):
    from eth_utils import keccak  # installed with eth-account

    return "0x" + keccak(text=text).hex().removeprefix("0x")


def _mon(x):
    return int(round(x * WEI))


def _ts(dt):
    return int(dt.timestamp())


def build(kind, question, series, subject_key, threshold, is_above, close_time, prior, now=None):
    """Quote dict with every field the contract signs. Integers stay ints (JSON-encode as strings)."""
    now = now or datetime.now(timezone.utc)
    pol = POLICY[kind]
    return {
        "question": question,
        "series": series,
        "subject": keccak_text(subject_key),
        "threshold": int(threshold),
        "isAbove": bool(is_above),
        "closeTime": _ts(close_time),
        "resolveBy": _ts(close_time + timedelta(hours=pol["resolve_grace_h"])) if kind != "arrival" else None,
        "feeBps": pol["fee_bps"],
        "priorYesBps": int(min(max(round(prior * 10_000), PRIOR_MIN_BPS), PRIOR_MAX_BPS)),
        "seed": _mon(pol["seed_mon"]),
        "maxCollateral": _mon(pol["max_collateral_mon"]),
        "creationFee": _mon(pol["creation_fee_mon"]),
        "expiry": _ts(now + QUOTE_TTL),
        "quoteId": "0x" + secrets.token_hex(32),
    }


def sign(quote, private_key, markets_address, chain_id=CHAIN_ID):
    """EIP-712 signature (0x, 65 bytes) the contract's createMarket accepts."""
    from eth_account import Account
    from eth_account.messages import encode_typed_data

    msg = encode_typed_data(full_message={
        "types": QUOTE_TYPES,
        "primaryType": "Quote",
        "domain": {"name": "Headway", "version": "1", "chainId": chain_id, "verifyingContract": markets_address},
        "message": quote,
    })
    sig = Account.sign_message(msg, private_key=private_key).signature.hex()
    return sig if sig.startswith("0x") else "0x" + sig


def to_json(quote):
    """Big integers as strings so JavaScript doesn't round them."""
    return {k: (str(v) if isinstance(v, int) and not isinstance(v, bool) else v) for k, v in quote.items()}


# ------------------------------------------------------------------ market kinds

def arrival_quote(ship_query, port_query, deadline, private_key=None, markets_address=None,
                  cargo_usd=None, usd_per_mon=1000.0, now=None):
    """'Will <ship> arrive at <port> after <deadline>?' YES = late. The hedge a trade manager buys."""
    now = now or datetime.now(timezone.utc)
    ship = model.fetch_ship(ship_query)
    if "lat" not in ship:
        raise ValueError(f"ship not found or no position: {ship_query}")
    port = model.find_port(port_query)
    if deadline <= now + timedelta(hours=1):
        raise ValueError("deadline must be at least an hour away")

    priced = model.price_arrival(ship, port, deadline, now=now)
    # Trading stops before the deadline (6 h, or a quarter of the time left if sooner), so
    # nobody trades on a ship already visible at the berth. Arrival settles it early anyway.
    close = deadline - min(timedelta(hours=6), (deadline - now) / 4)
    ship_id = ship.get("imo") or ship.get("mmsi")
    code = model.port_code(port)
    q = build(
        "arrival",
        f"Will {ship.get('name') or ship_id} arrive at {port['name']} after {deadline:%b %-d, %H:%M} UTC?",
        f"arrival:{ship_id}:{code}",
        f"ship:{ship_id}",
        _ts(deadline), True, close, priced["p_yes"], now=now,
    )
    q["resolveBy"] = _ts(deadline + timedelta(hours=POLICY["arrival"]["resolve_grace_h"]))

    out = {"quote": q, "model": priced}
    if cargo_usd:
        late_h = max(12.0, priced["sigma_hours"] * 2)
        out["hedge"] = model.suggest_hedge(cargo_usd, priced["p_yes"], late_h,
                                           priced["inputs"]["delay_cost_pct_per_day"], usd_per_mon)
    if private_key and markets_address:
        out["signature"] = sign(q, private_key, markets_address)
    out["quote"] = to_json(q)
    return out


def example_quote(m, private_key=None, markets_address=None, now=None):
    """Quote for an entry in contracts/markets/examples.json (straits, routes, trade, live gates)."""
    now = now or datetime.now(timezone.utc)
    kind = {"live": "live", "trade": "trade"}.get(m["group"], "weekly")
    close = now + timedelta(minutes=m["close_minutes"]) if m.get("close_minutes") else \
        datetime.fromisoformat(m["close_time"].replace("Z", "+00:00"))
    root = ":".join(m["series"].split(":")[:2])  # e.g. portwatch:Suez Canal -> one cap per strait
    q = build(kind, m["question"], m["series"], root, m["threshold"], m["is_above"], close,
              m["prior_yes_bps"] / 10_000, now=now)
    q["seed"] = _mon(m.get("seed_mon", POLICY[kind]["seed_mon"]))
    out = {"quote": q}
    if private_key and markets_address:
        out["signature"] = sign(q, private_key, markets_address)
    out["quote"] = to_json(q)
    return out


if __name__ == "__main__":
    import json

    ship = sys.argv[1] if len(sys.argv) > 1 else "COSCO SAGITTARIUS"
    port = sys.argv[2] if len(sys.argv) > 2 else "Rotterdam"
    hours = float(sys.argv[3]) if len(sys.argv) > 3 else 24
    deadline = (datetime.now(timezone.utc) + timedelta(hours=hours)).replace(second=0, microsecond=0)
    key = os.environ.get("PRICER_PRIVATE_KEY")
    addr = os.environ.get("MARKETS_ADDRESS")
    print(json.dumps(arrival_quote(ship, port, deadline, key, addr, cargo_usd=500_000), indent=1, default=str))

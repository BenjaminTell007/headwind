"""POST /api/quote: price a ship-arrival hedge and sign it.

The pricing is Xavi's (contracts/pricing/quote.py and model.py). The server's
part is the ship data and the signature: quote.arrival_quote() builds an
unsigned quote and chain.sign_quote() signs it with the server key, the one
signer that was tested against Markets.quoteDigest (CHAIN_SERVER.md item 1).

The page sends the result straight to Markets.createMarket (web/chain/markets.js
requestQuote() expects exactly this shape: numbers as strings).
"""
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from contracts.pricing import quote as pricing  # noqa: E402  (also puts contracts/pricing on sys.path)
import model as pricing_model  # noqa: E402  (Xavi's model.py, imported by quote.py under this name)

from server.chain import ChainOff, chain

router = APIRouter()

# Set by app.py: the server's own ship lookup (find_ship), so pricing reads the
# ships already in memory instead of calling this server back over HTTP.
ship_lookup = None


def _ship_from_memory(query):
    try:
        return ship_lookup(str(query))
    except Exception:
        return {}  # arrival_quote turns a ship with no position into "ship not found"


class QuoteRequest(BaseModel):
    ship: str                     # name, MMSI or IMO
    port: str                     # port name or LOCODE
    deadline: str                 # ISO time; YES = the ship arrives after it
    cargoUsd: float | None = None
    usdPerMon: float = 1000.0     # demo exchange rate for hedge sizing (CHAIN_SERVER.md open question)


@router.post("/api/quote")
def quote(req: QuoteRequest):
    if ship_lookup is not None:
        pricing_model.fetch_ship = _ship_from_memory
    if not chain.ready():
        raise HTTPException(503, f"chain not set up: {chain.why_off}")
    try:
        deadline = datetime.fromisoformat(req.deadline.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, f"deadline is not an ISO time: {req.deadline}")
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)

    try:
        out = pricing.arrival_quote(req.ship, req.port, deadline, cargo_usd=req.cargoUsd,
                                    usd_per_mon=req.usdPerMon)
    except ValueError as err:  # unknown ship or port, deadline too soon
        raise HTTPException(400, str(err))
    try:
        out["signature"] = chain.sign_quote(chain.quote_from_json(out["quote"]))
    except ChainOff as err:
        raise HTTPException(503, f"chain not set up: {err}")
    out["markets"] = chain.markets.address
    out["chainId"] = chain.chain_id
    return out

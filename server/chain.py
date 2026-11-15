"""The server's link to Monad: one key, one transaction at a time.

The server key has three jobs on the contracts (see contracts/README.md):
  - faucet relayer: Faucet.drip(address) for new burner wallets
  - pricer:  signs market quotes (EIP-712) that Markets.createMarket checks
  - oracle:  Markets.resolve / resolveInvalid when a market's number is in

Settings, from the environment or else PRIVATE.md in the repo root (KEY=VALUE lines):
  SERVER_PRIVATE_KEY    the server key (never commit it); PRICER_PRIVATE_KEY also works
  MONAD_RPC_URL         default https://testnet-rpc.monad.xyz
  HEADWAY_DEPLOYMENTS   default contracts/deployments.json, written by
                        contracts/script/write_deployments.mjs after a deploy

Addresses and ABIs are read from the deployments file, never copied here, so
whatever version of the contracts is deployed is what the server talks to.
If the key or the file is missing, chain features report themselves as off
and the rest of the server runs as normal.

Monad charges gas on the gas limit, not gas used, so limits are the estimate
plus 12%, never a library default.
"""
import json
import os
import secrets
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_RPC = "https://testnet-rpc.monad.xyz"
GAS_MARGIN = 1.12
RECEIPT_TIMEOUT = 30


def setting(name, default=None):
    """Environment first, then a NAME=value line in PRIVATE.md."""
    value = os.environ.get(name)
    if value:
        return value.strip()
    private = ROOT / "PRIVATE.md"
    if private.exists():
        for line in private.read_text().splitlines():
            if line.startswith(f"{name}=") and line.split("=", 1)[1].strip():
                return line.split("=", 1)[1].strip()
    return default


class ChainOff(Exception):
    """Chain features aren't configured (no key or no deployments file)."""


class TxFailed(Exception):
    """A transaction reverted or never landed."""


class Chain:
    def __init__(self):
        self._lock = threading.Lock()   # one transaction in flight at a time, so nonces never clash
        self._ready = False
        self._nonce = None
        self.why_off = None

    # ---------- setup ----------

    def _setup(self):
        """Connect on first use, so the server starts even if the chain isn't set up."""
        if self._ready:
            return
        from web3 import Web3
        from eth_account import Account

        # contracts/README.md calls it PRICER_PRIVATE_KEY; one key does all three jobs by default.
        key = setting("SERVER_PRIVATE_KEY") or setting("PRICER_PRIVATE_KEY")
        path = Path(setting("HEADWAY_DEPLOYMENTS", ROOT / "contracts" / "deployments.json"))
        if not key:
            self.why_off = "SERVER_PRIVATE_KEY is not set"
            raise ChainOff(self.why_off)
        if not path.exists():
            self.why_off = f"no deployments file at {path} (contracts not deployed yet?)"
            raise ChainOff(self.why_off)
        dep = json.loads(path.read_text())
        if not dep.get("markets", {}).get("abi") or not dep.get("faucet", {}).get("abi"):
            self.why_off = f"{path} has no ABIs: run `forge build` before write_deployments.mjs"
            raise ChainOff(self.why_off)

        self.w3 = Web3(Web3.HTTPProvider(setting("MONAD_RPC_URL", dep.get("rpc") or DEFAULT_RPC),
                                         request_kwargs={"timeout": 20}))
        self.account = Account.from_key(key)
        self.chain_id = self.w3.eth.chain_id  # from the node, not the file, so the signatures match the chain
        self.markets = self.w3.eth.contract(address=Web3.to_checksum_address(dep["markets"]["address"]),
                                            abi=dep["markets"]["abi"])
        self.faucet = self.w3.eth.contract(address=Web3.to_checksum_address(dep["faucet"]["address"]),
                                           abi=dep["faucet"]["abi"])
        self.deployments = dep
        self.why_off = None
        self._ready = True

    def ready(self):
        try:
            self._setup()
            return True
        except ChainOff:
            return False

    def status(self):
        """For /api/health: is the chain on, and what does the server key hold."""
        if not self.ready():
            return {"on": False, "why": self.why_off}
        try:
            return {
                "on": True,
                "chain_id": self.chain_id,
                "server_address": self.account.address,
                "server_balance_mon": self.w3.eth.get_balance(self.account.address) / 1e18,
                "markets": self.markets.address,
                "faucet": self.faucet.address,
                "faucet_balance_mon": self.w3.eth.get_balance(self.faucet.address) / 1e18,
                "market_count": self.markets.functions.marketCount().call(),
            }
        except Exception as err:
            return {"on": True, "error": str(err)}

    # ---------- sending ----------

    def send(self, fn, value=0):
        """Sign and send one contract call with the server key, wait for the receipt.
        Returns the receipt. Raises TxFailed if it reverts or doesn't land."""
        self._setup()
        with self._lock:
            if self._nonce is None:
                self._nonce = self.w3.eth.get_transaction_count(self.account.address, "pending")
            try:
                tx = fn.build_transaction({
                    "from": self.account.address,
                    "nonce": self._nonce,
                    "value": value,
                    "chainId": self.chain_id,
                })
                # build_transaction estimates gas; Monad bills the whole limit, so keep it tight.
                tx["gas"] = int(tx["gas"] * GAS_MARGIN)
                signed = self.account.sign_transaction(tx)
                tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
                self._nonce += 1
                receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=RECEIPT_TIMEOUT,
                                                                   poll_latency=0.25)
            except Exception as err:
                self._nonce = None  # re-read it next time rather than guess
                raise TxFailed(_reason(err)) from err
            if receipt["status"] != 1:
                raise TxFailed(f"reverted: {receipt['transactionHash'].to_0x_hex()}")
            return receipt

    # ---------- faucet ----------

    def already_dripped(self, address):
        self._setup()
        return self.faucet.functions.dripped(self._addr(address)).call()

    def drip(self, address):
        """Send the faucet amount to a new burner wallet. Returns (tx_hash, amount_wei)."""
        self._setup()
        to = self._addr(address)
        receipt = self.send(self.faucet.functions.drip(to))
        return receipt["transactionHash"].to_0x_hex(), self.faucet.functions.amount().call()

    # ---------- markets ----------

    def sign_quote(self, quote):
        """EIP-712 signature over a Quote, matching Markets.quoteDigest. `quote` holds
        the struct's fields by name; returns the 65-byte signature as 0x hex."""
        from eth_account.messages import encode_typed_data
        self._setup()
        message = {
            "domain": {"name": "Headway", "version": "1", "chainId": self.chain_id,
                       "verifyingContract": self.markets.address},
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
                ],
                "Quote": [{"name": n, "type": t} for n, t in QUOTE_FIELDS],
            },
            "primaryType": "Quote",
            "message": quote,
        }
        signed = self.account.sign_message(encode_typed_data(full_message=message))
        return "0x" + signed.signature.hex().removeprefix("0x")

    def create_market(self, quote, buy_yes=False, min_shares=0, stake=0):
        """Open a market with a quote the server signs itself (used by the keeper).
        Sends creationFee plus any stake. Returns the new market id."""
        self._setup()
        sig = self.sign_quote(quote)
        args = tuple(quote[n] for n, _ in QUOTE_FIELDS)
        receipt = self.send(self.markets.functions.createMarket(args, bytes.fromhex(sig[2:]), buy_yes, min_shares),
                            value=quote["creationFee"] + stake)
        events = self.markets.events.MarketCreated().process_receipt(receipt)
        return events[0]["args"]["id"]

    def resolve(self, market_id, value):
        return self.send(self.markets.functions.resolve(market_id, int(value)))["transactionHash"].to_0x_hex()

    def resolve_invalid(self, market_id):
        return self.send(self.markets.functions.resolveInvalid(market_id))["transactionHash"].to_0x_hex()

    def settle_vault(self, market_id):
        """Pull the vault's money back out of a resolved market. Anyone may call it."""
        return self.send(self.markets.functions.settleVault(market_id))["transactionHash"].to_0x_hex()

    def get_market(self, market_id):
        self._setup()
        m = self.markets.functions.getMarket(market_id).call()
        names = [o["name"] for o in self._abi_fn("getMarket")["outputs"][0]["components"]]
        out = dict(zip(names, m))
        out["priceYes"] = self.markets.functions.priceYes(market_id).call()
        return out

    def new_quote_id(self):
        return "0x" + secrets.token_hex(32)

    # ---------- helpers ----------

    def _addr(self, address):
        from web3 import Web3
        if not Web3.is_address(address):
            raise ValueError(f"not an address: {address}")
        return Web3.to_checksum_address(address)

    def _abi_fn(self, name):
        return next(x for x in self.markets.abi if x.get("type") == "function" and x["name"] == name)


# Field order of Markets.Quote and QUOTE_TYPEHASH. If Xavi changes the struct, change this.
QUOTE_FIELDS = [
    ("question", "string"), ("series", "string"), ("subject", "bytes32"), ("threshold", "int256"),
    ("isAbove", "bool"), ("closeTime", "uint64"), ("resolveBy", "uint64"), ("feeBps", "uint16"),
    ("priorYesBps", "uint16"), ("seed", "uint256"), ("maxCollateral", "uint256"),
    ("creationFee", "uint256"), ("expiry", "uint64"), ("quoteId", "bytes32"),
]


def _reason(err):
    """Shortest useful message from a web3 error (custom errors come back as selectors)."""
    text = str(err)
    for name, sig in CUSTOM_ERRORS.items():
        if sig in text:
            return name
    return text[:300]


def _selector(signature):
    from eth_utils import keccak
    return "0x" + keccak(text=signature)[:4].hex()


CUSTOM_ERRORS = {}
try:
    CUSTOM_ERRORS = {n: _selector(n + "()") for n in [
        "NotOwner", "NotRelayer", "AlreadyDripped", "Empty", "TransferFailed", "NotOracle", "BadQuote",
        "BadParams", "VaultShort", "CapReached", "AlreadyResolved", "NotResolved", "TooEarly", "NothingToPay",
    ]}
except Exception:
    pass

chain = Chain()

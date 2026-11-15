# Contracts

Two small contracts on Monad testnet. Simple YES/NO pools, no automated market maker (LMSR needs `exp` and `ln`, which Solidity doesn't have built in).

## Setup

```bash
curl -L https://foundry.paradigm.xyz | bash
```

```bash
foundryup
```

Then from this folder:

```bash
forge init --no-git --force .
```

Monad testnet RPC, chain ID and faucet: check docs.monad.xyz on the day. Put them in a local `.env` (not committed):

```
MONAD_RPC_URL=...
DEPLOYER_PRIVATE_KEY=...
```

After deploying, write the addresses and ABIs to `contracts/deployments.json` so the page and the server can read them.

## Markets.sol

State for each market:
- `question` (string), `series` (bytes32, see PLAN.md for the format)
- `threshold` (int256), `isAbove` (bool): the market settles YES if `value >= threshold` when `isAbove`, or `value < threshold` when not
- `closeTime` (uint64): no new positions after this
- `yesPool`, `noPool` (uint256, in wei)
- `resolved` (bool), `outcomeYes` (bool), `value` (int256)
- per user: `yesStake`, `noStake`, `claimed`

Functions:
- `createMarket(string question, bytes32 series, int256 threshold, bool isAbove, uint64 closeTime) returns (uint256 id)`: owner or oracle only, so the demo isn't flooded
- `takePosition(uint256 id, bool yes)` payable: adds `msg.value` to that side. Reverts after `closeTime` or once resolved
- `resolve(uint256 id, int256 value)`: oracle only, after `closeTime`. Sets the outcome
- `claim(uint256 id)`: pays the caller `stake / winningPool * (yesPool + noPool)`. If nobody took the winning side, everyone gets their stake back
- `getMarket(uint256 id)` view, and `marketCount()`

Events (the page draws from these):
- `MarketCreated(uint256 indexed id, bytes32 series, string question, int256 threshold, bool isAbove, uint64 closeTime)`
- `PositionTaken(uint256 indexed id, address indexed who, bool yes, uint256 amount, uint256 yesPool, uint256 noPool)`
- `MarketResolved(uint256 indexed id, int256 value, bool outcomeYes)`
- `Claimed(uint256 indexed id, address indexed who, uint256 amount)`

Odds on the page: `yesPool / (yesPool + noPool)`.

Owner and oracle: the deployer is the owner. The owner can set the oracle address (the server's key).

## Faucet.sol

- Holds testnet MON, sent to it by the deployer
- `drip(address to)`: relayer only, sends a fixed small amount (for example 0.05 MON) once per address
- `setRelayer(address)`: owner only

The server calls `drip` for each new burner wallet, so nobody in the audience needs MetaMask or a faucet.

## Tests worth writing first

- Two users on opposite sides, resolve, both claim: the winner gets the whole pool, the loser gets nothing
- Nobody on the winning side: everyone gets their stake back
- `takePosition` after `closeTime` reverts
- `resolve` from a non-oracle reverts
- Double `claim` reverts

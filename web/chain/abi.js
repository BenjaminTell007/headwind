// Human-readable ABIs for contracts/src/Markets.sol and Faucet.sol.
// Plain strings (no imports) so both the page and Node scripts can use them: pass to viem's parseAbi.
// Keep in step with the Solidity if a signature changes.

export const MARKETS_ABI = [
  'struct Quote { string question; string series; bytes32 subject; int256 threshold; bool isAbove; uint64 closeTime; uint64 resolveBy; uint16 feeBps; uint16 priorYesBps; uint256 seed; uint256 maxCollateral; uint256 creationFee; uint64 expiry; bytes32 quoteId; }',
  'struct Market { address creator; uint64 closeTime; uint64 resolveBy; uint16 feeBps; uint8 outcome; bool isAbove; bool vaultSettled; bytes32 subject; int256 threshold; int256 value; uint256 yesReserve; uint256 noReserve; uint256 lpSupply; uint256 feesPerLp; uint256 collateral; uint256 maxCollateral; uint256 vaultSeed; string series; string question; }',

  // markets
  'function createMarket(Quote q, bytes sig, bool buyYes, uint256 minShares) payable returns (uint256 id)',
  'function buy(uint256 id, bool yes, uint256 minShares) payable returns (uint256)',
  'function sell(uint256 id, bool yes, uint256 shares, uint256 minOut) returns (uint256 out)',
  'function addLiquidity(uint256 id) payable',
  'function removeLiquidity(uint256 id, uint256 lp)',
  'function resolve(uint256 id, int256 value)',
  'function resolveInvalid(uint256 id)',
  'function redeem(uint256 id) returns (uint256 amount)',
  'function claimFees(uint256 id) returns (uint256 amount)',

  // vault
  'function deposit() payable returns (uint256 shares)',
  'function withdraw(uint256 shares) returns (uint256 amount)',
  'function settleVault(uint256 id) returns (uint256 returned)',
  'function vaultValue() view returns (uint256)',
  'function vaultIdle() view returns (uint256)',
  'function vaultDeployed() view returns (uint256)',
  'function vaultTotalShares() view returns (uint256)',
  'function vaultShares(address) view returns (uint256)',
  'function subjectExposure(bytes32) view returns (uint256)',
  'function subjectCap() view returns (uint256)',

  // views
  'function getMarket(uint256 id) view returns (Market)',
  'function marketCount() view returns (uint256)',
  'function priceYes(uint256 id) view returns (uint256)',
  'function quoteBuy(uint256 id, bool yes, uint256 amount) view returns (uint256)',
  'function quoteSell(uint256 id, bool yes, uint256 shares) view returns (uint256)',
  'function costForShares(uint256 id, bool yes, uint256 shares) view returns (uint256)',
  'function accounts(uint256 id, address who) view returns (uint256 yes, uint256 no, uint256 lp, uint256 feeDebt, uint256 feesOwed)',
  'function pendingFees(uint256 id, address who) view returns (uint256)',
  'function quoteDigest(Quote q) view returns (bytes32)',
  'function quoteUsed(bytes32) view returns (bool)',
  'function oracle() view returns (address)',
  'function pricer() view returns (address)',
  'function owner() view returns (address)',
  'function setRoles(address oracle, address pricer, uint256 subjectCap)',

  // events
  'event MarketCreated(uint256 indexed id, address indexed creator, bytes32 indexed subject, string series, string question, int256 threshold, bool isAbove, uint64 closeTime, uint256 seed, uint256 priceYes)',
  'event Trade(uint256 indexed id, address indexed who, bool yes, bool isBuy, uint256 amount, uint256 shares, uint256 fee, uint256 yesReserve, uint256 noReserve, uint256 priceYes)',
  'event LiquidityAdded(uint256 indexed id, address indexed who, uint256 amount, uint256 lpMinted)',
  'event LiquidityRemoved(uint256 indexed id, address indexed who, uint256 lpBurned, uint256 yesOut, uint256 noOut)',
  'event MarketResolved(uint256 indexed id, int256 value, uint8 outcome)',
  'event Redeemed(uint256 indexed id, address indexed who, uint256 amount)',
  'event FeesClaimed(uint256 indexed id, address indexed who, uint256 amount)',
  'event VaultDeposit(address indexed who, uint256 amount, uint256 shares)',
  'event VaultWithdraw(address indexed who, uint256 amount, uint256 shares)',
  'event VaultSettled(uint256 indexed id, uint256 seed, uint256 returned)',
  'event RolesChanged(address oracle, address pricer, uint256 subjectCap)',

  // errors
  'error NotOwner()',
  'error NotOracle()',
  'error BadParams()',
  'error BadQuote()',
  'error MarketClosed()',
  'error NotResolved()',
  'error AlreadyResolved()',
  'error TooEarly()',
  'error Slippage()',
  'error CapReached()',
  'error VaultShort()',
  'error NothingToPay()',
  'error TransferFailed()',
];

/** EIP-712 types for a quote. Must match Markets.QUOTE_TYPEHASH and contracts/pricing/quote.py. */
export const QUOTE_DOMAIN = { name: 'Headway', version: '1' }; // + chainId, verifyingContract
export const QUOTE_TYPES = {
  Quote: [
    { name: 'question', type: 'string' },
    { name: 'series', type: 'string' },
    { name: 'subject', type: 'bytes32' },
    { name: 'threshold', type: 'int256' },
    { name: 'isAbove', type: 'bool' },
    { name: 'closeTime', type: 'uint64' },
    { name: 'resolveBy', type: 'uint64' },
    { name: 'feeBps', type: 'uint16' },
    { name: 'priorYesBps', type: 'uint16' },
    { name: 'seed', type: 'uint256' },
    { name: 'maxCollateral', type: 'uint256' },
    { name: 'creationFee', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'quoteId', type: 'bytes32' },
  ],
};

/** Market.outcome values. */
export const OUTCOME = { OPEN: 0, YES: 1, NO: 2, INVALID: 3 };

export const FAUCET_ABI = [
  'function drip(address to)',
  'function dripped(address) view returns (bool)',
  'function amount() view returns (uint256)',
  'function relayer() view returns (address)',
  'event Dripped(address indexed to, uint256 amount)',
  'error NotRelayer()',
  'error AlreadyDripped()',
  'error Empty()',
];

// What a revert means, in words the page can show.
export const ERROR_TEXT = {
  MarketClosed: 'This market has closed.',
  Slippage: 'The price moved before your trade landed. Try again.',
  NothingToPay: 'Nothing to collect here.',
  NotResolved: 'This market has not settled yet.',
  BadParams: 'That trade is not allowed.',
  BadQuote: 'This price quote has expired or was already used. Get a new quote.',
  CapReached: 'This market (or this ship) has reached its limit.',
  VaultShort: 'The underwriting vault does not have enough free MON right now.',
  TooEarly: 'Too early: the oracle still has time to settle this market.',
  AlreadyDripped: 'This wallet already got its gas.',
  Empty: 'The gas faucet is empty.',
};

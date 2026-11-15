// Human-readable ABIs for contracts/src/Markets.sol and Faucet.sol.
// Plain strings (no imports) so both the page and Node scripts can use them: pass to viem's parseAbi.
// Keep in step with the Solidity if a signature changes.

export const MARKETS_ABI = [
  'struct Market { address creator; uint64 closeTime; uint16 feeBps; bool isAbove; bool resolved; bool outcomeYes; string series; int256 threshold; int256 value; uint256 yesReserve; uint256 noReserve; uint256 lpSupply; uint256 feesPerLp; string question; }',

  'function createMarket(string question, string series, int256 threshold, bool isAbove, uint64 closeTime, uint16 feeBps, uint16 priorYesBps) payable returns (uint256 id)',
  'function buy(uint256 id, bool yes, uint256 minShares) payable returns (uint256 shares)',
  'function sell(uint256 id, bool yes, uint256 shares, uint256 minOut) returns (uint256 out)',
  'function addLiquidity(uint256 id) payable',
  'function removeLiquidity(uint256 id, uint256 lp)',
  'function resolve(uint256 id, int256 value)',
  'function redeem(uint256 id) returns (uint256 amount)',
  'function claimFees(uint256 id) returns (uint256 amount)',
  'function setOracle(address oracle)',

  'function getMarket(uint256 id) view returns (Market)',
  'function marketCount() view returns (uint256)',
  'function priceYes(uint256 id) view returns (uint256)',
  'function quoteBuy(uint256 id, bool yes, uint256 amount) view returns (uint256)',
  'function quoteSell(uint256 id, bool yes, uint256 shares) view returns (uint256)',
  'function costForShares(uint256 id, bool yes, uint256 shares) view returns (uint256)',
  'function accounts(uint256 id, address who) view returns (uint256 yes, uint256 no, uint256 lp, uint256 feeDebt, uint256 feesOwed)',
  'function pendingFees(uint256 id, address who) view returns (uint256)',
  'function oracle() view returns (address)',
  'function owner() view returns (address)',
  'function MIN_SEED() view returns (uint256)',

  'event MarketCreated(uint256 indexed id, address indexed creator, string series, string question, int256 threshold, bool isAbove, uint64 closeTime, uint16 feeBps, uint256 seed, uint256 priceYes)',
  'event Trade(uint256 indexed id, address indexed who, bool yes, bool isBuy, uint256 amount, uint256 shares, uint256 fee, uint256 yesReserve, uint256 noReserve, uint256 priceYes)',
  'event LiquidityAdded(uint256 indexed id, address indexed who, uint256 amount, uint256 lpMinted)',
  'event LiquidityRemoved(uint256 indexed id, address indexed who, uint256 lpBurned, uint256 yesOut, uint256 noOut)',
  'event MarketResolved(uint256 indexed id, int256 value, bool outcomeYes)',
  'event Redeemed(uint256 indexed id, address indexed who, uint256 amount)',
  'event FeesClaimed(uint256 indexed id, address indexed who, uint256 amount)',
  'event OracleChanged(address oracle)',

  'error NotOwner()',
  'error NotOracle()',
  'error BadParams()',
  'error MarketClosed()',
  'error NotClosed()',
  'error AlreadyResolved()',
  'error NotResolved()',
  'error Slippage()',
  'error NothingToPay()',
  'error TransferFailed()',
];

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
  AlreadyDripped: 'This wallet already got its gas.',
  Empty: 'The gas faucet is empty.',
};

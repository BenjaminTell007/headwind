// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Headway binary prediction markets, priced by a fixed-product market maker (FPMM)
/// @notice Every market is collateralised in native MON. 1 MON mints one complete set
///         (1 YES share + 1 NO share, each 1e18 units). The winning share redeems for 1 MON.
///         The pool holds YES and NO reserves y and n with y * n = k. Price(YES) = n / (y + n).
///         Math and worked examples: contracts/README.md. Integer reference model: contracts/model/fpmm.py.
/// @dev Written for Monad's parallel execution: every trade touches only its own market's
///      slots and the trader's own balances. No global counters, no global reentrancy lock
///      (checks-effects-interactions instead), so trades on different markets never conflict.
contract Markets {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 public constant MAX_FEE_BPS = 500; // 5%
    uint256 public constant MIN_SEED = 0.01 ether; // 0.01 MON

    struct Market {
        address creator;
        uint64 closeTime;
        uint16 feeBps;
        bool isAbove;
        bool resolved;
        bool outcomeYes;
        string series;
        int256 threshold;
        int256 value;
        uint256 yesReserve;
        uint256 noReserve;
        uint256 lpSupply;
        uint256 feesPerLp; // accumulated fees per LP share, scaled by 1e18
        string question;
    }

    struct Account {
        uint256 yes;
        uint256 no;
        uint256 lp;
        uint256 feeDebt; // lp * feesPerLp / 1e18 at last settlement
        uint256 feesOwed; // settled, unclaimed fees in wei
    }

    address public owner;
    address public oracle;
    uint256 public marketCount;

    mapping(uint256 => Market) internal _markets;
    mapping(uint256 => mapping(address => Account)) public accounts;

    event MarketCreated(
        uint256 indexed id,
        address indexed creator,
        string series,
        string question,
        int256 threshold,
        bool isAbove,
        uint64 closeTime,
        uint16 feeBps,
        uint256 seed,
        uint256 priceYes
    );
    /// @param isBuy true for a buy (amount = MON paid in), false for a sell (amount = MON paid out)
    /// @param priceYes price of YES after the trade, 1e18 = 100%
    event Trade(
        uint256 indexed id,
        address indexed who,
        bool yes,
        bool isBuy,
        uint256 amount,
        uint256 shares,
        uint256 fee,
        uint256 yesReserve,
        uint256 noReserve,
        uint256 priceYes
    );
    event LiquidityAdded(uint256 indexed id, address indexed who, uint256 amount, uint256 lpMinted);
    event LiquidityRemoved(uint256 indexed id, address indexed who, uint256 lpBurned, uint256 yesOut, uint256 noOut);
    event MarketResolved(uint256 indexed id, int256 value, bool outcomeYes);
    event Redeemed(uint256 indexed id, address indexed who, uint256 amount);
    event FeesClaimed(uint256 indexed id, address indexed who, uint256 amount);
    event OracleChanged(address oracle);

    error NotOwner();
    error NotOracle();
    error BadParams();
    error MarketClosed();
    error NotClosed();
    error AlreadyResolved();
    error NotResolved();
    error Slippage();
    error NothingToPay();
    error TransferFailed();

    constructor(address oracle_) {
        owner = msg.sender;
        oracle = oracle_ == address(0) ? msg.sender : oracle_;
    }

    // ------------------------------------------------------------------ admin

    function setOracle(address oracle_) external {
        if (msg.sender != owner) revert NotOwner();
        oracle = oracle_;
        emit OracleChanged(oracle_);
    }

    // --------------------------------------------------------------- creation

    /// @notice Open a market. Anyone can, by seeding it with at least MIN_SEED MON.
    /// @param priorYesBps starting price of YES in basis points (100 to 9900)
    /// @dev The seed mints `seed` complete sets. The pool keeps them at the ratio that sets
    ///      price(YES) = prior, and the creator receives the leftover shares of the cheap side's
    ///      opposite, so the creator's total exposure is exactly the seed.
    function createMarket(
        string calldata question,
        string calldata series,
        int256 threshold,
        bool isAbove,
        uint64 closeTime,
        uint16 feeBps,
        uint16 priorYesBps
    ) external payable returns (uint256 id) {
        uint256 seed = msg.value;
        if (seed < MIN_SEED || closeTime <= block.timestamp || feeBps > MAX_FEE_BPS) revert BadParams();
        if (priorYesBps < 100 || priorYesBps > 9_900) revert BadParams();

        id = marketCount++;
        Market storage m = _markets[id];
        m.creator = msg.sender;
        m.closeTime = closeTime;
        m.feeBps = feeBps;
        m.isAbove = isAbove;
        m.series = series;
        m.threshold = threshold;
        m.question = question;

        Account storage a = accounts[id][msg.sender];
        if (priorYesBps >= BPS / 2) {
            m.noReserve = seed;
            m.yesReserve = (seed * (BPS - priorYesBps)) / priorYesBps;
            a.yes = seed - m.yesReserve;
        } else {
            m.yesReserve = seed;
            m.noReserve = (seed * priorYesBps) / (BPS - priorYesBps);
            a.no = seed - m.noReserve;
        }
        m.lpSupply = seed;
        a.lp = seed;

        emit MarketCreated(
            id, msg.sender, series, question, threshold, isAbove, closeTime, feeBps, seed, _priceYes(m)
        );
    }

    // -------------------------------------------------------------- liquidity

    /// @notice Add MON to a market's pool, keeping its current price. Shares the pool can't
    ///         absorb at the current ratio are returned to you as outcome shares.
    function addLiquidity(uint256 id) external payable {
        Market storage m = _open(id);
        uint256 x = msg.value;
        if (x == 0) revert BadParams();
        Account storage a = accounts[id][msg.sender];
        _settleFees(m, a);

        uint256 y = m.yesReserve;
        uint256 n = m.noReserve;
        uint256 w = y > n ? y : n;
        uint256 yAdd = (x * y) / w;
        uint256 nAdd = (x * n) / w;
        uint256 minted = (x * m.lpSupply) / w;

        m.yesReserve = y + yAdd;
        m.noReserve = n + nAdd;
        m.lpSupply += minted;
        a.yes += x - yAdd;
        a.no += x - nAdd;
        a.lp += minted;
        a.feeDebt = (a.lp * m.feesPerLp) / WAD;

        emit LiquidityAdded(id, msg.sender, x, minted);
    }

    /// @notice Withdraw your share of the pool as YES and NO shares (any time, including after
    ///         resolution). Redeem the winning shares with redeem().
    function removeLiquidity(uint256 id, uint256 lp) external {
        Market storage m = _markets[id];
        Account storage a = accounts[id][msg.sender];
        if (lp == 0 || lp > a.lp) revert BadParams();
        _settleFees(m, a);

        uint256 yOut = (m.yesReserve * lp) / m.lpSupply;
        uint256 nOut = (m.noReserve * lp) / m.lpSupply;
        m.yesReserve -= yOut;
        m.noReserve -= nOut;
        m.lpSupply -= lp;
        a.lp -= lp;
        a.yes += yOut;
        a.no += nOut;
        a.feeDebt = (a.lp * m.feesPerLp) / WAD;

        emit LiquidityRemoved(id, msg.sender, lp, yOut, nOut);
    }

    // ----------------------------------------------------------------- trading

    /// @notice Buy YES or NO with the MON sent.
    /// @param minShares revert if fewer shares would come out (slippage guard)
    function buy(uint256 id, bool yes, uint256 minShares) external payable returns (uint256 shares) {
        Market storage m = _open(id);
        uint256 amount = msg.value;
        if (amount == 0) revert BadParams();

        uint256 fee = (amount * m.feeBps) / BPS;
        uint256 x = amount - fee;
        uint256 y = m.yesReserve;
        uint256 n = m.noReserve;
        uint256 k = y * n;

        // x MON mints x complete sets into the pool, then the pool pays out the bought side
        // until y * n is back to k (rounded so k never falls).
        if (yes) {
            uint256 n1 = n + x;
            uint256 y1 = _ceilDiv(k, n1);
            shares = y + x - y1;
            m.yesReserve = y1;
            m.noReserve = n1;
            accounts[id][msg.sender].yes += shares;
        } else {
            uint256 y1 = y + x;
            uint256 n1 = _ceilDiv(k, y1);
            shares = n + x - n1;
            m.yesReserve = y1;
            m.noReserve = n1;
            accounts[id][msg.sender].no += shares;
        }
        if (shares < minShares || shares == 0) revert Slippage();
        if (fee > 0) m.feesPerLp += (fee * WAD) / m.lpSupply;

        emit Trade(id, msg.sender, yes, true, amount, shares, fee, m.yesReserve, m.noReserve, _priceYes(m));
    }

    /// @notice Sell YES or NO shares back to the pool for MON.
    /// @param minOut revert if less MON (after fees) would come back
    function sell(uint256 id, bool yes, uint256 shares, uint256 minOut) external returns (uint256 out) {
        Market storage m = _open(id);
        Account storage a = accounts[id][msg.sender];
        if (shares == 0) revert BadParams();
        if (yes) a.yes -= shares; // reverts on underflow
        else a.no -= shares;

        (uint256 sold, uint256 other) = yes ? (m.yesReserve, m.noReserve) : (m.noReserve, m.yesReserve);
        // Pool takes the shares, burns r complete sets and pays r MON:
        // (sold + s - r)(other - r) = sold * other
        // r = (B - sqrt(B^2 - 4 s other)) / 2,  B = sold + s + other   (smaller root, so r < other)
        uint256 B = sold + shares + other;
        uint256 r = (B - _ceilSqrt(B * B - 4 * shares * other)) / 2; // rounds r down, k never falls
        sold = sold + shares - r;
        other = other - r;
        if (yes) (m.yesReserve, m.noReserve) = (sold, other);
        else (m.noReserve, m.yesReserve) = (sold, other);

        uint256 fee = (r * m.feeBps) / BPS;
        out = r - fee;
        if (out < minOut || out == 0) revert Slippage();
        if (fee > 0) m.feesPerLp += (fee * WAD) / m.lpSupply;

        emit Trade(id, msg.sender, yes, false, out, shares, fee, m.yesReserve, m.noReserve, _priceYes(m));
        _pay(msg.sender, out);
    }

    // -------------------------------------------------------------- settlement

    /// @notice Post the official number. Oracle only, after the market closes.
    function resolve(uint256 id, int256 value) external {
        if (msg.sender != oracle) revert NotOracle();
        Market storage m = _markets[id];
        if (m.creator == address(0)) revert BadParams(); // no such market
        if (block.timestamp < m.closeTime) revert NotClosed();
        if (m.resolved) revert AlreadyResolved();
        m.resolved = true;
        m.value = value;
        m.outcomeYes = m.isAbove ? value >= m.threshold : value < m.threshold;
        emit MarketResolved(id, value, m.outcomeYes);
    }

    /// @notice Cash in winning shares, 1 MON per share. Losing shares are cleared.
    function redeem(uint256 id) external returns (uint256 amount) {
        Market storage m = _markets[id];
        if (!m.resolved) revert NotResolved();
        Account storage a = accounts[id][msg.sender];
        amount = m.outcomeYes ? a.yes : a.no;
        a.yes = 0;
        a.no = 0;
        if (amount == 0) revert NothingToPay();
        emit Redeemed(id, msg.sender, amount);
        _pay(msg.sender, amount);
    }

    /// @notice Withdraw trading fees earned as a liquidity provider.
    function claimFees(uint256 id) external returns (uint256 amount) {
        Market storage m = _markets[id];
        Account storage a = accounts[id][msg.sender];
        _settleFees(m, a);
        amount = a.feesOwed;
        if (amount == 0) revert NothingToPay();
        a.feesOwed = 0;
        emit FeesClaimed(id, msg.sender, amount);
        _pay(msg.sender, amount);
    }

    // ------------------------------------------------------------------- views

    function getMarket(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    /// @notice Price of YES, 1e18 = 100%. Read it as the market's probability of YES.
    function priceYes(uint256 id) external view returns (uint256) {
        return _priceYes(_markets[id]);
    }

    /// @notice Shares you'd get for `amount` MON.
    function quoteBuy(uint256 id, bool yes, uint256 amount) external view returns (uint256) {
        Market storage m = _markets[id];
        uint256 x = amount - (amount * m.feeBps) / BPS;
        (uint256 a, uint256 b) = yes ? (m.yesReserve, m.noReserve) : (m.noReserve, m.yesReserve);
        return a + x - _ceilDiv(a * b, b + x);
    }

    /// @notice MON (after fees) you'd get for selling `shares`.
    function quoteSell(uint256 id, bool yes, uint256 shares) external view returns (uint256) {
        Market storage m = _markets[id];
        (uint256 a, uint256 b) = yes ? (m.yesReserve, m.noReserve) : (m.noReserve, m.yesReserve);
        uint256 B = a + shares + b;
        uint256 r = (B - _ceilSqrt(B * B - 4 * shares * b)) / 2;
        return r - (r * m.feeBps) / BPS;
    }

    /// @notice MON to send to buy at least `shares` of a side. The hedge panel uses this:
    ///         to cover a loss of L MON if YES happens, buy L YES shares.
    function costForShares(uint256 id, bool yes, uint256 shares) external view returns (uint256) {
        Market storage m = _markets[id];
        (uint256 a, uint256 b) = yes ? (m.yesReserve, m.noReserve) : (m.noReserve, m.yesReserve);
        if (shares >= a + b) revert BadParams(); // not enough depth, guard keeps c positive
        // (a + x - S)(b + x) = a b  ->  x^2 + (a + b - S) x - b S = 0
        uint256 c = a + b - shares;
        uint256 x = (_ceilSqrt(c * c + 4 * b * shares) - c + 1) / 2;
        return _ceilDiv(x * BPS, BPS - m.feeBps);
    }

    /// @notice Trading fees `who` has earned as a liquidity provider in one market, unclaimed.
    function pendingFees(uint256 id, address who) external view returns (uint256) {
        Market storage m = _markets[id];
        Account storage a = accounts[id][who];
        return a.feesOwed + (a.lp * m.feesPerLp) / WAD - a.feeDebt;
    }

    // ---------------------------------------------------------------- internal

    function _open(uint256 id) internal view returns (Market storage m) {
        m = _markets[id];
        if (m.lpSupply == 0) revert BadParams(); // unknown market or pool drained
        if (m.resolved || block.timestamp >= m.closeTime) revert MarketClosed();
    }

    function _settleFees(Market storage m, Account storage a) internal {
        uint256 accrued = (a.lp * m.feesPerLp) / WAD;
        a.feesOwed += accrued - a.feeDebt;
        a.feeDebt = accrued;
    }

    function _priceYes(Market storage m) internal view returns (uint256) {
        uint256 total = m.yesReserve + m.noReserve;
        return total == 0 ? 0 : (m.noReserve * WAD) / total;
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _ceilSqrt(uint256 x) internal pure returns (uint256 r) {
        if (x == 0) return 0;
        r = _sqrt(x);
        if (r * r < x) r += 1;
    }

    /// @dev floor(sqrt(x)), Babylonian method seeded from the bit length.
    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        uint256 y = x;
        z = 1;
        if (y >= 1 << 128) { y >>= 128; z <<= 64; }
        if (y >= 1 << 64) { y >>= 64; z <<= 32; }
        if (y >= 1 << 32) { y >>= 32; z <<= 16; }
        if (y >= 1 << 16) { y >>= 16; z <<= 8; }
        if (y >= 1 << 8) { y >>= 8; z <<= 4; }
        if (y >= 1 << 4) { y >>= 4; z <<= 2; }
        if (y >= 1 << 2) { z <<= 1; }
        z = (3 * z) >> 1;
        for (uint256 i = 0; i < 7; i++) z = (z + x / z) >> 1;
        uint256 zz = x / z;
        if (zz < z) z = zz;
    }
}

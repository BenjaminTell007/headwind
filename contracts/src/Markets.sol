// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Headway: shipping-delay prediction markets, underwritten by a shared vault
/// @notice
///  - Anyone can open a market (on a ship's arrival, a port, a strait...) with a quote signed by
///    the pricing server. The quote fixes the terms and the starting price, which the model
///    computes from the ship's position, weather, strait disruption, port congestion and trade data.
///  - The underwriter vault seeds each new market's pool at that price. Underwriters deposit MON
///    into the vault and earn its trading fees and the premiums hedgers pay; they carry the risk.
///  - After that, trading moves the price: a fixed-product market maker (y * n = k), price(YES) = n / (y + n).
///  - The oracle settles each market on the measured number (for arrivals: the arrival time).
///    It can settle early once the outcome is known, or call a market invalid. If it never settles,
///    anyone can call the market invalid after `resolveBy`, so money is never stuck.
///  - Collateral is native MON. 1 MON = one complete set (1 YES + 1 NO share). A winning share pays 1 MON,
///    and in an invalid market every share pays 0.5 MON.
///  Math: contracts/README.md. Integer model: contracts/model/fpmm.py.
/// @dev Monad parallel execution: a trade writes only its market's struct and the trader's own account.
///      Vault totals and per-subject exposure change only on create and settle, never on a trade.
contract Markets {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint256 public constant MAX_FEE_BPS = 500;

    uint8 public constant OPEN = 0;
    uint8 public constant YES = 1;
    uint8 public constant NO = 2;
    uint8 public constant INVALID = 3;

    /// @notice Terms of a market, signed by the pricing server.
    struct Quote {
        string question;
        string series; // e.g. "arrival:9811000:NLRTM", "portwatch:Suez Canal:weekly_transits"
        bytes32 subject; // what the per-subject cap applies to, e.g. keccak256("imo:9811000")
        int256 threshold; // for arrivals: the deadline, unix seconds
        bool isAbove; // YES if value >= threshold (true) or value < threshold (false)
        uint64 closeTime; // trading stops
        uint64 resolveBy; // if not settled by then, anyone can call it invalid
        uint16 feeBps;
        uint16 priorYesBps; // starting price from the model
        uint256 seed; // MON the vault puts in the pool
        uint256 maxCollateral; // cap on MON in this market (the per-ship stake cap)
        uint256 creationFee; // MON the creator pays the vault for opening it
        uint64 expiry; // quote is good until
        bytes32 quoteId; // single use
    }

    struct Market {
        address creator;
        uint64 closeTime;
        uint64 resolveBy;
        uint16 feeBps;
        uint8 outcome;
        bool isAbove;
        bool vaultSettled;
        bytes32 subject;
        int256 threshold;
        int256 value;
        uint256 yesReserve;
        uint256 noReserve;
        uint256 lpSupply;
        uint256 feesPerLp;
        uint256 collateral; // complete sets outstanding (MON backing the shares)
        uint256 maxCollateral;
        uint256 vaultSeed;
        string series;
        string question;
    }

    struct Account {
        uint256 yes;
        uint256 no;
        uint256 lp;
        uint256 feeDebt;
        uint256 feesOwed;
    }

    // ---------------------------------------------------------------- roles
    address public owner;
    address public oracle; // settles markets
    address public pricer; // signs quotes

    // ---------------------------------------------------------------- markets
    uint256 public marketCount;
    mapping(uint256 => Market) internal _markets;
    mapping(uint256 => mapping(address => Account)) public accounts;
    mapping(bytes32 => bool) public quoteUsed;

    // ---------------------------------------------------------------- vault
    uint256 public vaultIdle; // MON in the vault, not in any market
    uint256 public vaultDeployed; // MON seeded into markets not yet settled (at cost)
    uint256 public vaultTotalShares;
    mapping(address => uint256) public vaultShares;
    mapping(bytes32 => uint256) public subjectExposure; // vault seed at risk per subject
    uint256 public subjectCap; // max vault seed per subject (per ship, per port...)

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(string question,string series,bytes32 subject,int256 threshold,bool isAbove,uint64 closeTime,uint64 resolveBy,uint16 feeBps,uint16 priorYesBps,uint256 seed,uint256 maxCollateral,uint256 creationFee,uint64 expiry,bytes32 quoteId)"
    );

    // ---------------------------------------------------------------- events
    event MarketCreated(
        uint256 indexed id,
        address indexed creator,
        bytes32 indexed subject,
        string series,
        string question,
        int256 threshold,
        bool isAbove,
        uint64 closeTime,
        uint256 seed,
        uint256 priceYes
    );
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
    event MarketResolved(uint256 indexed id, int256 value, uint8 outcome);
    event Redeemed(uint256 indexed id, address indexed who, uint256 amount);
    event FeesClaimed(uint256 indexed id, address indexed who, uint256 amount);
    event VaultDeposit(address indexed who, uint256 amount, uint256 shares);
    event VaultWithdraw(address indexed who, uint256 amount, uint256 shares);
    event VaultSettled(uint256 indexed id, uint256 seed, uint256 returned);
    event RolesChanged(address oracle, address pricer, uint256 subjectCap);

    error NotOwner();
    error NotOracle();
    error BadParams();
    error BadQuote();
    error MarketClosed();
    error NotResolved();
    error AlreadyResolved();
    error TooEarly();
    error Slippage();
    error CapReached();
    error VaultShort();
    error NothingToPay();
    error TransferFailed();

    constructor(address oracle_, address pricer_, uint256 subjectCap_) payable {
        owner = msg.sender;
        oracle = oracle_ == address(0) ? msg.sender : oracle_;
        pricer = pricer_ == address(0) ? msg.sender : pricer_;
        subjectCap = subjectCap_;
        if (msg.value > 0) _deposit(msg.sender, msg.value);
    }

    function setRoles(address oracle_, address pricer_, uint256 subjectCap_) external {
        if (msg.sender != owner) revert NotOwner();
        oracle = oracle_;
        pricer = pricer_;
        subjectCap = subjectCap_;
        emit RolesChanged(oracle_, pricer_, subjectCap_);
    }

    // =============================================================== vault

    /// @notice Underwrite: deposit MON into the vault for a share of its results.
    function deposit() external payable returns (uint256 shares) {
        if (msg.value == 0) revert BadParams();
        return _deposit(msg.sender, msg.value);
    }

    /// @notice Withdraw vault shares for MON, at the vault's value, from MON not tied up in markets.
    function withdraw(uint256 shares) external returns (uint256 amount) {
        if (shares == 0 || shares > vaultShares[msg.sender]) revert BadParams();
        amount = (shares * vaultValue()) / vaultTotalShares;
        if (amount > vaultIdle) revert VaultShort();
        vaultShares[msg.sender] -= shares;
        vaultTotalShares -= shares;
        vaultIdle -= amount;
        emit VaultWithdraw(msg.sender, amount, shares);
        _pay(msg.sender, amount);
    }

    /// @notice Vault value: idle MON plus seeds in open markets at cost. Gains and losses land on settle.
    function vaultValue() public view returns (uint256) {
        return vaultIdle + vaultDeployed;
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        uint256 value = vaultValue();
        shares = vaultTotalShares == 0 || value == 0 ? amount : (amount * vaultTotalShares) / value;
        vaultShares[who] += shares;
        vaultTotalShares += shares;
        vaultIdle += amount;
        emit VaultDeposit(who, amount, shares);
    }

    /// @notice After a market settles, pull the vault's liquidity, winnings and fees back into the vault.
    ///         Anyone can call it.
    function settleVault(uint256 id) external returns (uint256 returned) {
        Market storage m = _markets[id];
        if (m.outcome == OPEN) revert NotResolved();
        if (m.vaultSettled) revert AlreadyResolved();
        m.vaultSettled = true;
        address v = address(this);
        Account storage a = accounts[id][v];
        if (a.lp > 0) _removeLiquidity(m, id, v, a.lp);
        _settleFees(m, a);
        returned = _redeemable(m, a) + a.feesOwed;
        a.yes = 0;
        a.no = 0;
        a.feesOwed = 0;
        vaultDeployed -= m.vaultSeed;
        subjectExposure[m.subject] -= m.vaultSeed;
        vaultIdle += returned;
        emit VaultSettled(id, m.vaultSeed, returned);
    }

    // =============================================================== creation

    /// @notice EIP-712 digest the pricer signs for a quote.
    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                keccak256(bytes(q.question)),
                keccak256(bytes(q.series)),
                q.subject,
                q.threshold,
                q.isAbove,
                q.closeTime,
                q.resolveBy,
                q.feeBps,
                q.priorYesBps,
                q.seed,
                q.maxCollateral,
                q.creationFee,
                q.expiry,
                q.quoteId
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Headway"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// @notice Open a market from a signed quote. The vault seeds it at the quoted price.
    ///         Send `creationFee`, plus anything above it to buy straight away (a hedger buys YES
    ///         in the same transaction).
    /// @param buyYes side to buy with msg.value - creationFee, if any
    /// @param minShares slippage guard for that buy
    function createMarket(Quote calldata q, bytes calldata sig, bool buyYes, uint256 minShares)
        external
        payable
        returns (uint256 id)
    {
        if (block.timestamp > q.expiry || quoteUsed[q.quoteId]) revert BadQuote();
        if (_recover(quoteDigest(q), sig) != pricer) revert BadQuote();
        if (q.closeTime <= block.timestamp || q.resolveBy < q.closeTime || q.feeBps > MAX_FEE_BPS) revert BadParams();
        if (q.priorYesBps < 100 || q.priorYesBps > 9_900 || q.seed == 0 || q.maxCollateral < q.seed) revert BadParams();
        if (msg.value < q.creationFee) revert BadParams();
        if (q.seed > vaultIdle) revert VaultShort();
        if (subjectExposure[q.subject] + q.seed > subjectCap) revert CapReached();
        quoteUsed[q.quoteId] = true;

        vaultIdle -= q.seed;
        vaultIdle += q.creationFee;
        vaultDeployed += q.seed;
        subjectExposure[q.subject] += q.seed;

        id = marketCount++;
        Market storage m = _markets[id];
        m.creator = msg.sender;
        m.closeTime = q.closeTime;
        m.resolveBy = q.resolveBy;
        m.feeBps = q.feeBps;
        m.isAbove = q.isAbove;
        m.subject = q.subject;
        m.threshold = q.threshold;
        m.maxCollateral = q.maxCollateral;
        m.vaultSeed = q.seed;
        m.collateral = q.seed;
        m.series = q.series;
        m.question = q.question;

        // Seed: `seed` complete sets, pool kept at the ratio that prices YES at the prior.
        // Leftover shares of one side stay with the vault.
        Account storage v = accounts[id][address(this)];
        uint256 s = q.seed;
        if (q.priorYesBps >= BPS / 2) {
            m.noReserve = s;
            m.yesReserve = (s * (BPS - q.priorYesBps)) / q.priorYesBps;
            v.yes = s - m.yesReserve;
        } else {
            m.yesReserve = s;
            m.noReserve = (s * q.priorYesBps) / (BPS - q.priorYesBps);
            v.no = s - m.noReserve;
        }
        m.lpSupply = s;
        v.lp = s;

        emit MarketCreated(
            id, msg.sender, q.subject, q.series, q.question, q.threshold, q.isAbove, q.closeTime, s, _priceYes(m)
        );

        uint256 stake = msg.value - q.creationFee;
        if (stake > 0) _buy(m, id, msg.sender, buyYes, stake, minShares);
    }

    // =============================================================== liquidity

    function addLiquidity(uint256 id) external payable {
        Market storage m = _open(id);
        uint256 x = msg.value;
        if (x == 0) revert BadParams();
        if (m.collateral + x > m.maxCollateral) revert CapReached();
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
        m.collateral += x;
        a.yes += x - yAdd;
        a.no += x - nAdd;
        a.lp += minted;
        a.feeDebt = (a.lp * m.feesPerLp) / WAD;
        emit LiquidityAdded(id, msg.sender, x, minted);
    }

    function removeLiquidity(uint256 id, uint256 lp) external {
        Market storage m = _markets[id];
        if (lp == 0 || lp > accounts[id][msg.sender].lp) revert BadParams();
        _removeLiquidity(m, id, msg.sender, lp);
    }

    function _removeLiquidity(Market storage m, uint256 id, address who, uint256 lp) internal {
        Account storage a = accounts[id][who];
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
        emit LiquidityRemoved(id, who, lp, yOut, nOut);
    }

    // =============================================================== trading

    function buy(uint256 id, bool yes, uint256 minShares) external payable returns (uint256) {
        if (msg.value == 0) revert BadParams();
        return _buy(_open(id), id, msg.sender, yes, msg.value, minShares);
    }

    function _buy(Market storage m, uint256 id, address who, bool yes, uint256 amount, uint256 minShares)
        internal
        returns (uint256 shares)
    {
        uint256 fee = (amount * m.feeBps) / BPS;
        uint256 x = amount - fee;
        if (m.collateral + x > m.maxCollateral) revert CapReached();
        m.collateral += x;
        uint256 y = m.yesReserve;
        uint256 n = m.noReserve;
        uint256 k = y * n;
        if (yes) {
            uint256 n1 = n + x;
            uint256 y1 = _ceilDiv(k, n1);
            shares = y + x - y1;
            m.yesReserve = y1;
            m.noReserve = n1;
            accounts[id][who].yes += shares;
        } else {
            uint256 y1 = y + x;
            uint256 n1 = _ceilDiv(k, y1);
            shares = n + x - n1;
            m.yesReserve = y1;
            m.noReserve = n1;
            accounts[id][who].no += shares;
        }
        if (shares < minShares || shares == 0) revert Slippage();
        if (fee > 0) m.feesPerLp += (fee * WAD) / m.lpSupply;
        emit Trade(id, who, yes, true, amount, shares, fee, m.yesReserve, m.noReserve, _priceYes(m));
    }

    function sell(uint256 id, bool yes, uint256 shares, uint256 minOut) external returns (uint256 out) {
        Market storage m = _open(id);
        Account storage a = accounts[id][msg.sender];
        if (shares == 0) revert BadParams();
        if (yes) a.yes -= shares;
        else a.no -= shares;

        (uint256 sold, uint256 other) = yes ? (m.yesReserve, m.noReserve) : (m.noReserve, m.yesReserve);
        // (sold + s - r)(other - r) = sold * other ; r = (B - sqrt(B^2 - 4 s other)) / 2
        uint256 B = sold + shares + other;
        uint256 r = (B - _ceilSqrt(B * B - 4 * shares * other)) / 2;
        sold = sold + shares - r;
        other = other - r;
        if (yes) (m.yesReserve, m.noReserve) = (sold, other);
        else (m.noReserve, m.yesReserve) = (sold, other);
        m.collateral -= r;

        uint256 fee = (r * m.feeBps) / BPS;
        out = r - fee;
        if (out < minOut || out == 0) revert Slippage();
        if (fee > 0) m.feesPerLp += (fee * WAD) / m.lpSupply;
        emit Trade(id, msg.sender, yes, false, out, shares, fee, m.yesReserve, m.noReserve, _priceYes(m));
        _pay(msg.sender, out);
    }

    // =============================================================== settlement

    /// @notice Post the measured number. Oracle only. Allowed before closeTime too, because an
    ///         arrival can settle a market early (a ship that docks before the deadline is on time).
    function resolve(uint256 id, int256 value) external {
        if (msg.sender != oracle) revert NotOracle();
        Market storage m = _markets[id];
        if (m.creator == address(0)) revert BadParams();
        if (m.outcome != OPEN) revert AlreadyResolved();
        m.value = value;
        bool yes = m.isAbove ? value >= m.threshold : value < m.threshold;
        m.outcome = yes ? YES : NO;
        emit MarketResolved(id, value, m.outcome);
    }

    /// @notice Call a market invalid: every share pays 0.5 MON. The oracle can at any time
    ///         (data never arrived, ship went dark); anyone can once `resolveBy` has passed.
    function resolveInvalid(uint256 id) external {
        Market storage m = _markets[id];
        if (m.creator == address(0)) revert BadParams();
        if (m.outcome != OPEN) revert AlreadyResolved();
        if (msg.sender != oracle && block.timestamp < m.resolveBy) revert TooEarly();
        m.outcome = INVALID;
        emit MarketResolved(id, 0, INVALID);
    }

    /// @notice Cash in shares after settlement.
    function redeem(uint256 id) external returns (uint256 amount) {
        Market storage m = _markets[id];
        if (m.outcome == OPEN) revert NotResolved();
        Account storage a = accounts[id][msg.sender];
        amount = _redeemable(m, a);
        a.yes = 0;
        a.no = 0;
        if (amount == 0) revert NothingToPay();
        emit Redeemed(id, msg.sender, amount);
        _pay(msg.sender, amount);
    }

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

    // =============================================================== views

    function getMarket(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    function priceYes(uint256 id) external view returns (uint256) {
        return _priceYes(_markets[id]);
    }

    function quoteBuy(uint256 id, bool yes, uint256 amount) external view returns (uint256) {
        Market storage m = _markets[id];
        uint256 x = amount - (amount * m.feeBps) / BPS;
        (uint256 a, uint256 b) = yes ? (m.yesReserve, m.noReserve) : (m.noReserve, m.yesReserve);
        return a + x - _ceilDiv(a * b, b + x);
    }

    function quoteSell(uint256 id, bool yes, uint256 shares) external view returns (uint256) {
        Market storage m = _markets[id];
        (uint256 a, uint256 b) = yes ? (m.yesReserve, m.noReserve) : (m.noReserve, m.yesReserve);
        uint256 B = a + shares + b;
        uint256 r = (B - _ceilSqrt(B * B - 4 * shares * b)) / 2;
        return r - (r * m.feeBps) / BPS;
    }

    /// @notice MON to send to buy at least `shares` of a side: the cost of a hedge that pays `shares` MON.
    function costForShares(uint256 id, bool yes, uint256 shares) external view returns (uint256) {
        Market storage m = _markets[id];
        (uint256 a, uint256 b) = yes ? (m.yesReserve, m.noReserve) : (m.noReserve, m.yesReserve);
        if (shares >= a + b) revert BadParams();
        uint256 c = a + b - shares;
        uint256 x = (_ceilSqrt(c * c + 4 * b * shares) - c + 1) / 2;
        return _ceilDiv(x * BPS, BPS - m.feeBps);
    }

    function pendingFees(uint256 id, address who) external view returns (uint256) {
        Market storage m = _markets[id];
        Account storage a = accounts[id][who];
        return a.feesOwed + (a.lp * m.feesPerLp) / WAD - a.feeDebt;
    }

    // =============================================================== internal

    function _open(uint256 id) internal view returns (Market storage m) {
        m = _markets[id];
        if (m.lpSupply == 0) revert BadParams();
        if (m.outcome != OPEN || block.timestamp >= m.closeTime) revert MarketClosed();
    }

    function _redeemable(Market storage m, Account storage a) internal view returns (uint256) {
        if (m.outcome == YES) return a.yes;
        if (m.outcome == NO) return a.no;
        return (a.yes + a.no) / 2; // INVALID
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

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // reject malleable signatures (upper half s)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
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

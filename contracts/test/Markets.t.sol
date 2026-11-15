// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Markets} from "../src/Markets.sol";
import {Faucet} from "../src/Faucet.sol";

contract MarketsTest is Test {
    Markets mk;
    uint256 pricerKey = 0xA11CE;
    address pricer;
    address oracle = makeAddr("oracle");
    address underwriter = makeAddr("underwriter");
    address hedger = makeAddr("hedger");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bytes32 constant SHIP = keccak256("imo:9811000");
    uint64 deadline;
    uint256 nonce;

    function setUp() public {
        pricer = vm.addr(pricerKey);
        mk = new Markets(oracle, pricer, 5 ether);
        deadline = uint64(vm.getBlockTimestamp() + 2 days);
        vm.deal(underwriter, 100 ether);
        vm.deal(hedger, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.prank(underwriter);
        mk.deposit{value: 50 ether}();
    }

    function _quote(uint16 prior, uint256 seed, bytes32 subject) internal returns (Markets.Quote memory q) {
        q = Markets.Quote({
            question: "Will EVER ALOT arrive at Rotterdam after Nov 17 12:00 UTC?",
            series: "arrival:9811000:NLRTM",
            subject: subject,
            threshold: int256(uint256(deadline)),
            isAbove: true,
            closeTime: deadline - 6 hours,
            resolveBy: deadline + 3 days,
            feeBps: 100,
            priorYesBps: prior,
            seed: seed,
            maxCollateral: 20 ether,
            creationFee: 0.01 ether,
            expiry: uint64(vm.getBlockTimestamp() + 5 minutes),
            quoteId: keccak256(abi.encode(nonce++))
        });
    }

    function _sign(Markets.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pricerKey, mk.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _create(uint16 prior) internal returns (uint256 id) {
        Markets.Quote memory q = _quote(prior, 2 ether, SHIP);
        bytes memory sig = _sign(q);
        vm.prank(hedger);
        id = mk.createMarket{value: q.creationFee}(q, sig, true, 0);
    }

    // ------------------------------------------------------------ quotes

    function test_createAtModelPrice() public {
        uint256 id = _create(3_000);
        assertApproxEqAbs(mk.priceYes(id), 0.3e18, 1e9);
        assertEq(mk.vaultDeployed(), 2 ether);
        assertEq(mk.vaultIdle(), 48 ether + 0.01 ether); // seed out, creation fee in
        assertEq(mk.subjectExposure(SHIP), 2 ether);
    }

    function test_hedgeInSameTx() public {
        Markets.Quote memory q = _quote(2_000, 2 ether, SHIP);
        bytes memory sig = _sign(q);
        vm.prank(hedger);
        uint256 id = mk.createMarket{value: q.creationFee + 0.5 ether}(q, sig, true, 1);
        (uint256 yes,,,,) = mk.accounts(id, hedger);
        assertGt(yes, 0.5 ether); // at ~20% odds, 0.5 MON buys well over 0.5 YES
        assertGt(mk.priceYes(id), 0.2e18);
    }

    function test_rejectsForgedQuote() public {
        Markets.Quote memory q = _quote(3_000, 2 ether, SHIP);
        bytes memory sig = _sign(q);
        q.priorYesBps = 9_000; // creator tampers with the price
        vm.prank(hedger);
        vm.expectRevert(Markets.BadQuote.selector);
        mk.createMarket{value: q.creationFee}(q, sig, true, 0);
    }

    function test_quoteSingleUseAndExpiry() public {
        Markets.Quote memory q = _quote(3_000, 1 ether, SHIP);
        bytes memory sig = _sign(q);
        vm.prank(hedger);
        mk.createMarket{value: q.creationFee}(q, sig, true, 0);
        vm.prank(hedger);
        vm.expectRevert(Markets.BadQuote.selector);
        mk.createMarket{value: q.creationFee}(q, sig, true, 0);

        Markets.Quote memory q2 = _quote(3_000, 1 ether, SHIP);
        bytes memory sig2 = _sign(q2);
        vm.warp(q2.expiry + 1);
        vm.prank(hedger);
        vm.expectRevert(Markets.BadQuote.selector);
        mk.createMarket{value: q2.creationFee}(q2, sig2, true, 0);
    }

    // ------------------------------------------------------------ caps

    function test_perShipCap() public {
        _create(3_000); // 2 MON on SHIP
        _create(3_000); // 4 MON
        Markets.Quote memory q = _quote(3_000, 2 ether, SHIP); // would be 6 > 5 cap
        bytes memory sig = _sign(q);
        vm.prank(hedger);
        vm.expectRevert(Markets.CapReached.selector);
        mk.createMarket{value: q.creationFee}(q, sig, true, 0);
    }

    function test_marketStakeCap() public {
        uint256 id = _create(5_000); // maxCollateral 20 MON, 2 seeded
        vm.prank(alice);
        mk.buy{value: 15 ether}(id, true, 0);
        vm.prank(bob);
        vm.expectRevert(Markets.CapReached.selector);
        mk.buy{value: 5 ether}(id, false, 0);
    }

    // ------------------------------------------------------------ trading

    function test_roundTripNeverProfits() public {
        uint256 id = _create(4_000);
        vm.startPrank(alice);
        uint256 shares = mk.buy{value: 1 ether}(id, true, 0);
        uint256 back = mk.sell(id, true, shares, 0);
        vm.stopPrank();
        assertLt(back, 1 ether);
    }

    function test_costForSharesCoversTarget() public {
        uint256 id = _create(2_500);
        uint256 cost = mk.costForShares(id, true, 1 ether);
        vm.prank(alice);
        uint256 got = mk.buy{value: cost}(id, true, 1 ether);
        assertGe(got, 1 ether);
    }

    function test_noTradingAfterClose() public {
        uint256 id = _create(5_000);
        vm.warp(deadline - 6 hours);
        vm.prank(alice);
        vm.expectRevert(Markets.MarketClosed.selector);
        mk.buy{value: 1 ether}(id, true, 0);
    }

    // ------------------------------------------------------------ settlement

    function test_lateArrivalPaysHedgerAndVaultSettles() public {
        Markets.Quote memory q = _quote(2_000, 2 ether, SHIP);
        bytes memory sig = _sign(q);
        vm.prank(hedger);
        uint256 id = mk.createMarket{value: q.creationFee + 0.5 ether}(q, sig, true, 0);
        vm.prank(alice);
        mk.buy{value: 1 ether}(id, false, 0); // alice bets it arrives on time

        // ship docks 9 hours after the deadline
        vm.warp(deadline + 9 hours);
        vm.prank(oracle);
        mk.resolve(id, int256(uint256(deadline + 9 hours)));

        (uint256 yes,,,,) = mk.accounts(id, hedger);
        uint256 before = hedger.balance;
        vm.prank(hedger);
        mk.redeem(id);
        assertEq(hedger.balance - before, yes);

        mk.settleVault(id);
        assertEq(mk.vaultDeployed(), 0);
        assertEq(mk.subjectExposure(SHIP), 0);
        vm.prank(alice);
        vm.expectRevert(Markets.NothingToPay.selector);
        mk.redeem(id);
        // everything owed has been paid or returned to the vault; contract holds vault idle + dust
        assertApproxEqAbs(address(mk).balance, mk.vaultIdle(), 1e6);
    }

    function test_earlyArrivalSettlesBeforeClose() public {
        uint256 id = _create(3_000);
        vm.warp(vm.getBlockTimestamp() + 1 days); // still before closeTime
        vm.prank(oracle);
        mk.resolve(id, int256(vm.getBlockTimestamp())); // docked, before the deadline: NO
        assertEq(mk.getMarket(id).outcome, mk.NO());
        vm.prank(alice);
        vm.expectRevert(Markets.MarketClosed.selector);
        mk.buy{value: 1 ether}(id, true, 0);
    }

    function test_invalidAfterTimeoutPaysHalf() public {
        uint256 id = _create(5_000);
        vm.prank(alice);
        uint256 s = mk.buy{value: 1 ether}(id, true, 0);
        vm.prank(bob);
        vm.expectRevert(Markets.TooEarly.selector);
        mk.resolveInvalid(id);

        vm.warp(deadline + 3 days);
        vm.prank(bob); // anyone, once resolveBy has passed
        mk.resolveInvalid(id);
        uint256 before = alice.balance;
        vm.prank(alice);
        mk.redeem(id);
        assertEq(alice.balance - before, s / 2);
        mk.settleVault(id);
    }

    function test_onlyOracleResolves() public {
        uint256 id = _create(5_000);
        vm.prank(alice);
        vm.expectRevert(Markets.NotOracle.selector);
        mk.resolve(id, 1);
    }

    // ------------------------------------------------------------ vault

    function test_vaultWithdrawOnlyIdle() public {
        _create(5_000);
        vm.prank(underwriter);
        vm.expectRevert(Markets.VaultShort.selector);
        mk.withdraw(50 ether); // 2 MON is out in a market
        vm.prank(underwriter);
        mk.withdraw(40 ether);
    }

    function test_vaultEarnsWhenHedgersLose() public {
        uint256 id = _create(3_000);
        vm.prank(alice);
        mk.buy{value: 2 ether}(id, true, 0); // pays for "late" cover
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(oracle);
        mk.resolve(id, int256(vm.getBlockTimestamp())); // on time: NO
        mk.settleVault(id);
        assertGt(mk.vaultValue(), 50 ether); // premium + fees + creation fee
    }

    function testFuzz_solvent(uint256 seed) public {
        uint256 id = _create(5_000);
        for (uint256 i = 0; i < 30; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address who = seed % 2 == 0 ? alice : bob;
            bool yes = (seed >> 1) % 2 == 0;
            (uint256 y, uint256 n,,,) = mk.accounts(id, who);
            uint256 held = yes ? y : n;
            vm.prank(who);
            if ((seed >> 2) % 3 != 0 || held == 0) mk.buy{value: 1e15 + (seed >> 8) % 0.5 ether}(id, yes, 0);
            else mk.sell(id, yes, 1 + (seed >> 8) % held, 0);
        }
        vm.prank(oracle);
        mk.resolve(id, int256(uint256(deadline)) + int256(seed % 2)); // YES either way: value >= deadline
        vm.prank(alice);
        try mk.redeem(id) {} catch {}
        vm.prank(bob);
        try mk.redeem(id) {} catch {}
        vm.prank(hedger);
        try mk.redeem(id) {} catch {}
        mk.settleVault(id);
        assertGe(address(mk).balance, mk.vaultIdle());
    }
}

contract FaucetTest is Test {
    function test_dripOncePerAddress() public {
        address relayer = makeAddr("relayer");
        address burner = makeAddr("burner");
        Faucet f = new Faucet{value: 1 ether}(relayer, 0.25 ether);
        vm.prank(relayer);
        f.drip(burner);
        assertEq(burner.balance, 0.25 ether);
        vm.prank(relayer);
        vm.expectRevert(Faucet.AlreadyDripped.selector);
        f.drip(burner);
    }
}

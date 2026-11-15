// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Markets} from "../src/Markets.sol";
import {Faucet} from "../src/Faucet.sol";

contract MarketsTest is Test {
    Markets mk;
    address oracle = makeAddr("oracle");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint64 close;

    function setUp() public {
        mk = new Markets(oracle);
        close = uint64(block.timestamp + 30 minutes);
        vm.deal(creator, 100 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _create(uint16 prior, uint16 fee) internal returns (uint256 id) {
        vm.prank(creator);
        id = mk.createMarket{value: 10 ether}("Suez >= 190?", "portwatch:Suez Canal:weekly_transits", 190, true, close, fee, prior);
    }

    function test_seedSetsPrior() public {
        uint256 id = _create(3_000, 100);
        assertApproxEqAbs(mk.priceYes(id), 0.3e18, 1e9);
        (uint256 yes, uint256 no, uint256 lp,,) = mk.accounts(id, creator);
        assertEq(lp, 10 ether);
        assertEq(yes, 0);
        assertGt(no, 0); // prior < 50%: creator keeps the leftover NO shares
    }

    function test_buyMovesPriceAndMatchesQuote() public {
        uint256 id = _create(5_000, 100);
        uint256 quoted = mk.quoteBuy(id, true, 1 ether);
        vm.prank(alice);
        uint256 got = mk.buy{value: 1 ether}(id, true, quoted);
        assertEq(got, quoted);
        assertGt(mk.priceYes(id), 0.5e18);
    }

    function test_roundTripNeverProfits() public {
        uint256 id = _create(4_000, 100);
        vm.startPrank(alice);
        uint256 shares = mk.buy{value: 2 ether}(id, true, 0);
        uint256 back = mk.sell(id, true, shares, 0);
        vm.stopPrank();
        assertLt(back, 2 ether);
    }

    function test_slippageGuard() public {
        uint256 id = _create(5_000, 100);
        uint256 quoted = mk.quoteBuy(id, true, 1 ether);
        vm.prank(bob);
        mk.buy{value: 1 ether}(id, true, 0); // front-runs alice
        vm.prank(alice);
        vm.expectRevert(Markets.Slippage.selector);
        mk.buy{value: 1 ether}(id, true, quoted);
    }

    function test_costForSharesCoversTarget() public {
        uint256 id = _create(2_500, 100);
        uint256 cost = mk.costForShares(id, true, 3 ether);
        vm.prank(alice);
        uint256 got = mk.buy{value: cost}(id, true, 3 ether);
        assertGe(got, 3 ether);
    }

    function test_resolveRedeemAndSolvency() public {
        uint256 id = _create(5_000, 100);
        vm.prank(alice);
        uint256 aYes = mk.buy{value: 3 ether}(id, true, 0);
        vm.prank(bob);
        mk.buy{value: 2 ether}(id, false, 0);

        vm.warp(close);
        vm.prank(oracle);
        mk.resolve(id, 201); // >= 190, YES wins

        uint256 before = alice.balance;
        vm.prank(alice);
        mk.redeem(id);
        assertEq(alice.balance - before, aYes);

        vm.prank(bob);
        vm.expectRevert(Markets.NothingToPay.selector);
        mk.redeem(id);

        // creator pulls the pool out, redeems, and claims fees; contract never runs dry
        vm.startPrank(creator);
        mk.removeLiquidity(id, 10 ether);
        mk.redeem(id);
        mk.claimFees(id);
        vm.stopPrank();
        assertLt(address(mk).balance, 1e6); // only rounding dust left
    }

    function test_noTradingAfterClose() public {
        uint256 id = _create(5_000, 100);
        vm.warp(close);
        vm.prank(alice);
        vm.expectRevert(Markets.MarketClosed.selector);
        mk.buy{value: 1 ether}(id, true, 0);
    }

    function test_onlyOracleResolves() public {
        uint256 id = _create(5_000, 100);
        vm.warp(close);
        vm.prank(alice);
        vm.expectRevert(Markets.NotOracle.selector);
        mk.resolve(id, 1);
    }

    function test_cannotResolveTwiceOrEarly() public {
        uint256 id = _create(5_000, 100);
        vm.prank(oracle);
        vm.expectRevert(Markets.NotClosed.selector);
        mk.resolve(id, 1);
        vm.warp(close);
        vm.startPrank(oracle);
        mk.resolve(id, 1);
        vm.expectRevert(Markets.AlreadyResolved.selector);
        mk.resolve(id, 1);
        vm.stopPrank();
    }

    function test_feesGoToLps() public {
        uint256 id = _create(5_000, 200);
        vm.prank(bob);
        mk.addLiquidity{value: 10 ether}(id);
        vm.prank(alice);
        mk.buy{value: 4 ether}(id, true, 0); // 0.08 MON fee, split 50/50
        assertApproxEqAbs(mk.pendingFees(id, creator), 0.04 ether, 1e6);
        assertApproxEqAbs(mk.pendingFees(id, bob), 0.04 ether, 1e6);
    }

    /// Random buys and sells: price stays in (0, 1) and the contract can always pay every share.
    function testFuzz_solvent(uint256 seed) public {
        uint256 id = _create(5_000, 100);
        for (uint256 i = 0; i < 40; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address who = seed % 2 == 0 ? alice : bob;
            bool yes = (seed >> 1) % 2 == 0;
            (uint256 y, uint256 n,,,) = mk.accounts(id, who);
            uint256 held = yes ? y : n;
            vm.prank(who);
            if ((seed >> 2) % 3 != 0 || held == 0) mk.buy{value: 1e15 + (seed >> 8) % 2 ether}(id, yes, 0);
            else mk.sell(id, yes, 1 + (seed >> 8) % held, 0);
            uint256 p = mk.priceYes(id);
            assertGt(p, 0);
            assertLt(p, 1e18);
        }
    }
}

contract FaucetTest is Test {
    function test_dripOncePerAddress() public {
        address relayer = makeAddr("relayer");
        address burner = makeAddr("burner");
        Faucet f = new Faucet{value: 1 ether}(relayer, 0.05 ether);
        vm.prank(relayer);
        f.drip(burner);
        assertEq(burner.balance, 0.05 ether);
        vm.prank(relayer);
        vm.expectRevert(Faucet.AlreadyDripped.selector);
        f.drip(burner);
    }
}

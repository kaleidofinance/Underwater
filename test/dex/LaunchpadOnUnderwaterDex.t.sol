// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterLaunchpad} from "../../src/UnderwaterLaunchpad.sol";
import {UnderwaterFactory} from "../../src/dex/UnderwaterFactory.sol";
import {UnderwaterPair} from "../../src/dex/UnderwaterPair.sol";
import {UnderwaterRouter} from "../../src/dex/UnderwaterRouter.sol";
import {MemeToken} from "../../src/token/MemeToken.sol";
import {WETH9} from "./mocks/DexMocks.sol";
import {Test, stdError} from "forge-std/Test.sol";

/// @notice The launchpad and the DEX as one system: a curve fills, graduates
///         into an Underwater pool, and the token trades there afterwards.
///
/// @dev The launchpad is pointed at `UnderwaterRouter` through its existing
///      `IUniswapV2Router02` interface with no change to the launchpad, which is
///      the whole point of keeping the router ABI V2-compatible.
contract LaunchpadOnUnderwaterDexTest is Test {
    UnderwaterLaunchpad internal pad;
    UnderwaterFactory internal factory;
    UnderwaterRouter internal router;
    WETH9 internal weth;

    address internal owner = makeAddr("owner");
    address internal padTreasury = makeAddr("padTreasury");
    address internal dexTreasury = makeAddr("dexTreasury");
    address internal creator = makeAddr("creator");
    address internal whale = makeAddr("whale");
    address internal stranger = makeAddr("stranger");
    address internal sniper = makeAddr("sniper");

    uint256 internal constant TRADE_FEE_BPS = 100; // 1%
    uint256 internal constant GRAD_FEE_BPS = 500; // 5%
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 internal deadline;

    function setUp() public {
        factory = new UnderwaterFactory(owner);
        weth = new WETH9();
        router = new UnderwaterRouter(address(factory), address(weth));
        pad = new UnderwaterLaunchpad(owner, address(router), padTreasury, TRADE_FEE_BPS, 0, GRAD_FEE_BPS);

        vm.warp(1_700_000_000);
        deadline = block.timestamp + 1 hours;

        vm.deal(whale, 1_000 ether);
        vm.deal(stranger, 1_000 ether);
        vm.deal(sniper, 1_000 ether);
        vm.deal(dexTreasury, 1_000 ether);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _launch() internal returns (address) {
        vm.prank(creator);
        return pad.create("Kraken", "KRAK", "ipfs://krak", 0);
    }

    function _graduate() internal returns (address token) {
        token = _launch();
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);
    }

    function _pairOf(address token) internal view returns (UnderwaterPair) {
        return UnderwaterPair(factory.getPair(token, address(weth)));
    }

    function _isGraduated(address token) internal view returns (bool graduated) {
        (,,,,,, graduated,) = pad.pools(token);
    }

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    /// @dev ETH-per-token, scaled by 1e18, from a pool's reserves.
    function _dexPriceE18(address token) internal view returns (uint256) {
        UnderwaterPair pair = _pairOf(token);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 ethReserve, uint256 tokenReserve) =
            pair.token0() == address(weth) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        return ethReserve * 1e18 / tokenReserve;
    }

    // ─── Graduation into our own pool ─────────────────────────────────────

    function test_graduationSeedsAnUnderwaterPool() public {
        address token = _graduate();

        assertTrue(_isGraduated(token), "curve closed");

        UnderwaterPair pair = _pairOf(token);
        assertTrue(address(pair) != address(0), "pool exists in our factory");
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.allPairs(0), address(pair));

        uint256 expectedEth = pad.GRADUATION_ETH() - (pad.GRADUATION_ETH() * GRAD_FEE_BPS / 10_000);
        assertEq(weth.balanceOf(address(pair)), expectedEth, "3.8 ETH of the 4 ETH raise");
        assertEq(MemeToken(token).balanceOf(address(pair)), pad.LP_SUPPLY(), "200M tokens");
    }

    function test_launchpadKeepsNothingAfterGraduation() public {
        address token = _graduate();

        assertEq(address(pad).balance, 0, "no ETH stranded in the launchpad");
        assertEq(pad.totalCurveEth(), 0, "curve accounting cleared");
        assertEq(MemeToken(token).balanceOf(address(pad)), 0, "unsold float burned, LP float moved");
        assertEq(
            MemeToken(token).allowance(address(pad), address(router)), 0, "router approval reset to zero"
        );
    }

    function test_unsoldSupplyIsBurnedNotHeld() public {
        address token = _graduate();

        // The curve sold its whole float, so total supply is exactly the
        // circulating float plus the LP allocation.
        assertEq(
            MemeToken(token).totalSupply(), pad.CURVE_SUPPLY() + pad.LP_SUPPLY(), "nothing left over anywhere"
        );
    }

    function test_lpTokensAreBurnedToTheDeadAddress() public {
        address token = _graduate();
        UnderwaterPair pair = _pairOf(token);

        uint256 burned = pair.balanceOf(DEAD);
        assertGt(burned, 0, "LP minted");
        assertEq(burned + pair.MINIMUM_LIQUIDITY(), pair.totalSupply(), "all LP is either burned or locked");
        assertEq(pair.balanceOf(address(pad)), 0);
        assertEq(pair.balanceOf(creator), 0, "the creator holds no LP");
        assertEq(pair.balanceOf(owner), 0, "the owner holds no LP");
    }

    /// @dev The rug-resistance claim, asserted rather than left in prose: every
    ///      LP token sits at either the burn address or the pair's own locked
    ///      minimum, so no reachable account can withdraw the pool.
    function test_noReachableAccountCanPullTheLiquidity() public {
        address token = _graduate();
        UnderwaterPair pair = _pairOf(token);

        address[6] memory suspects = [creator, owner, whale, stranger, address(pad), address(router)];
        for (uint256 i; i < suspects.length; ++i) {
            assertEq(pair.balanceOf(suspects[i]), 0, "no LP outside the burn address");
        }

        // All supply is accounted for by the two unspendable holders.
        assertEq(pair.balanceOf(DEAD) + pair.MINIMUM_LIQUIDITY(), pair.totalSupply());

        // Withdrawal attempts have nothing to withdraw.
        vm.prank(whale);
        vm.expectRevert(stdError.arithmeticError);
        router.removeLiquidity(token, address(weth), 1, 0, 0, whale, deadline);
    }

    // ─── Trading after graduation ─────────────────────────────────────────

    function test_strangerCanBuyAndSellOnTheNewPool() public {
        address token = _graduate();

        address[] memory buyPath = _path(address(weth), token);
        uint256 quoted = router.getAmountsOut(1 ether, buyPath)[1];

        vm.prank(stranger);
        router.swapExactETHForTokens{value: 1 ether}(quoted, buyPath, stranger, deadline);
        assertEq(MemeToken(token).balanceOf(stranger), quoted, "bought on our DEX");

        // And straight back out.
        uint256 held = MemeToken(token).balanceOf(stranger);
        address[] memory sellPath = _path(token, address(weth));
        uint256 ethBefore = stranger.balance;

        vm.startPrank(stranger);
        MemeToken(token).approve(address(router), held);
        router.swapExactTokensForETH(held, 0, sellPath, stranger, deadline);
        vm.stopPrank();

        uint256 recovered = stranger.balance - ethBefore;
        assertGt(recovered, 0, "sold back out for ETH");
        assertLt(recovered, 1 ether, "round trip costs the 0.6% of fees plus impact");
    }

    function test_curveIsClosedOnceTheDexPoolIsLive() public {
        address token = _graduate();

        vm.prank(stranger);
        vm.expectRevert(UnderwaterLaunchpad.AlreadyGraduated.selector);
        pad.buy{value: 1 ether}(token, 0, stranger);

        vm.prank(whale);
        vm.expectRevert(UnderwaterLaunchpad.AlreadyGraduated.selector);
        pad.sell(token, 1e18, 0, whale);
    }

    /// @dev Curve buyers pay an average of raise/float; the pool lists at
    ///      liquidity/LP-allocation. The second must be the larger of the two or
    ///      the median curve buyer would be underwater the moment trading opens.
    function test_listingPriceIsAboveTheAverageCurvePrice() public {
        address token = _graduate();

        uint256 averageCurvePrice = pad.GRADUATION_ETH() * 1e18 / pad.CURVE_SUPPLY();
        uint256 listingPrice = _dexPriceE18(token);

        assertGt(listingPrice, averageCurvePrice, "the average curve buyer opens in profit");
    }

    function test_poolPriceMatchesTheDepositedRatio() public {
        address token = _graduate();

        uint256 expectedEth = pad.GRADUATION_ETH() - (pad.GRADUATION_ETH() * GRAD_FEE_BPS / 10_000);
        assertEq(_dexPriceE18(token), expectedEth * 1e18 / pad.LP_SUPPLY(), "no hidden skim");
    }

    // ─── Fee capture: the reason to run our own DEX ───────────────────────

    function test_noProtocolFeeUntilTheOwnerSwitchesItOn() public {
        address token = _graduate();
        _generateDexVolume(token, 10);

        assertEq(_pairOf(token).kLast(), 0, "fee is off, nothing tracked");
        assertEq(_pairOf(token).balanceOf(dexTreasury), 0);
    }

    /// @dev The business case: with graduations landing in our own pools, the
    ///      protocol earns 1/6 of the 0.3% swap fee on every graduated token
    ///      forever, instead of handing that stream to a third-party DEX.
    ///
    ///      100% of the LP is burned, so no ordinary liquidity event will ever
    ///      settle the accrued fee. It is still harvestable: adding a dust
    ///      position triggers the settlement and mints everything owed. This
    ///      test exists because "burned LP" and "collectable protocol fee" look
    ///      contradictory until you see the poke.
    function test_protocolFeeIsHarvestableEvenThoughAllLpIsBurned() public {
        vm.prank(owner);
        factory.setFeeTo(dexTreasury);

        address token = _graduate();
        UnderwaterPair pair = _pairOf(token);
        assertGt(pair.kLast(), 0, "fee accounting armed at the first mint");

        _generateDexVolume(token, 40);
        assertEq(pair.balanceOf(dexTreasury), 0, "nothing settled yet: no liquidity events");

        // Poke: buy a little of the token, then deposit a matching dust position.
        vm.prank(dexTreasury);
        router.swapExactETHForTokens{value: 0.05 ether}(0, _path(address(weth), token), dexTreasury, deadline);

        uint256 tokenAmount = MemeToken(token).balanceOf(dexTreasury);
        vm.startPrank(dexTreasury);
        MemeToken(token).approve(address(router), tokenAmount);
        router.addLiquidityETH{value: 1 ether}(token, tokenAmount, 0, 0, dexTreasury, deadline);
        vm.stopPrank();

        assertGt(pair.balanceOf(dexTreasury), 0, "accrued protocol fee minted to the treasury");
    }

    function test_protocolFeeIsASliceNotAControllingStake() public {
        vm.prank(owner);
        factory.setFeeTo(dexTreasury);

        address token = _graduate();
        UnderwaterPair pair = _pairOf(token);
        _generateDexVolume(token, 40);

        vm.prank(dexTreasury);
        router.swapExactETHForTokens{value: 0.05 ether}(0, _path(address(weth), token), dexTreasury, deadline);
        uint256 tokenAmount = MemeToken(token).balanceOf(dexTreasury);
        vm.startPrank(dexTreasury);
        MemeToken(token).approve(address(router), tokenAmount);
        (,, uint256 depositedLp) =
            router.addLiquidityETH{value: 1 ether}(token, tokenAmount, 0, 0, dexTreasury, deadline);
        vm.stopPrank();

        uint256 feeLp = pair.balanceOf(dexTreasury) - depositedLp;
        // The burned position still dominates the pool, so the protocol cannot
        // vote itself the liquidity.
        assertLt(feeLp, pair.balanceOf(DEAD) / 10, "fee stake stays small next to burned LP");
    }

    function _generateDexVolume(address token, uint256 rounds) internal {
        for (uint256 i; i < rounds; ++i) {
            vm.prank(stranger);
            router.swapExactETHForTokens{value: 0.5 ether}(0, _path(address(weth), token), stranger, deadline);

            uint256 held = MemeToken(token).balanceOf(stranger);
            vm.startPrank(stranger);
            MemeToken(token).approve(address(router), held);
            router.swapExactTokensForETH(held, 0, _path(token, address(weth)), stranger, deadline);
            vm.stopPrank();
        }
    }

    // ─── Griefing ─────────────────────────────────────────────────────────

    /// @dev Anyone can create and skew a pool before a curve graduates. The
    ///      router then deposits at the attacker's ratio and refunds the rest,
    ///      so the graduation must still complete and the refund must be
    ///      accounted for rather than stranded.
    function test_preCreatedSkewedPoolDoesNotStrandTheRaise() public {
        address token = _launch();

        // The sniper buys a little on the curve to get tokens to skew with.
        vm.prank(sniper);
        pad.buy{value: 0.5 ether}(token, 0, sniper);
        uint256 sniperTokens = MemeToken(token).balanceOf(sniper);

        // Then opens the pool at an absurd price: lots of tokens, almost no ETH.
        vm.startPrank(sniper);
        MemeToken(token).approve(address(router), sniperTokens);
        router.addLiquidityETH{value: 0.001 ether}(token, sniperTokens, 0, 0, sniper, deadline);
        vm.stopPrank();

        uint256 treasuryBefore = padTreasury.balance;

        // Finish the curve.
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        assertTrue(_isGraduated(token), "graduation still completes");
        assertEq(address(pad).balance, 0, "nothing stranded in the launchpad");
        assertEq(pad.totalCurveEth(), 0, "curve accounting cleared");

        // Whatever the skewed pool refused was paid out, not lost.
        uint256 protocolFee = pad.GRADUATION_ETH() * GRAD_FEE_BPS / 10_000;
        assertGe(padTreasury.balance - treasuryBefore, protocolFee, "at least the graduation fee");

        // And the pool is real and tradeable.
        UnderwaterPair pair = _pairOf(token);
        assertGt(weth.balanceOf(address(pair)), 0);
        assertGt(MemeToken(token).balanceOf(address(pair)), 0);

        vm.prank(stranger);
        router.swapExactETHForTokens{value: 0.01 ether}(0, _path(address(weth), token), stranger, deadline);
        assertGt(MemeToken(token).balanceOf(stranger), 0, "still tradeable after the grief");
    }

    function test_holdersCanStillSellWhileTheCurveIsOpen() public {
        address token = _launch();

        vm.prank(stranger);
        pad.buy{value: 1 ether}(token, 0, stranger);
        uint256 held = MemeToken(token).balanceOf(stranger);

        vm.startPrank(stranger);
        MemeToken(token).approve(address(pad), held);
        pad.sell(token, held, 0, stranger);
        vm.stopPrank();

        assertEq(MemeToken(token).balanceOf(stranger), 0, "exited on the curve");
    }

    // ─── Invariants ───────────────────────────────────────────────────────

    function testFuzz_graduationAlwaysLandsInATradeablePool(uint256 buys) public {
        buys = bound(buys, 1, 8);
        address token = _launch();

        // Walk the curve up in arbitrary steps until it closes.
        for (uint256 i; i < buys && !_isGraduated(token); ++i) {
            uint256 amount = 5 ether / buys + 1;
            vm.prank(whale);
            pad.buy{value: amount}(token, 0, whale);
        }
        if (!_isGraduated(token)) {
            vm.prank(whale);
            pad.buy{value: 5 ether}(token, 0, whale);
        }

        UnderwaterPair pair = _pairOf(token);
        assertTrue(address(pair) != address(0));
        assertEq(pair.balanceOf(address(pad)), 0, "launchpad never keeps LP");
        assertEq(address(pad).balance, 0, "launchpad never keeps ETH");

        vm.prank(stranger);
        router.swapExactETHForTokens{value: 0.1 ether}(0, _path(address(weth), token), stranger, deadline);
        assertGt(MemeToken(token).balanceOf(stranger), 0);
    }

    // ─── Gas floor ────────────────────────────────────────────────────────

    /// @dev `GRADUATION_GAS_RESERVE` is a promise that the deposit fits, and the
    ///      only router it has to fit on is this one. Measure the real thing:
    ///      seeding a brand new pair, deploying the pair contract, wrapping ETH
    ///      and burning the LP.
    function test_gasReserveCoversARealGraduationOnOurOwnDex() public {
        address token = _launch();

        vm.prank(whale);
        uint256 before = gasleft();
        pad.buy{value: 5 ether}(token, 0, whale);
        uint256 used = before - gasleft();

        assertTrue(_isGraduated(token), "graduation must have actually happened");
        assertLt(used, pad.GRADUATION_GAS_RESERVE(), "reserve is below the real cost");
        // And it should not be absurdly generous either, or it prices out the
        // final buyer for no reason. Two thirds of the floor is a healthy band.
        assertGt(used * 3, pad.GRADUATION_GAS_RESERVE(), "reserve is wastefully large");
    }

    /// @dev The whole point of the floor: any gas limit at which the final buy
    ///      succeeds is one at which the pool actually exists afterwards.
    function test_noGasLimitSucceedsWithoutSeedingThePool() public {
        vm.deal(address(this), 1_000 ether);

        uint256 succeeded;
        for (uint256 cap = 500_000; cap <= 5_500_000; cap += 250_000) {
            address token = _launch();
            vm.prank(whale);
            (bool ok,) = address(pad).call{value: 5 ether, gas: cap}(
                abi.encodeCall(UnderwaterLaunchpad.buy, (token, 0, whale))
            );
            if (ok) {
                succeeded++;
                assertTrue(_isGraduated(token), "buy succeeded without graduating");
                assertTrue(address(_pairOf(token)) != address(0), "no pool despite success");
            } else {
                assertFalse(_isGraduated(token));
            }
        }
        assertGt(succeeded, 0, "no gas limit in range completed the buy");
    }
}

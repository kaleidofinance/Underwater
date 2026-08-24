// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterLaunchpad} from "../src/UnderwaterLaunchpad.sol";
import {MemeToken} from "../src/token/MemeToken.sol";
import {MockPair, MockV2Factory, MockV2Router} from "./mocks/MockV2.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The graduation handoff: curve closes, liquidity moves to the DEX and
///         the LP position is burned so nobody can pull it.
contract GraduationTest is Test {
    UnderwaterLaunchpad pad;
    MockV2Router router;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address whale = makeAddr("whale");

    uint256 constant TRADE_FEE_BPS = 100; // 1%
    uint256 constant GRAD_FEE_BPS = 500; // 5%
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        router = new MockV2Router();
        pad = new UnderwaterLaunchpad(owner, address(router), treasury, TRADE_FEE_BPS, 0, GRAD_FEE_BPS);
        vm.deal(alice, 1_000 ether);
        vm.deal(whale, 1_000 ether);
    }

    function _launch() internal returns (address) {
        vm.prank(alice);
        return pad.create("Kraken", "KRAK", "ipfs://krak", 0);
    }

    function _isGraduated(address token) internal view returns (bool graduated) {
        (,,,,,, graduated,) = pad.pools(token);
    }

    function _pairOf(address token) internal view returns (address) {
        return MockV2Factory(router.factory()).getPair(token, router.WETH());
    }

    /// @dev Gross ETH needed to push a fresh curve exactly to the threshold.
    function _grossToGraduate() internal view returns (uint256) {
        uint256 target = pad.GRADUATION_ETH();
        uint256 numerator = target * 10_000;
        uint256 denominator = 10_000 - TRADE_FEE_BPS;
        uint256 q = numerator / denominator;
        return q * denominator == numerator ? q : q + 1;
    }

    // ─── Threshold ────────────────────────────────────────────────────────

    function test_doesNotGraduateBelowThreshold() public {
        address token = _launch();
        vm.prank(whale);
        pad.buy{value: 3 ether}(token, 0, whale);
        assertFalse(_isGraduated(token));
        assertEq(_pairOf(token), address(0), "no pair yet");
    }

    function test_graduatesWhenThresholdReached() public {
        address token = _launch();

        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        assertTrue(_isGraduated(token), "must graduate");

        (, uint128 tokenReserve, uint128 realEthRaised, uint128 tokensSold,,,,) = pad.pools(token);
        assertEq(realEthRaised, 0, "raise moved out to the DEX");
        assertEq(tokensSold, pad.CURVE_SUPPLY(), "entire float sold");
        assertEq(tokenReserve, pad.INITIAL_TOKEN_RESERVE() - pad.CURVE_SUPPLY());
        assertEq(pad.totalCurveEth(), 0);
        assertEq(pad.progressBps(token), 10_000);
    }

    /// @dev The buy that crosses the line must be sized down to land exactly on
    ///      the threshold, with the unused ETH refunded rather than absorbed.
    function test_finalBuyIsSizedDownAndRefunded() public {
        address token = _launch();
        uint256 grossNeeded = _grossToGraduate();

        uint256 before = whale.balance;
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        assertTrue(_isGraduated(token));
        assertEq(before - whale.balance, grossNeeded, "only the needed gross was spent");
        assertEq(whale.balance, before - grossNeeded, "remainder refunded");
    }

    function test_quoteBuyPredictsTheRefund() public {
        address token = _launch();
        (uint256 tokensOut, uint256 fee, uint256 refund) = pad.quoteBuy(token, 5 ether);

        assertEq(tokensOut, pad.CURVE_SUPPLY(), "final quote fills the whole float");
        assertEq(refund, 5 ether - _grossToGraduate());
        assertEq(fee, _grossToGraduate() - pad.GRADUATION_ETH());
    }

    function test_graduationAcrossManyBuyers() public {
        address token = _launch();
        for (uint256 i = 0; i < 5; ++i) {
            address buyer = address(uint160(0x1000 + i));
            vm.deal(buyer, 10 ether);
            vm.prank(buyer);
            pad.buy{value: 1 ether}(token, 0, buyer);
        }
        // 5 ETH gross at 1% fee = 4.95 ETH net, past the 4 ETH threshold.
        assertTrue(_isGraduated(token));
    }

    // ─── Liquidity handoff ────────────────────────────────────────────────

    function test_liquidityIsSeededAndLpBurned() public {
        address token = _launch();
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        address pair = _pairOf(token);
        assertTrue(pair != address(0), "pair created");

        // The pool holds the LP allocation.
        assertEq(MemeToken(token).balanceOf(pair), pad.LP_SUPPLY());

        // And the LP tokens went to the burn address, not to us or the creator.
        assertGt(MockPair(pair).balanceOf(DEAD), 0, "LP must be burned");
        assertEq(MockPair(pair).balanceOf(address(pad)), 0);
        assertEq(MockPair(pair).balanceOf(alice), 0);
        assertEq(MockPair(pair).totalSupply(), MockPair(pair).balanceOf(DEAD));
    }

    function test_graduationFeeGoesToTreasuryAndLiquidityGetsRest() public {
        address token = _launch();
        uint256 target = pad.GRADUATION_ETH();

        uint256 treasuryBefore = treasury.balance;
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        uint256 expectedProtocolCut = (target * GRAD_FEE_BPS) / 10_000;
        uint256 expectedLiquidity = target - expectedProtocolCut;

        // Treasury received the trade fee plus the graduation cut.
        uint256 tradeFee = _grossToGraduate() - target;
        assertEq(treasury.balance - treasuryBefore, tradeFee + expectedProtocolCut);

        // The rest was handed to the router as liquidity and left the launchpad.
        // (The mock keeps the ETH itself; the real reserve split is asserted in
        // test/fork/InkGraduation.t.sol against the live Ink pair.)
        assertEq(address(router).balance, expectedLiquidity, "liquidity forwarded");
        assertEq(address(pad).balance, 0, "launchpad retains nothing");
    }

    function test_launchpadHoldsNoTokensAfterGraduation() public {
        address token = _launch();
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        assertEq(MemeToken(token).balanceOf(address(pad)), 0, "no tokens left behind");
        // Supply = whale's float + the LP allocation.
        assertEq(
            MemeToken(token).totalSupply(),
            MemeToken(token).balanceOf(whale) + MemeToken(token).balanceOf(_pairOf(token))
        );
    }

    function test_residualAllowanceIsCleared() public {
        address token = _launch();
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);
        assertEq(MemeToken(token).allowance(address(pad), address(router)), 0);
    }

    // ─── Curve is closed afterwards ───────────────────────────────────────

    function test_noTradingAfterGraduation() public {
        address token = _launch();
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        vm.prank(alice);
        vm.expectRevert(UnderwaterLaunchpad.AlreadyGraduated.selector);
        pad.buy{value: 1 ether}(token, 0, alice);

        uint256 bal = MemeToken(token).balanceOf(whale);
        vm.startPrank(whale);
        MemeToken(token).approve(address(pad), bal);
        vm.expectRevert(UnderwaterLaunchpad.AlreadyGraduated.selector);
        pad.sell(token, bal, 0, whale);
        vm.stopPrank();

        vm.expectRevert(UnderwaterLaunchpad.AlreadyGraduated.selector);
        pad.quoteBuy(token, 1 ether);
        vm.expectRevert(UnderwaterLaunchpad.AlreadyGraduated.selector);
        pad.quoteSell(token, 1);

        vm.expectRevert(UnderwaterLaunchpad.AlreadyGraduated.selector);
        pad.graduate(token);
    }

    function test_tokensRemainFreelyTransferableAfterGraduation() public {
        address token = _launch();
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        uint256 bal = MemeToken(token).balanceOf(whale);
        vm.prank(whale);
        MemeToken(token).transfer(alice, bal / 2);
        assertEq(MemeToken(token).balanceOf(alice), bal / 2);
    }

    // ─── Adversarial: pair front-running ──────────────────────────────────

    /// @dev If the pool takes less than offered (a pre-existing pair with a
    ///      skewed ratio), the leftovers must be burned and swept, never left
    ///      sitting in the launchpad.
    function test_skewedPairLeavesNothingBehind() public {
        router.setConsumeBps(5_000, 5_000); // pool accepts only half of each side

        address token = _launch();
        uint256 treasuryBefore = treasury.balance;

        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        assertTrue(_isGraduated(token));

        uint256 target = pad.GRADUATION_ETH();
        uint256 protocolCut = (target * GRAD_FEE_BPS) / 10_000;
        uint256 offered = target - protocolCut;
        uint256 consumed = offered / 2;

        // Half the LP allocation was burned rather than stranded.
        assertEq(MemeToken(token).balanceOf(address(pad)), 0);
        assertEq(MemeToken(token).balanceOf(_pairOf(token)), pad.LP_SUPPLY() / 2);
        assertEq(
            MemeToken(token).totalSupply(),
            MemeToken(token).balanceOf(whale) + pad.LP_SUPPLY() / 2,
            "unused LP tokens burned"
        );

        // The refunded ETH reached the treasury instead of being stuck.
        uint256 tradeFee = _grossToGraduate() - target;
        assertEq(treasury.balance - treasuryBefore, tradeFee + protocolCut + (offered - consumed));
        assertEq(address(pad).balance, 0, "no ETH stranded");
    }

    // ─── Recovery hatch ───────────────────────────────────────────────────

    /// @dev A router that reverts must not brick the final buy. The curve parks
    ///      at the threshold, sells still work, and graduation can be retried.
    function test_failedGraduationParksCurveThenRetrySucceeds() public {
        address token = _launch();
        router.setShouldRevert(true);

        vm.expectEmit(true, false, false, true, address(pad));
        emit UnderwaterLaunchpad.GraduationFailed(token, pad.GRADUATION_ETH());

        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);

        // The buy itself succeeded; graduation did not.
        assertFalse(_isGraduated(token), "parked, not graduated");
        assertGt(MemeToken(token).balanceOf(whale), 0, "buyer still filled");
        (,, uint128 realEthRaised,,,,,) = pad.pools(token);
        assertEq(realEthRaised, pad.GRADUATION_ETH(), "raise still held by the curve");
        assertEq(address(pad).balance, pad.GRADUATION_ETH());

        // Holders are not trapped: selling back still works while parked.
        uint256 bal = MemeToken(token).balanceOf(whale);
        vm.startPrank(whale);
        MemeToken(token).approve(address(pad), bal / 4);
        uint256 out = pad.sell(token, bal / 4, 0, whale);
        vm.stopPrank();
        assertGt(out, 0, "exit available while parked");

        // Buying back up to the threshold, then retrying, completes the launch.
        vm.prank(alice);
        pad.buy{value: 5 ether}(token, 0, alice);
        assertFalse(_isGraduated(token));

        router.setShouldRevert(false);
        pad.graduate(token);

        assertTrue(_isGraduated(token), "retry graduates");
        assertGt(MockPair(_pairOf(token)).balanceOf(DEAD), 0, "LP burned on retry");
        assertEq(address(pad).balance, 0);
    }

    function test_graduateRevertsBelowThreshold() public {
        address token = _launch();
        vm.prank(whale);
        pad.buy{value: 1 ether}(token, 0, whale);

        vm.expectRevert(UnderwaterLaunchpad.NotGraduated.selector);
        pad.graduate(token);
    }

    function test_graduateRevertsForUnknownToken() public {
        vm.expectRevert(UnderwaterLaunchpad.UnknownToken.selector);
        pad.graduate(address(0xBEEF));
    }

    /// @dev Owner can point at a working router to unstick a parked curve.
    function test_ownerCanSwapRouterToUnstickParkedCurve() public {
        address token = _launch();
        router.setShouldRevert(true);
        vm.prank(whale);
        pad.buy{value: 5 ether}(token, 0, whale);
        assertFalse(_isGraduated(token));

        MockV2Router healthy = new MockV2Router();
        vm.prank(owner);
        pad.setRouter(address(healthy));

        pad.graduate(token);
        assertTrue(_isGraduated(token));

        address pair = MockV2Factory(healthy.factory()).getPair(token, healthy.WETH());
        assertGt(MockPair(pair).balanceOf(DEAD), 0);
    }

    // ─── Gas ──────────────────────────────────────────────────────────────

    /// @dev A buy that would graduate refuses to run on a gas budget too small
    ///      to seed the pool, rather than succeeding and quietly parking.
    function test_revertsWhenGasCannotCoverGraduation() public {
        address token = _launch();

        vm.deal(address(this), 10 ether);
        vm.prank(whale);
        vm.expectRevert(UnderwaterLaunchpad.GraduationOutOfGas.selector);
        pad.buy{value: 5 ether, gas: 1_000_000}(token, 0, whale);
    }

    /// @dev The gas floor only guards graduation. An ordinary buy that stops
    ///      short of the threshold is unaffected.
    function test_gasFloorDoesNotApplyToOrdinaryBuys() public {
        address token = _launch();

        vm.deal(address(this), 10 ether);
        vm.prank(whale);
        pad.buy{value: 1 ether, gas: 400_000}(token, 0, whale);

        assertFalse(_isGraduated(token));
        assertGt(MemeToken(token).balanceOf(whale), 0);
    }

    /// @dev The property that actually protects users: every gas limit at which
    ///      the final buy succeeds is a limit at which the token graduated.
    ///
    ///      Wallets pick a gas limit by binary searching for the cheapest one
    ///      that does not revert. Without the floor the cheapest such limit was
    ///      the one that skipped the deposit, so a wallet-estimated final buy
    ///      parked the curve instead of graduating it — every time, on a
    ///      perfectly healthy router.
    function test_everyGasLimitThatSucceedsAlsoGraduates() public {
        vm.deal(address(this), 1_000 ether);

        uint256 succeeded;
        for (uint256 cap = 200_000; cap <= 4_400_000; cap += 200_000) {
            address token = _launch();
            vm.prank(whale);
            (bool ok,) = address(pad).call{value: 5 ether, gas: cap}(
                abi.encodeCall(UnderwaterLaunchpad.buy, (token, 0, whale))
            );
            if (ok) {
                succeeded++;
                assertTrue(_isGraduated(token), "buy succeeded without graduating");
            } else {
                assertFalse(_isGraduated(token), "failed buy left state behind");
            }
        }
        // Guard the guard: if nothing ever succeeded the loop proved nothing.
        assertGt(succeeded, 0, "no gas limit in range completed the buy");
    }

    /// @dev The floor is a floor, not a fixed price: it must be comfortably
    ///      above what the deposit actually costs, or it is just a tax.
    function test_gasReserveExceedsRealGraduationCost() public {
        address token = _launch();

        vm.prank(whale);
        uint256 before = gasleft();
        pad.buy{value: 5 ether}(token, 0, whale);
        uint256 used = before - gasleft();

        assertTrue(_isGraduated(token));
        assertLt(used, pad.GRADUATION_GAS_RESERVE(), "reserve below the real cost");
    }
}

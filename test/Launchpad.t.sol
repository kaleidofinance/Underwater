// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterLaunchpad} from "../src/UnderwaterLaunchpad.sol";
import {CurveMath} from "../src/lib/CurveMath.sol";
import {MemeToken} from "../src/token/MemeToken.sol";
import {Owned} from "../src/utils/Owned.sol";
import {MockV2Router, RejectingRecipient} from "./mocks/MockV2.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Reenters `buy` from the fee payout to prove the guard holds.
contract ReenteringFeeRecipient {
    UnderwaterLaunchpad immutable pad;
    address public target;
    bool public armed;

    constructor(UnderwaterLaunchpad _pad) {
        pad = _pad;
    }

    function arm(address _target) external {
        target = _target;
        armed = true;
    }

    receive() external payable {
        if (armed) {
            armed = false;
            pad.buy{value: 0.01 ether}(target, 0, address(this));
        }
    }
}

contract LaunchpadTest is Test {
    UnderwaterLaunchpad pad;
    MockV2Router router;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant TRADE_FEE_BPS = 100; // 1%
    uint256 constant CREATION_FEE = 0.001 ether;
    uint256 constant GRAD_FEE_BPS = 500; // 5%

    function setUp() public {
        router = new MockV2Router();
        pad = new UnderwaterLaunchpad(
            owner, address(router), treasury, TRADE_FEE_BPS, CREATION_FEE, GRAD_FEE_BPS
        );
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    function _launch() internal returns (address token) {
        vm.prank(alice);
        return pad.create{value: CREATION_FEE}("Underwater Frog", "FROG", "ipfs://frog", 0);
    }

    // ─── Creation ─────────────────────────────────────────────────────────

    function test_createDeploysConfiguredToken() public {
        address token = _launch();
        MemeToken t = MemeToken(token);

        assertEq(t.name(), "Underwater Frog");
        assertEq(t.symbol(), "FROG");
        assertEq(t.decimals(), 18);
        assertEq(t.metadataURI(), "ipfs://frog");
        assertEq(t.creator(), alice);
        assertEq(t.launchpad(), address(pad));

        // Entire supply parked with the launchpad, nothing to the creator.
        assertEq(t.totalSupply(), pad.TOTAL_SUPPLY());
        assertEq(t.balanceOf(address(pad)), pad.TOTAL_SUPPLY());
        assertEq(t.balanceOf(alice), 0);
    }

    function test_createInitialisesCurve() public {
        address token = _launch();
        (
            uint128 ethReserve,
            uint128 tokenReserve,
            uint128 realEthRaised,
            uint128 tokensSold,
            address creator,,
            bool graduated,
            bool exists
        ) = pad.pools(token);

        assertEq(ethReserve, pad.VIRTUAL_ETH_RESERVE());
        assertEq(tokenReserve, pad.INITIAL_TOKEN_RESERVE());
        assertEq(realEthRaised, 0);
        assertEq(tokensSold, 0);
        assertEq(creator, alice);
        assertFalse(graduated);
        assertTrue(exists);

        assertEq(pad.tokenCount(), 1);
        assertEq(pad.allTokens(0), token);
    }

    function test_createPaysCreationFeeToTreasury() public {
        uint256 before = treasury.balance;
        _launch();
        assertEq(treasury.balance - before, CREATION_FEE);
    }

    function test_createWithInitialBuyFillsCreator() public {
        uint256 sent = CREATION_FEE + 1 ether;
        vm.prank(alice);
        address token = pad.create{value: sent}("Squid", "SQUID", "ipfs://squid", 0);

        // Creator got tokens in the same transaction as the launch.
        assertGt(MemeToken(token).balanceOf(alice), 0);

        (,, uint128 realEthRaised,,,,,) = pad.pools(token);
        // 1 ETH minus the 1% trade fee.
        assertEq(realEthRaised, 1 ether - (1 ether * TRADE_FEE_BPS) / 10_000);
    }

    function test_createRevertsOnEmptyNameOrSymbol() public {
        vm.startPrank(alice);
        vm.expectRevert(UnderwaterLaunchpad.EmptyMetadata.selector);
        pad.create{value: CREATION_FEE}("", "X", "uri", 0);

        vm.expectRevert(UnderwaterLaunchpad.EmptyMetadata.selector);
        pad.create{value: CREATION_FEE}("X", "", "uri", 0);
        vm.stopPrank();
    }

    function test_createRevertsBelowCreationFee() public {
        vm.prank(alice);
        vm.expectRevert(UnderwaterLaunchpad.InsufficientCreationFee.selector);
        pad.create{value: CREATION_FEE - 1}("X", "X", "uri", 0);
    }

    function test_createRevertsIfMinOutRequestedWithNoBuy() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(UnderwaterLaunchpad.SlippageExceeded.selector, 0, 1));
        pad.create{value: CREATION_FEE}("X", "X", "uri", 1);
    }

    // ─── Buying ───────────────────────────────────────────────────────────

    function test_buyDeliversTokensAndChargesFee() public {
        address token = _launch();
        uint256 treasuryBefore = treasury.balance;

        uint256 spend = 1 ether;
        uint256 expectedFee = (spend * TRADE_FEE_BPS) / 10_000;

        vm.prank(bob);
        uint256 got = pad.buy{value: spend}(token, 0, bob);

        assertEq(MemeToken(token).balanceOf(bob), got);
        assertEq(treasury.balance - treasuryBefore, expectedFee);

        (,, uint128 realEthRaised, uint128 tokensSold,,,,) = pad.pools(token);
        assertEq(realEthRaised, spend - expectedFee);
        assertEq(tokensSold, got);
        assertEq(pad.totalCurveEth(), spend - expectedFee);
    }

    function test_buyRevertsOnSlippage() public {
        address token = _launch();
        (uint256 expected,,) = pad.quoteBuy(token, 1 ether);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwaterLaunchpad.SlippageExceeded.selector, expected, expected + 1)
        );
        pad.buy{value: 1 ether}(token, expected + 1, bob);
    }

    function test_buyRevertsOnZeroValueOrBadRecipient() public {
        address token = _launch();
        vm.startPrank(bob);
        vm.expectRevert(UnderwaterLaunchpad.ZeroAmount.selector);
        pad.buy{value: 0}(token, 0, bob);

        vm.expectRevert(Owned.ZeroAddress.selector);
        pad.buy{value: 1 ether}(token, 0, address(0));
        vm.stopPrank();
    }

    function test_buyRevertsForUnknownToken() public {
        vm.prank(bob);
        vm.expectRevert(UnderwaterLaunchpad.UnknownToken.selector);
        pad.buy{value: 1 ether}(address(0xBEEF), 0, bob);
    }

    function test_buyCanDeliverToAnotherAddress() public {
        address token = _launch();
        vm.prank(bob);
        uint256 got = pad.buy{value: 1 ether}(token, 0, alice);
        assertEq(MemeToken(token).balanceOf(alice), got);
        assertEq(MemeToken(token).balanceOf(bob), 0);
    }

    /// @dev The quote shown in the UI must equal what the trade actually fills.
    function testFuzz_quoteBuyMatchesBuy(uint256 seed) public {
        address token = _launch();
        uint256 spend = bound(seed, 1e12, 3 ether);

        (uint256 quoted, uint256 quotedFee, uint256 quotedRefund) = pad.quoteBuy(token, spend);

        uint256 treasuryBefore = treasury.balance;
        uint256 bobBefore = bob.balance;

        vm.prank(bob);
        uint256 actual = pad.buy{value: spend}(token, 0, bob);

        assertEq(actual, quoted, "token fill must match quote");
        assertEq(treasury.balance - treasuryBefore, quotedFee, "fee must match quote");
        assertEq(bobBefore - bob.balance, spend - quotedRefund, "refund must match quote");
    }

    // ─── Selling ──────────────────────────────────────────────────────────

    function test_sellReturnsEthNetOfFee() public {
        address token = _launch();

        vm.prank(bob);
        uint256 bought = pad.buy{value: 1 ether}(token, 0, bob);

        (uint256 expectedOut, uint256 expectedFee) = pad.quoteSell(token, bought);

        vm.startPrank(bob);
        MemeToken(token).approve(address(pad), bought);
        uint256 balanceBefore = bob.balance;
        uint256 treasuryBefore = treasury.balance;
        uint256 received = pad.sell(token, bought, 0, bob);
        vm.stopPrank();

        assertEq(received, expectedOut);
        assertEq(bob.balance - balanceBefore, expectedOut);
        assertEq(treasury.balance - treasuryBefore, expectedFee);
        assertEq(MemeToken(token).balanceOf(bob), 0);
    }

    /// @dev Buying then immediately selling must always lose money, otherwise
    ///      the curve is an arbitrage faucet.
    function testFuzz_roundTripAlwaysLoses(uint256 seed) public {
        address token = _launch();
        uint256 spend = bound(seed, 1e12, 3 ether);

        vm.startPrank(bob);
        uint256 before = bob.balance;
        uint256 bought = pad.buy{value: spend}(token, 0, bob);
        MemeToken(token).approve(address(pad), bought);
        pad.sell(token, bought, 0, bob);
        vm.stopPrank();

        assertLt(bob.balance, before, "round trip must be a loss");
    }

    /// @dev Curve accounting must fully unwind: if every buyer sells everything
    ///      back, no meaningful ETH may be left stranded in the curve.
    /// @dev A few wei of dust legitimately remain. Every curve operation rounds
    ///      in the pool's favour, so a full round trip leaves the curve very
    ///      slightly over-collateralised rather than short. That is the safe
    ///      direction, and the dust is permanently unreachable: `sweep` is
    ///      bounded by `totalCurveEth`, which still counts it.
    function test_curveFullyUnwinds() public {
        address token = _launch();

        vm.prank(bob);
        uint256 bobBought = pad.buy{value: 1 ether}(token, 0, bob);
        vm.prank(alice);
        uint256 aliceBought = pad.buy{value: 0.5 ether}(token, 0, alice);

        vm.startPrank(alice);
        MemeToken(token).approve(address(pad), aliceBought);
        pad.sell(token, aliceBought, 0, alice);
        vm.stopPrank();

        vm.startPrank(bob);
        MemeToken(token).approve(address(pad), bobBought);
        pad.sell(token, bobBought, 0, bob);
        vm.stopPrank();

        (,, uint128 realEthRaised, uint128 tokensSold,,,,) = pad.pools(token);
        assertEq(tokensSold, 0, "all tokens returned");
        assertLe(realEthRaised, 10, "at most rounding dust remains");
        assertEq(pad.totalCurveEth(), realEthRaised, "accounting still matches");
        assertGe(address(pad).balance, pad.totalCurveEth(), "curve stays solvent");
    }

    /// @dev Rounding dust must always leave the curve solvent, never short,
    ///      across arbitrary interleaved buy/sell sequences.
    function testFuzz_curveStaysSolvent(uint256 seedA, uint256 seedB, uint256 sellBps) public {
        address token = _launch();
        uint256 spendA = bound(seedA, 1e12, 1.5 ether);
        uint256 spendB = bound(seedB, 1e12, 1.5 ether);
        uint256 bps = bound(sellBps, 1, 10_000);

        vm.prank(bob);
        uint256 boughtB = pad.buy{value: spendA}(token, 0, bob);
        vm.prank(alice);
        pad.buy{value: spendB}(token, 0, alice);

        uint256 toSell = (boughtB * bps) / 10_000;
        if (toSell > 0) {
            vm.startPrank(bob);
            MemeToken(token).approve(address(pad), toSell);
            pad.sell(token, toSell, 0, bob);
            vm.stopPrank();
        }

        assertGe(address(pad).balance, pad.totalCurveEth(), "curve must never be short");
    }

    function test_sellRevertsAboveTokensSold() public {
        address token = _launch();
        vm.prank(bob);
        uint256 bought = pad.buy{value: 1 ether}(token, 0, bob);

        vm.startPrank(bob);
        MemeToken(token).approve(address(pad), type(uint256).max);
        vm.expectRevert(UnderwaterLaunchpad.InsufficientBalance.selector);
        pad.sell(token, bought + 1, 0, bob);
        vm.stopPrank();
    }

    function test_sellRevertsOnSlippage() public {
        address token = _launch();
        vm.prank(bob);
        uint256 bought = pad.buy{value: 1 ether}(token, 0, bob);
        (uint256 expectedOut,) = pad.quoteSell(token, bought);

        vm.startPrank(bob);
        MemeToken(token).approve(address(pad), bought);
        vm.expectRevert(
            abi.encodeWithSelector(
                UnderwaterLaunchpad.SlippageExceeded.selector, expectedOut, expectedOut + 1
            )
        );
        pad.sell(token, bought, expectedOut + 1, bob);
        vm.stopPrank();
    }

    function test_sellRevertsWithoutApproval() public {
        address token = _launch();
        vm.prank(bob);
        uint256 bought = pad.buy{value: 1 ether}(token, 0, bob);

        vm.prank(bob);
        vm.expectRevert(); // arithmetic underflow in allowance
        pad.sell(token, bought, 0, bob);
    }

    // ─── Reentrancy ───────────────────────────────────────────────────────

    function test_reentrancyGuardBlocksNestedBuy() public {
        ReenteringFeeRecipient attacker = new ReenteringFeeRecipient(pad);
        vm.prank(owner);
        pad.setFeeRecipient(address(attacker));

        address token = _launch();
        attacker.arm(token);
        vm.deal(address(attacker), 1 ether);

        // The nested buy triggered by the fee payout must revert, taking the
        // whole outer transaction with it.
        vm.prank(bob);
        vm.expectRevert(UnderwaterLaunchpad.EthTransferFailed.selector);
        pad.buy{value: 1 ether}(token, 0, bob);
    }

    // ─── Admin & access control ───────────────────────────────────────────

    function test_adminFunctionsAreOwnerOnly() public {
        vm.startPrank(bob);
        vm.expectRevert(Owned.NotOwner.selector);
        pad.setRouter(address(1));
        vm.expectRevert(Owned.NotOwner.selector);
        pad.setFeeRecipient(address(1));
        vm.expectRevert(Owned.NotOwner.selector);
        pad.setTradeFeeBps(1);
        vm.expectRevert(Owned.NotOwner.selector);
        pad.setCreationFee(1);
        vm.expectRevert(Owned.NotOwner.selector);
        pad.setGraduationFeeBps(1);
        vm.expectRevert(Owned.NotOwner.selector);
        pad.sweep(bob);
        vm.stopPrank();
    }

    function test_feeCeilingsAreEnforced() public {
        // Read the ceilings first: any call made after `expectRevert` is armed
        // would be treated as the call expected to revert.
        uint256 maxTrade = pad.MAX_TRADE_FEE_BPS();
        uint256 maxCreation = pad.MAX_CREATION_FEE();
        uint256 maxGrad = pad.MAX_GRADUATION_FEE_BPS();

        vm.startPrank(owner);
        vm.expectRevert(UnderwaterLaunchpad.FeeTooHigh.selector);
        pad.setTradeFeeBps(maxTrade + 1);

        vm.expectRevert(UnderwaterLaunchpad.FeeTooHigh.selector);
        pad.setCreationFee(maxCreation + 1);

        vm.expectRevert(UnderwaterLaunchpad.FeeTooHigh.selector);
        pad.setGraduationFeeBps(maxGrad + 1);

        // At the ceiling exactly is allowed.
        pad.setTradeFeeBps(maxTrade);
        pad.setCreationFee(maxCreation);
        pad.setGraduationFeeBps(maxGrad);
        vm.stopPrank();

        assertEq(pad.tradeFeeBps(), maxTrade);
        assertEq(pad.creationFee(), maxCreation);
        assertEq(pad.graduationFeeBps(), maxGrad);
    }

    function test_constructorRejectsExcessiveFees() public {
        vm.expectRevert(UnderwaterLaunchpad.FeeTooHigh.selector);
        new UnderwaterLaunchpad(owner, address(router), treasury, 201, 0, 0);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(Owned.ZeroAddress.selector);
        new UnderwaterLaunchpad(owner, address(0), treasury, 100, 0, 0);

        vm.expectRevert(Owned.ZeroAddress.selector);
        new UnderwaterLaunchpad(owner, address(router), address(0), 100, 0, 0);
    }

    function test_ownershipHandoverIsTwoStep() public {
        vm.prank(owner);
        pad.transferOwnership(bob);
        assertEq(pad.owner(), owner, "owner unchanged until accepted");

        vm.prank(alice);
        vm.expectRevert(Owned.NotPendingOwner.selector);
        pad.acceptOwnership();

        vm.prank(bob);
        pad.acceptOwnership();
        assertEq(pad.owner(), bob);
        assertEq(pad.pendingOwner(), address(0));
    }

    /// @dev The sweep must never be able to reach ETH backing a live curve.
    function test_sweepCannotTouchCurveFunds() public {
        address token = _launch();
        vm.prank(bob);
        pad.buy{value: 2 ether}(token, 0, bob);

        // Nothing unaccounted yet.
        vm.prank(owner);
        vm.expectRevert(UnderwaterLaunchpad.NothingToSweep.selector);
        pad.sweep(owner);

        // Donate stray ETH, which is the only thing sweepable.
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(pad).call{value: 0.4 ether}("");
        assertTrue(ok);

        uint256 curveEth = pad.totalCurveEth();
        vm.prank(owner);
        pad.sweep(owner);

        assertEq(owner.balance, 0.4 ether, "only the donation is swept");
        assertEq(address(pad).balance, curveEth, "curve funds intact");
    }

    function test_sweepRevertsToRejectingRecipient() public {
        RejectingRecipient bad = new RejectingRecipient();
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(pad).call{value: 0.1 ether}("");
        assertTrue(ok);

        vm.prank(owner);
        vm.expectRevert(UnderwaterLaunchpad.EthTransferFailed.selector);
        pad.sweep(address(bad));
    }

    // ─── Views ────────────────────────────────────────────────────────────

    function test_progressTracksRaise() public {
        address token = _launch();
        assertEq(pad.progressBps(token), 0);

        vm.prank(bob);
        pad.buy{value: 2 ether}(token, 0, bob);

        // 2 ETH minus 1% fee, against a 4 ETH target => ~49.5%.
        assertEq(pad.progressBps(token), ((2 ether - 0.02 ether) * 10_000) / 4 ether);
    }

    function test_spotPriceAndMarketCapRiseWithBuys() public {
        address token = _launch();
        uint256 price0 = pad.spotPriceE18(token);
        uint256 cap0 = pad.marketCapEth(token);

        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0, bob);

        assertGt(pad.spotPriceE18(token), price0);
        assertGt(pad.marketCapEth(token), cap0);
        // FDV at launch is the 1 ETH virtual seed.
        assertEq(cap0, 1 ether);
    }

    function test_tokensSliceIsPaginated() public {
        address a = _launch();
        address b = _launch();
        address c = _launch();

        address[] memory page = pad.tokensSlice(0, 2);
        assertEq(page.length, 2);
        assertEq(page[0], a);
        assertEq(page[1], b);

        page = pad.tokensSlice(2, 10);
        assertEq(page.length, 1);
        assertEq(page[0], c);

        assertEq(pad.tokensSlice(3, 5).length, 0, "past the end is empty");
    }

    function test_viewsRevertForUnknownToken() public {
        vm.expectRevert(UnderwaterLaunchpad.UnknownToken.selector);
        pad.quoteBuy(address(0xBEEF), 1 ether);
        vm.expectRevert(UnderwaterLaunchpad.UnknownToken.selector);
        pad.quoteSell(address(0xBEEF), 1 ether);
        vm.expectRevert(UnderwaterLaunchpad.UnknownToken.selector);
        pad.progressBps(address(0xBEEF));
        vm.expectRevert(UnderwaterLaunchpad.UnknownToken.selector);
        pad.spotPriceE18(address(0xBEEF));
        vm.expectRevert(UnderwaterLaunchpad.UnknownToken.selector);
        pad.marketCapEth(address(0xBEEF));
    }

    // ─── Token contract guarantees ────────────────────────────────────────

    function test_tokenHasNoMintPath() public {
        address token = _launch();
        uint256 supply = MemeToken(token).totalSupply();

        // Anyone can burn their own balance, and that is the only supply change.
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0, bob);
        uint256 bal = MemeToken(token).balanceOf(bob);

        vm.prank(bob);
        MemeToken(token).burn(bal);

        assertEq(MemeToken(token).totalSupply(), supply - bal);
        assertEq(MemeToken(token).balanceOf(bob), 0);
    }
}

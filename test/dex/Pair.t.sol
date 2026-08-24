// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterFactory} from "../../src/dex/UnderwaterFactory.sol";
import {UnderwaterPair} from "../../src/dex/UnderwaterPair.sol";
import {UnderwaterLibrary} from "../../src/dex/libraries/UnderwaterLibrary.sol";
import {ReentrancyGuard} from "../../src/utils/ReentrancyGuard.sol";
import {FlashBorrower, PairReenterer, TestERC20} from "./mocks/DexMocks.sol";
import {Test, stdError} from "forge-std/Test.sol";

contract PairTest is Test {
    UnderwaterFactory internal factory;
    UnderwaterPair internal pair;
    TestERC20 internal token0;
    TestERC20 internal token1;

    address internal constant OWNER = address(0xA11CE);
    address internal constant LP = address(0x1111);
    address internal constant TRADER = address(0x2222);
    address internal constant TREASURY = address(0xFEE);

    uint256 internal constant MINIMUM_LIQUIDITY = 10 ** 3;

    function setUp() public {
        factory = new UnderwaterFactory(OWNER);

        TestERC20 a = new TestERC20("A", "A");
        TestERC20 b = new TestERC20("B", "B");
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        pair = UnderwaterPair(factory.createPair(address(token0), address(token1)));
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _seed(uint256 amount0, uint256 amount1, address to) internal returns (uint256 liquidity) {
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        liquidity = pair.mint(to);
    }

    function _reserves() internal view returns (uint256 r0, uint256 r1) {
        (uint112 a, uint112 b,) = pair.getReserves();
        (r0, r1) = (a, b);
    }

    // ─── Mint ─────────────────────────────────────────────────────────────

    function test_firstMintIsGeometricMeanMinusLockedLiquidity() public {
        uint256 liquidity = _seed(1e18, 4e18, LP);

        // sqrt(1e18 * 4e18) = 2e18
        assertEq(liquidity, 2e18 - MINIMUM_LIQUIDITY, "first LP amount");
        assertEq(pair.balanceOf(LP), liquidity);
        assertEq(pair.balanceOf(address(0)), MINIMUM_LIQUIDITY, "minimum liquidity locked");
        assertEq(pair.totalSupply(), 2e18);

        (uint256 r0, uint256 r1) = _reserves();
        assertEq(r0, 1e18);
        assertEq(r1, 4e18);
    }

    function test_secondMintIsProportional() public {
        _seed(1e18, 4e18, LP);
        uint256 supplyBefore = pair.totalSupply();

        uint256 liquidity = _seed(0.5e18, 2e18, TRADER);

        assertEq(liquidity, supplyBefore / 2, "half the pool doubles nothing, mints half");
    }

    /// @dev Depositing off-ratio credits only the scarcer side, so the surplus
    ///      is donated rather than minted. This is what makes a lopsided donation
    ///      unprofitable.
    function test_offRatioMintCreditsTheScarcerSide() public {
        _seed(1e18, 4e18, LP);
        uint256 supplyBefore = pair.totalSupply();

        // 50% more token0 than the ratio calls for; only 100% of token1's share
        // is credited.
        uint256 liquidity = _seed(1.5e18, 4e18, TRADER);

        assertEq(liquidity, supplyBefore, "credited on token1, the scarce side");
    }

    function test_mintWithNothingSentReverts() public {
        _seed(1e18, 4e18, LP);

        vm.expectRevert(UnderwaterPair.InsufficientLiquidityMinted.selector);
        pair.mint(TRADER);
    }

    function test_donatingOneTokenMintsNothing() public {
        _seed(1e18, 4e18, LP);

        token0.mint(address(pair), 1e18);
        vm.expectRevert(UnderwaterPair.InsufficientLiquidityMinted.selector);
        pair.mint(TRADER);
    }

    function test_firstMintBelowMinimumLiquidityReverts() public {
        token0.mint(address(pair), 10);
        token1.mint(address(pair), 10);
        // sqrt(100) = 10 < MINIMUM_LIQUIDITY, so the subtraction underflows.
        vm.expectRevert(stdError.arithmeticError);
        pair.mint(LP);
    }

    // ─── Burn ─────────────────────────────────────────────────────────────

    function test_burnReturnsProRataReserves() public {
        uint256 liquidity = _seed(1e18, 4e18, LP);

        vm.prank(LP);
        pair.transfer(address(pair), liquidity);
        (uint256 amount0, uint256 amount1) = pair.burn(LP);

        // The locked MINIMUM_LIQUIDITY keeps a dust share behind.
        assertApproxEqRel(amount0, 1e18, 1e12, "token0 out");
        assertApproxEqRel(amount1, 4e18, 1e12, "token1 out");
        assertEq(token0.balanceOf(LP), amount0);
        assertEq(token1.balanceOf(LP), amount1);
        assertEq(pair.totalSupply(), MINIMUM_LIQUIDITY, "supply never returns to zero");
    }

    function test_burnWithoutSendingLpReverts() public {
        _seed(1e18, 4e18, LP);

        vm.expectRevert(UnderwaterPair.InsufficientLiquidityBurned.selector);
        pair.burn(LP);
    }

    function test_lockedLiquidityIsUnreachable() public {
        uint256 liquidity = _seed(1e18, 4e18, LP);
        vm.prank(LP);
        pair.transfer(address(pair), liquidity);
        pair.burn(LP);

        // address(0) holds the locked LP and cannot sign, so the last
        // MINIMUM_LIQUIDITY can never be redeemed.
        assertEq(pair.balanceOf(address(0)), MINIMUM_LIQUIDITY);
        (uint256 r0, uint256 r1) = _reserves();
        assertGt(r0, 0, "reserves never fully drain");
        assertGt(r1, 0);
    }

    // ─── Swap ─────────────────────────────────────────────────────────────

    function test_swapChargesThirtyBasisPoints() public {
        _seed(100e18, 100e18, LP);

        uint256 amountIn = 1e18;
        uint256 expectedOut = UnderwaterLibrary.getAmountOut(amountIn, 100e18, 100e18);

        token0.mint(address(pair), amountIn);
        pair.swap(0, expectedOut, TRADER, "");

        assertEq(token1.balanceOf(TRADER), expectedOut);
        // 0.3% of the input stays behind, so k strictly grows.
        (uint256 r0, uint256 r1) = _reserves();
        assertGt(r0 * r1, 100e18 * 100e18, "k grows by the fee");
    }

    function test_swapOneWeiBeyondTheQuoteReverts() public {
        _seed(100e18, 100e18, LP);

        uint256 amountIn = 1e18;
        uint256 quoted = UnderwaterLibrary.getAmountOut(amountIn, 100e18, 100e18);

        token0.mint(address(pair), amountIn);
        vm.expectRevert(UnderwaterPair.KInvariantViolated.selector);
        pair.swap(0, quoted + 1, TRADER, "");
    }

    function test_swapWithNoInputReverts() public {
        _seed(100e18, 100e18, LP);

        vm.expectRevert(UnderwaterPair.InsufficientInputAmount.selector);
        pair.swap(0, 1e18, TRADER, "");
    }

    function test_swapWithNoOutputReverts() public {
        _seed(100e18, 100e18, LP);

        vm.expectRevert(UnderwaterPair.InsufficientOutputAmount.selector);
        pair.swap(0, 0, TRADER, "");
    }

    function test_swapDrainingAReserveReverts() public {
        _seed(100e18, 100e18, LP);

        token0.mint(address(pair), 1e18);
        vm.expectRevert(UnderwaterPair.InsufficientLiquidity.selector);
        pair.swap(0, 100e18, TRADER, "");
    }

    /// @dev Paying out to a pool token would make the token's own balance the
    ///      "input", letting a caller fake a deposit.
    function test_swapToPoolTokenReverts() public {
        _seed(100e18, 100e18, LP);
        token0.mint(address(pair), 1e18);

        vm.expectRevert(UnderwaterPair.InvalidRecipient.selector);
        pair.swap(0, 1e17, address(token0), "");

        vm.expectRevert(UnderwaterPair.InvalidRecipient.selector);
        pair.swap(0, 1e17, address(token1), "");
    }

    function test_swapBothDirectionsAtOnce() public {
        _seed(100e18, 100e18, LP);

        // Send both sides in, take both sides out: valid as long as k holds.
        token0.mint(address(pair), 10e18);
        token1.mint(address(pair), 10e18);
        pair.swap(9e18, 9e18, TRADER, "");

        assertEq(token0.balanceOf(TRADER), 9e18);
        assertEq(token1.balanceOf(TRADER), 9e18);
    }

    // ─── Flash swaps ──────────────────────────────────────────────────────

    function test_flashSwapSucceedsWhenRepaidWithFee() public {
        _seed(100e18, 100e18, LP);

        FlashBorrower borrower = new FlashBorrower(address(pair));
        // Fund the borrower so it can cover the fee.
        token1.mint(address(borrower), 1e18);

        borrower.borrow(address(token1), 10e18);

        (uint256 r0, uint256 r1) = _reserves();
        assertEq(r0, 100e18, "untouched side");
        assertGt(r1, 100e18 - 10e18, "principal plus fee returned");
        assertGt(r0 * r1, 100e18 * 100e18, "k grew");
    }

    function test_flashSwapWithoutRepaymentReverts() public {
        _seed(100e18, 100e18, LP);

        FlashBorrower borrower = new FlashBorrower(address(pair));
        borrower.setRepay(false);

        vm.expectRevert(UnderwaterPair.InsufficientInputAmount.selector);
        borrower.borrow(address(token1), 10e18);
    }

    function test_reentrancyDuringFlashCallbackReverts() public {
        _seed(100e18, 100e18, LP);

        PairReenterer attacker = new PairReenterer(address(pair));
        token0.mint(address(pair), 1e18);

        vm.expectRevert(ReentrancyGuard.Reentrancy.selector);
        attacker.attack(0, 1e17);
    }

    // ─── Recovery ─────────────────────────────────────────────────────────

    function test_skimRecoversDonatedTokens() public {
        _seed(100e18, 100e18, LP);

        token0.mint(address(pair), 5e18);
        pair.skim(TRADER);

        assertEq(token0.balanceOf(TRADER), 5e18);
        (uint256 r0,) = _reserves();
        assertEq(r0, 100e18, "reserves unchanged");
        assertEq(token0.balanceOf(address(pair)), 100e18);
    }

    function test_syncAbsorbsDonatedTokensIntoReserves() public {
        _seed(100e18, 100e18, LP);

        token0.mint(address(pair), 5e18);
        pair.sync();

        (uint256 r0,) = _reserves();
        assertEq(r0, 105e18, "donation becomes reserve");
        assertEq(token0.balanceOf(TRADER), 0);
    }

    function test_reservesCannotExceedUint112() public {
        _seed(1e18, 1e18, LP);

        token0.mint(address(pair), uint256(type(uint112).max));
        vm.expectRevert(UnderwaterPair.Overflow.selector);
        pair.sync();
    }

    // ─── Protocol fee ─────────────────────────────────────────────────────

    function test_noProtocolFeeWhileSwitchedOff() public {
        _seed(100e18, 100e18, LP);
        _generateVolume(20);

        assertEq(pair.kLast(), 0, "kLast untracked while fee is off");

        _seed(1e18, 1e18, LP);
        assertEq(pair.balanceOf(TREASURY), 0, "nothing minted to the treasury");
    }

    function test_protocolFeeAccruesToTreasuryOnLiquidityEvents() public {
        vm.prank(OWNER);
        factory.setFeeTo(TREASURY);

        _seed(100e18, 100e18, LP);
        assertGt(pair.kLast(), 0, "kLast tracked once the fee is on");
        assertEq(pair.balanceOf(TREASURY), 0, "no fee on the first mint");

        _generateVolume(50);

        // Any liquidity event settles the accrued fee.
        _seed(1e18, 1e18, LP);
        uint256 treasuryLp = pair.balanceOf(TREASURY);
        assertGt(treasuryLp, 0, "treasury paid in LP tokens");

        // The protocol takes 1/6 of the 0.3%, i.e. 0.05% of volume — a small
        // slice of total supply, not a majority stake.
        assertLt(treasuryLp, pair.totalSupply() / 100, "fee is a slice, not a takeover");
    }

    function test_switchingFeeOffClearsTheMarker() public {
        vm.prank(OWNER);
        factory.setFeeTo(TREASURY);
        _seed(100e18, 100e18, LP);
        _generateVolume(10);

        vm.prank(OWNER);
        factory.setFeeTo(address(0));

        _seed(1e18, 1e18, LP);
        assertEq(pair.kLast(), 0, "marker cleared");
        assertEq(pair.balanceOf(TREASURY), 0, "no retroactive charge");
    }

    /// @dev Turning the fee back on must not bill for growth that accrued while
    ///      it was off.
    function test_feeCannotBeChargedRetroactively() public {
        _seed(100e18, 100e18, LP);
        _generateVolume(50);

        vm.prank(OWNER);
        factory.setFeeTo(TREASURY);

        // First liquidity event after switching on only sets the marker.
        _seed(1e18, 1e18, LP);
        assertEq(pair.balanceOf(TREASURY), 0, "no charge for pre-switch growth");
        assertGt(pair.kLast(), 0);
    }

    function _generateVolume(uint256 rounds) internal {
        for (uint256 i; i < rounds; ++i) {
            (uint256 r0, uint256 r1) = _reserves();
            uint256 out = UnderwaterLibrary.getAmountOut(1e18, r0, r1);
            token0.mint(address(pair), 1e18);
            pair.swap(0, out, TRADER, "");

            (r0, r1) = _reserves();
            uint256 back = UnderwaterLibrary.getAmountOut(out, r1, r0);
            vm.prank(TRADER);
            token1.transfer(address(pair), out);
            pair.swap(back, 0, TRADER, "");
        }
    }

    // ─── Invariants ───────────────────────────────────────────────────────

    function testFuzz_kNeverShrinksAcrossSwaps(uint256 amountIn, bool zeroForOne) public {
        _seed(1_000e18, 1_000e18, LP);
        amountIn = bound(amountIn, 1e6, 500e18);

        (uint256 r0, uint256 r1) = _reserves();
        uint256 kBefore = r0 * r1;

        if (zeroForOne) {
            uint256 out = UnderwaterLibrary.getAmountOut(amountIn, r0, r1);
            token0.mint(address(pair), amountIn);
            pair.swap(0, out, TRADER, "");
        } else {
            uint256 out = UnderwaterLibrary.getAmountOut(amountIn, r1, r0);
            token1.mint(address(pair), amountIn);
            pair.swap(out, 0, TRADER, "");
        }

        (r0, r1) = _reserves();
        assertGe(r0 * r1, kBefore, "k is monotonically non-decreasing");
    }

    function testFuzz_roundTripLosesTheFee(uint256 amountIn) public {
        _seed(1_000e18, 1_000e18, LP);
        amountIn = bound(amountIn, 1e12, 100e18);

        (uint256 r0, uint256 r1) = _reserves();
        uint256 out = UnderwaterLibrary.getAmountOut(amountIn, r0, r1);
        token0.mint(address(pair), amountIn);
        pair.swap(0, out, TRADER, "");

        (r0, r1) = _reserves();
        uint256 back = UnderwaterLibrary.getAmountOut(out, r1, r0);
        vm.prank(TRADER);
        token1.transfer(address(pair), out);
        pair.swap(back, 0, TRADER, "");

        assertLt(back, amountIn, "a round trip can never be profitable");
    }
}

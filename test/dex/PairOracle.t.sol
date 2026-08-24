// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterFactory} from "../../src/dex/UnderwaterFactory.sol";
import {UnderwaterPair} from "../../src/dex/UnderwaterPair.sol";
import {UQ112x112} from "../../src/dex/libraries/UQ112x112.sol";
import {UnderwaterLibrary} from "../../src/dex/libraries/UnderwaterLibrary.sol";
import {TestERC20} from "./mocks/DexMocks.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Tests for the two places `UnderwaterPair` deliberately relies on
///         wrapping arithmetic.
///
/// @dev These exist because porting Uniswap V2 from Solidity 0.5 to 0.8 turns
///      every silent wrap into a revert unless it is explicitly marked
///      `unchecked`. Marking too little bricks the oracle; marking too much
///      hides a real overflow. The two sites are the uint32 timestamp
///      subtraction and the price accumulators, and both are asserted directly
///      here rather than trusted to a code review.
contract PairOracleTest is Test {
    UnderwaterFactory internal factory;
    UnderwaterPair internal pair;
    TestERC20 internal token0;
    TestERC20 internal token1;

    address internal constant LP = address(0x1111);
    address internal constant TRADER = address(0x2222);

    /// @dev From `forge inspect UnderwaterPair storage`. The assertion inside
    ///      `_presetPrice0Cumulative` fails loudly if the layout ever moves.
    uint256 internal constant PRICE0_CUMULATIVE_SLOT = 9;

    function setUp() public {
        factory = new UnderwaterFactory(address(this));

        TestERC20 a = new TestERC20("A", "A");
        TestERC20 b = new TestERC20("B", "B");
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        pair = UnderwaterPair(factory.createPair(address(token0), address(token1)));

        // Start from a realistic timestamp rather than 1.
        vm.warp(1_700_000_000);
    }

    function _seed(uint256 amount0, uint256 amount1) internal {
        token0.mint(address(pair), amount0);
        token1.mint(address(pair), amount1);
        pair.mint(LP);
    }

    function _reserves() internal view returns (uint112 r0, uint112 r1) {
        (r0, r1,) = pair.getReserves();
    }

    function _expectedPrice0Delta(uint32 seconds_) internal view returns (uint256) {
        (uint112 r0, uint112 r1) = _reserves();
        return uint256(UQ112x112.uqdiv(UQ112x112.encode(r1), r0)) * seconds_;
    }

    function _presetPrice0Cumulative(uint256 value) internal {
        vm.store(address(pair), bytes32(PRICE0_CUMULATIVE_SLOT), bytes32(value));
        assertEq(pair.price0CumulativeLast(), value, "storage slot for price0CumulativeLast moved");
    }

    // ─── Normal accumulation ──────────────────────────────────────────────

    function test_noAccumulationBeforeFirstLiquidity() public {
        vm.warp(block.timestamp + 1 hours);
        pair.sync();

        assertEq(pair.price0CumulativeLast(), 0, "empty pool has no price");
        assertEq(pair.price1CumulativeLast(), 0);
    }

    function test_accumulatorsAdvanceByPriceTimesElapsedSeconds() public {
        _seed(1e18, 4e18);
        uint256 before0 = pair.price0CumulativeLast();
        uint256 before1 = pair.price1CumulativeLast();

        (uint112 r0, uint112 r1) = _reserves();
        vm.warp(block.timestamp + 3600);
        pair.sync();

        assertEq(
            pair.price0CumulativeLast() - before0,
            uint256(UQ112x112.uqdiv(UQ112x112.encode(r1), r0)) * 3600,
            "price0 accumulator"
        );
        assertEq(
            pair.price1CumulativeLast() - before1,
            uint256(UQ112x112.uqdiv(UQ112x112.encode(r0), r1)) * 3600,
            "price1 accumulator"
        );
    }

    function test_noAccumulationWithinTheSameTimestamp() public {
        _seed(1e18, 4e18);
        vm.warp(block.timestamp + 60);
        pair.sync();

        uint256 snapshot = pair.price0CumulativeLast();
        pair.sync();
        pair.sync();

        assertEq(pair.price0CumulativeLast(), snapshot, "same second contributes nothing");
    }

    /// @dev The accumulator records the price as it stood *before* the update,
    ///      which is what makes a TWAP resistant to a single-block manipulation:
    ///      a price moved and moved back within one block never gets weighted.
    function test_accumulatorUsesThePriceBeforeTheUpdate() public {
        _seed(100e18, 100e18);
        (uint112 r0, uint112 r1) = _reserves();
        uint256 before0 = pair.price0CumulativeLast();

        vm.warp(block.timestamp + 10);

        // Move the price hard in the same call that accumulates.
        uint256 amountIn = 50e18;
        uint256 out = UnderwaterLibrary.getAmountOut(amountIn, r0, r1);
        token0.mint(address(pair), amountIn);
        pair.swap(0, out, TRADER, "");

        assertEq(
            pair.price0CumulativeLast() - before0,
            uint256(UQ112x112.uqdiv(UQ112x112.encode(r1), r0)) * 10,
            "the pre-swap price is what got weighted"
        );
    }

    function test_twapOverTwoSnapshotsSitsBetweenTheSpotPrices() public {
        _seed(100e18, 100e18);
        vm.warp(block.timestamp + 1);
        pair.sync();

        uint256 startCumulative = pair.price0CumulativeLast();
        uint32 startTime = _lastTimestamp();
        uint256 spotBefore = uint256(UQ112x112.uqdiv(UQ112x112.encode(_r1()), _r0()));

        // Hold the old price for an hour, then move it and hold for an hour.
        vm.warp(block.timestamp + 3600);
        (uint112 r0, uint112 r1) = _reserves();
        uint256 out = UnderwaterLibrary.getAmountOut(10e18, r0, r1);
        token0.mint(address(pair), 10e18);
        pair.swap(0, out, TRADER, "");

        uint256 spotAfter = uint256(UQ112x112.uqdiv(UQ112x112.encode(_r1()), _r0()));
        vm.warp(block.timestamp + 3600);
        pair.sync();

        uint32 elapsed = _lastTimestamp() - startTime;
        uint256 twap = (pair.price0CumulativeLast() - startCumulative) / elapsed;

        assertLt(spotAfter, spotBefore, "selling token0 for token1 lowers price0");
        assertLt(twap, spotBefore, "TWAP lags the old price");
        assertGt(twap, spotAfter, "TWAP has not fully caught up to the new price");
    }

    // ─── Wrapping site 1: the uint32 timestamp ────────────────────────────

    /// @dev Past 07 Feb 2106 the truncated timestamp wraps. If the subtraction
    ///      in `_update` were checked, every swap would revert from that instant
    ///      onward and the pool would be permanently frozen.
    function test_oracleSurvivesTheUint32TimestampRollover() public {
        _seed(1e18, 4e18);

        uint256 rollover = 2 ** 32;
        vm.warp(rollover - 10);
        pair.sync();
        assertEq(_lastTimestamp(), uint32(rollover - 10), "pre-rollover stamp");

        uint256 before0 = pair.price0CumulativeLast();
        uint256 expected = _expectedPrice0Delta(60);

        // 10 seconds to the rollover, then 50 past it.
        vm.warp(rollover + 50);
        pair.sync();

        assertEq(_lastTimestamp(), 50, "stamp wrapped to the low side");
        assertEq(pair.price0CumulativeLast() - before0, expected, "60 seconds still counted as 60");
    }

    function test_swapsKeepWorkingAfterTheRollover() public {
        _seed(100e18, 100e18);
        vm.warp(2 ** 32 + 1000);

        (uint112 r0, uint112 r1) = _reserves();
        uint256 out = UnderwaterLibrary.getAmountOut(1e18, r0, r1);
        token0.mint(address(pair), 1e18);
        pair.swap(0, out, TRADER, "");

        assertEq(token1.balanceOf(TRADER), out, "trading is unaffected by the rollover");
    }

    // ─── Wrapping site 2: the price accumulators ──────────────────────────

    /// @dev The accumulators are unbounded sums and *will* overflow eventually.
    ///      A TWAP consumer reads a difference between two snapshots, and that
    ///      difference stays correct through a wrap — so wrapping must not revert.
    function test_accumulatorWrapsAndTheSnapshotDifferenceStaysCorrect() public {
        _seed(1e18, 4e18);

        uint256 expected = _expectedPrice0Delta(3600);
        // Park the accumulator close enough to the top that one hour overflows it.
        uint256 start = type(uint256).max - expected / 2;
        _presetPrice0Cumulative(start);

        vm.warp(block.timestamp + 3600);
        pair.sync();

        uint256 after0 = pair.price0CumulativeLast();
        assertLt(after0, start, "the accumulator wrapped past the top");

        unchecked {
            assertEq(after0 - start, expected, "wrapping subtraction recovers the true elapsed price");
        }
    }

    function testFuzz_accumulatorDifferenceIsCorrectFromAnyStartingPoint(uint256 start, uint32 elapsed)
        public
    {
        _seed(1e18, 4e18);
        elapsed = uint32(bound(elapsed, 1, 30 days));
        _presetPrice0Cumulative(start);

        uint256 expected = _expectedPrice0Delta(elapsed);
        vm.warp(block.timestamp + elapsed);
        pair.sync();

        unchecked {
            assertEq(pair.price0CumulativeLast() - start, expected);
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    function _lastTimestamp() internal view returns (uint32 stamp) {
        (,, stamp) = pair.getReserves();
    }

    function _r0() internal view returns (uint112 r0) {
        (r0,,) = pair.getReserves();
    }

    function _r1() internal view returns (uint112 r1) {
        (, r1,) = pair.getReserves();
    }
}

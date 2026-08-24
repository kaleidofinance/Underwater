// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CurveMath} from "../src/lib/CurveMath.sol";
import {Test} from "forge-std/Test.sol";

/// @dev Library calls are inlined, so `vm.expectRevert` cannot observe them.
///      This harness turns them into real external calls.
contract CurveMathHarness {
    function tokensOut(uint256 x, uint256 y, uint256 dx) external pure returns (uint256) {
        return CurveMath.tokensOut(x, y, dx);
    }

    function ethOut(uint256 x, uint256 y, uint256 dy) external pure returns (uint256) {
        return CurveMath.ethOut(x, y, dy);
    }

    function ethInForTokens(uint256 x, uint256 y, uint256 dy) external pure returns (uint256) {
        return CurveMath.ethInForTokens(x, y, dy);
    }
}

/// @notice Properties of the bonding curve itself, independent of the launchpad.
contract CurveMathTest is Test {
    uint256 constant VIRTUAL_ETH = 1 ether;
    uint256 constant Y0 = 1_000_000_000e18;
    uint256 constant CURVE_SUPPLY = 800_000_000e18;
    uint256 constant GRADUATION_ETH = 4 ether;

    CurveMathHarness harness;

    function setUp() public {
        harness = new CurveMathHarness();
    }

    /// @dev The whole parameter choice rests on this identity: draining the
    ///      800M curve float must raise exactly the graduation threshold.
    function test_fullCurveRaisesExactlyGraduationEth() public {
        uint256 ethNeeded = CurveMath.ethInForTokens(VIRTUAL_ETH, Y0, CURVE_SUPPLY);
        assertEq(ethNeeded, GRADUATION_ETH, "curve must raise exactly 4 ETH");
    }

    /// @dev And the token side must bind at the same moment as the ETH side.
    function test_graduationEthBuysExactlyCurveSupply() public {
        uint256 out = CurveMath.tokensOut(VIRTUAL_ETH, Y0, GRADUATION_ETH);
        assertEq(out, CURVE_SUPPLY, "4 ETH must buy exactly 800M tokens");
    }

    function test_priceRisesWithSupply() public {
        uint256 startPrice = CurveMath.spotPriceE18(VIRTUAL_ETH, Y0);
        uint256 endPrice = CurveMath.spotPriceE18(VIRTUAL_ETH + GRADUATION_ETH, Y0 - CURVE_SUPPLY);
        assertGt(endPrice, startPrice);
        // 1e18/1e27 = 1e-9 ETH, rising to 5e18/2e26 = 2.5e-8 ETH: a 25x move.
        assertEq(startPrice, 1e9);
        assertEq(endPrice, 25e9);
    }

    /// @dev Buying in two steps must never beat buying in one. If it did, a
    ///      trader could mill the curve by splitting orders.
    function testFuzz_splittingBuysIsNeverProfitable(uint256 a, uint256 b) public {
        uint256 first = bound(a, 1e6, GRADUATION_ETH / 2);
        uint256 second = bound(b, 1e6, GRADUATION_ETH / 2);

        uint256 out1 = CurveMath.tokensOut(VIRTUAL_ETH, Y0, first);
        uint256 out2 = CurveMath.tokensOut(VIRTUAL_ETH + first, Y0 - out1, second);
        uint256 split = out1 + out2;

        uint256 single = CurveMath.tokensOut(VIRTUAL_ETH, Y0, first + second);

        assertLe(split, single, "splitting must not yield more tokens");
    }

    /// @dev An immediate round trip must never return more ETH than went in,
    ///      even before fees. This is the core no-free-money property.
    function testFuzz_roundTripNeverProfitable(uint256 seed) public {
        uint256 ethIn = bound(seed, 1e6, GRADUATION_ETH);

        uint256 tokens = CurveMath.tokensOut(VIRTUAL_ETH, Y0, ethIn);
        uint256 back = CurveMath.ethOut(VIRTUAL_ETH + ethIn, Y0 - tokens, tokens);

        assertLe(back, ethIn, "round trip must not be profitable");
    }

    /// @dev Rounding must only ever grow k, never shrink it.
    function testFuzz_kNeverDecreasesOnBuy(uint256 seed) public {
        uint256 ethIn = bound(seed, 1, GRADUATION_ETH);

        uint256 kBefore = VIRTUAL_ETH * Y0;
        uint256 tokens = CurveMath.tokensOut(VIRTUAL_ETH, Y0, ethIn);
        uint256 kAfter = (VIRTUAL_ETH + ethIn) * (Y0 - tokens);

        assertGe(kAfter, kBefore, "k must not decrease on buy");
    }

    function testFuzz_kNeverDecreasesOnSell(uint256 seed, uint256 bpsSeed) public {
        uint256 ethIn = bound(seed, 1e9, GRADUATION_ETH);
        uint256 sellBps = bound(bpsSeed, 1, 10_000);

        uint256 tokens = CurveMath.tokensOut(VIRTUAL_ETH, Y0, ethIn);
        uint256 x = VIRTUAL_ETH + ethIn;
        uint256 y = Y0 - tokens;

        uint256 sellAmount = (tokens * sellBps) / 10_000;
        if (sellAmount == 0) return;

        uint256 kBefore = x * y;
        uint256 out = CurveMath.ethOut(x, y, sellAmount);
        uint256 kAfter = (x - out) * (y + sellAmount);

        assertGe(kAfter, kBefore, "k must not decrease on sell");
    }

    /// @dev `ethInForTokens` must be a sound inverse of `tokensOut`: paying the
    ///      quoted amount must actually deliver the tokens requested.
    function testFuzz_ethInForTokensIsSufficient(uint256 seed) public {
        uint256 wanted = bound(seed, 1e18, CURVE_SUPPLY);

        uint256 ethNeeded = CurveMath.ethInForTokens(VIRTUAL_ETH, Y0, wanted);
        uint256 delivered = CurveMath.tokensOut(VIRTUAL_ETH, Y0, ethNeeded);

        assertGe(delivered, wanted, "quoted ETH must deliver the tokens");
    }

    function test_zeroInputsReturnZero() public {
        assertEq(CurveMath.tokensOut(VIRTUAL_ETH, Y0, 0), 0);
        assertEq(CurveMath.ethOut(VIRTUAL_ETH, Y0, 0), 0);
        assertEq(CurveMath.ethInForTokens(VIRTUAL_ETH, Y0, 0), 0);
    }

    function test_ethInForTokensRevertsAtOrAboveReserve() public {
        vm.expectRevert(CurveMath.InsufficientReserve.selector);
        harness.ethInForTokens(VIRTUAL_ETH, Y0, Y0);

        vm.expectRevert(CurveMath.InsufficientReserve.selector);
        harness.ethInForTokens(VIRTUAL_ETH, Y0, Y0 + 1);
    }
}

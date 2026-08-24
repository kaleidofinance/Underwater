// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterFactory} from "../../src/dex/UnderwaterFactory.sol";
import {UnderwaterPair} from "../../src/dex/UnderwaterPair.sol";
import {UnderwaterRouter} from "../../src/dex/UnderwaterRouter.sol";
import {UnderwaterLibrary} from "../../src/dex/libraries/UnderwaterLibrary.sol";
import {TaxToken, TestERC20, WETH9} from "./mocks/DexMocks.sol";
import {Test} from "forge-std/Test.sol";

contract RouterTest is Test {
    UnderwaterFactory internal factory;
    UnderwaterRouter internal router;
    WETH9 internal weth;
    TestERC20 internal tokenA;
    TestERC20 internal tokenB;

    address internal constant OWNER = address(0xA11CE);
    address internal alice;
    address internal constant BOB = address(0xB0B);

    uint256 internal constant ALICE_PK = 0xA11CE;
    uint256 internal deadline;

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public {
        alice = vm.addr(ALICE_PK);

        factory = new UnderwaterFactory(OWNER);
        weth = new WETH9();
        router = new UnderwaterRouter(address(factory), address(weth));

        tokenA = new TestERC20("Token A", "A");
        tokenB = new TestERC20("Token B", "B");

        vm.warp(1_700_000_000);
        deadline = block.timestamp + 1 hours;

        tokenA.mint(alice, 1_000_000e18);
        tokenB.mint(alice, 1_000_000e18);
        vm.deal(alice, 1_000 ether);

        vm.startPrank(alice);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _pair(address a, address b) internal view returns (UnderwaterPair) {
        return UnderwaterPair(factory.getPair(a, b));
    }

    function _seedEthPool(TestERC20 token, uint256 tokenAmount, uint256 ethAmount) internal {
        vm.prank(alice);
        router.addLiquidityETH{value: ethAmount}(
            address(token), tokenAmount, 0, 0, alice, block.timestamp + 1 hours
        );
    }

    function _path2(address a, address b) internal pure returns (address[] memory path) {
        path = new address[](2);
        path[0] = a;
        path[1] = b;
    }

    function _path3(address a, address b, address c) internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = a;
        path[1] = b;
        path[2] = c;
    }

    // ─── Add liquidity ────────────────────────────────────────────────────

    function test_addLiquidityEthCreatesThePoolOnDemand() public {
        assertEq(factory.getPair(address(tokenA), address(weth)), address(0), "no pool yet");

        vm.prank(alice);
        (uint256 amountToken, uint256 amountETH, uint256 liquidity) =
            router.addLiquidityETH{value: 10 ether}(address(tokenA), 1_000e18, 0, 0, alice, deadline);

        UnderwaterPair pair = _pair(address(tokenA), address(weth));
        assertTrue(address(pair) != address(0), "pool created");
        assertEq(amountToken, 1_000e18);
        assertEq(amountETH, 10 ether);
        assertEq(pair.balanceOf(alice), liquidity);
        assertEq(weth.balanceOf(address(pair)), 10 ether, "ETH was wrapped into the pool");
        assertEq(tokenA.balanceOf(address(pair)), 1_000e18);
    }

    function test_addLiquidityEthRefundsWhatThePoolRatioRejects() public {
        _seedEthPool(tokenA, 1_000e18, 10 ether);

        uint256 balanceBefore = alice.balance;

        // Offer twice the ETH the ratio calls for; the surplus comes back.
        vm.prank(alice);
        (uint256 amountToken, uint256 amountETH,) =
            router.addLiquidityETH{value: 20 ether}(address(tokenA), 1_000e18, 0, 0, alice, deadline);

        assertEq(amountToken, 1_000e18);
        assertEq(amountETH, 10 ether, "only the matching ETH is consumed");
        assertEq(balanceBefore - alice.balance, 10 ether, "the other 10 ETH was refunded");
    }

    function test_addLiquidityScalesDownTheSurplusSide() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 1_000e18, 1_000e18, 0, 0, alice, deadline);

        // Offer 2:1 into a 1:1 pool.
        vm.prank(alice);
        (uint256 amountA, uint256 amountB,) =
            router.addLiquidity(address(tokenA), address(tokenB), 200e18, 100e18, 0, 0, alice, deadline);

        assertEq(amountA, 100e18, "token A scaled down to the pool ratio");
        assertEq(amountB, 100e18);
    }

    function test_addLiquiditySlippageGuardReverts() public {
        _seedEthPool(tokenA, 1_000e18, 10 ether);

        // Demanding all 20 ETH be used when the ratio only allows 10.
        vm.prank(alice);
        vm.expectRevert(UnderwaterRouter.InsufficientBAmount.selector);
        router.addLiquidityETH{value: 20 ether}(address(tokenA), 1_000e18, 0, 20 ether, alice, deadline);
    }

    function test_expiredDeadlineReverts() public {
        vm.prank(alice);
        vm.expectRevert(UnderwaterRouter.Expired.selector);
        router.addLiquidityETH{value: 1 ether}(address(tokenA), 1_000e18, 0, 0, alice, block.timestamp - 1);
    }

    // ─── Remove liquidity ─────────────────────────────────────────────────

    function test_removeLiquidityEthReturnsTokensAndNativeEth() public {
        _seedEthPool(tokenA, 1_000e18, 10 ether);
        UnderwaterPair pair = _pair(address(tokenA), address(weth));
        uint256 liquidity = pair.balanceOf(alice);

        uint256 ethBefore = alice.balance;
        uint256 tokenBefore = tokenA.balanceOf(alice);

        vm.startPrank(alice);
        pair.approve(address(router), liquidity);
        (uint256 amountToken, uint256 amountETH) =
            router.removeLiquidityETH(address(tokenA), liquidity, 0, 0, alice, deadline);
        vm.stopPrank();

        assertEq(alice.balance - ethBefore, amountETH, "paid out as native ETH, not WETH");
        assertEq(tokenA.balanceOf(alice) - tokenBefore, amountToken);
        assertApproxEqRel(amountETH, 10 ether, 1e12);
        assertEq(pair.balanceOf(alice), 0);
    }

    function test_removeLiquiditySlippageGuardReverts() public {
        _seedEthPool(tokenA, 1_000e18, 10 ether);
        UnderwaterPair pair = _pair(address(tokenA), address(weth));
        uint256 liquidity = pair.balanceOf(alice);

        vm.startPrank(alice);
        pair.approve(address(router), liquidity);
        vm.expectRevert(UnderwaterRouter.InsufficientBAmount.selector);
        router.removeLiquidityETH(address(tokenA), liquidity, 0, 11 ether, alice, deadline);
        vm.stopPrank();
    }

    function test_removeLiquidityEthWithPermitNeedsNoApproval() public {
        _seedEthPool(tokenA, 1_000e18, 10 ether);
        UnderwaterPair pair = _pair(address(tokenA), address(weth));
        uint256 liquidity = pair.balanceOf(alice);

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                pair.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        PERMIT_TYPEHASH, alice, address(router), liquidity, pair.nonces(alice), deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_PK, digest);

        assertEq(pair.allowance(alice, address(router)), 0, "no prior approval");

        vm.prank(alice);
        (uint256 amountToken, uint256 amountETH) = router.removeLiquidityETHWithPermit(
            address(tokenA), liquidity, 0, 0, alice, deadline, false, v, r, s
        );

        assertGt(amountToken, 0);
        assertGt(amountETH, 0);
        assertEq(pair.balanceOf(alice), 0);
    }

    // ─── Swap ─────────────────────────────────────────────────────────────

    function test_swapExactTokensForTokensMatchesTheQuote() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 10_000e18, 10_000e18, 0, 0, alice, deadline);

        address[] memory path = _path2(address(tokenA), address(tokenB));
        uint256[] memory quoted = router.getAmountsOut(100e18, path);

        vm.prank(alice);
        uint256[] memory amounts = router.swapExactTokensForTokens(100e18, quoted[1], path, BOB, deadline);

        assertEq(amounts[1], quoted[1], "execution matches the quote exactly");
        assertEq(tokenB.balanceOf(BOB), quoted[1]);
    }

    function test_swapExactTokensForTokensRespectsMinimumOut() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 10_000e18, 10_000e18, 0, 0, alice, deadline);

        address[] memory path = _path2(address(tokenA), address(tokenB));
        uint256 quoted = router.getAmountsOut(100e18, path)[1];

        vm.prank(alice);
        vm.expectRevert(UnderwaterRouter.InsufficientOutputAmount.selector);
        router.swapExactTokensForTokens(100e18, quoted + 1, path, BOB, deadline);
    }

    function test_swapTokensForExactTokensRespectsMaximumIn() public {
        vm.prank(alice);
        router.addLiquidity(address(tokenA), address(tokenB), 10_000e18, 10_000e18, 0, 0, alice, deadline);

        address[] memory path = _path2(address(tokenA), address(tokenB));
        uint256 required = router.getAmountsIn(100e18, path)[0];

        vm.prank(alice);
        vm.expectRevert(UnderwaterRouter.ExcessiveInputAmount.selector);
        router.swapTokensForExactTokens(100e18, required - 1, path, BOB, deadline);

        vm.prank(alice);
        uint256[] memory amounts = router.swapTokensForExactTokens(100e18, required, path, BOB, deadline);
        assertEq(amounts[0], required);
        assertEq(tokenB.balanceOf(BOB), 100e18, "exact output delivered");
    }

    function test_swapExactEthForTokens() public {
        _seedEthPool(tokenA, 10_000e18, 100 ether);

        address[] memory path = _path2(address(weth), address(tokenA));
        uint256 quoted = router.getAmountsOut(1 ether, path)[1];

        vm.prank(alice);
        router.swapExactETHForTokens{value: 1 ether}(quoted, path, BOB, deadline);

        assertEq(tokenA.balanceOf(BOB), quoted);
    }

    function test_swapExactTokensForEth() public {
        _seedEthPool(tokenA, 10_000e18, 100 ether);

        address[] memory path = _path2(address(tokenA), address(weth));
        uint256 quoted = router.getAmountsOut(100e18, path)[1];

        vm.prank(alice);
        router.swapExactTokensForETH(100e18, quoted, path, BOB, deadline);

        assertEq(BOB.balance, quoted, "received native ETH");
        assertEq(weth.balanceOf(BOB), 0, "not left as WETH");
    }

    function test_swapTokensForExactEth() public {
        _seedEthPool(tokenA, 10_000e18, 100 ether);

        address[] memory path = _path2(address(tokenA), address(weth));
        uint256 required = router.getAmountsIn(1 ether, path)[0];

        vm.prank(alice);
        router.swapTokensForExactETH(1 ether, required, path, BOB, deadline);

        assertEq(BOB.balance, 1 ether);
    }

    function test_swapEthForExactTokensRefundsTheSurplus() public {
        _seedEthPool(tokenA, 10_000e18, 100 ether);

        address[] memory path = _path2(address(weth), address(tokenA));
        uint256 required = router.getAmountsIn(100e18, path)[0];
        uint256 balanceBefore = alice.balance;

        vm.prank(alice);
        router.swapETHForExactTokens{value: required + 5 ether}(100e18, path, BOB, deadline);

        assertEq(tokenA.balanceOf(BOB), 100e18);
        assertEq(balanceBefore - alice.balance, required, "the extra 5 ETH came back");
    }

    function test_multiHopRoutesThroughWeth() public {
        _seedEthPool(tokenA, 10_000e18, 100 ether);
        _seedEthPool(tokenB, 20_000e18, 100 ether);

        address[] memory path = _path3(address(tokenA), address(weth), address(tokenB));
        uint256[] memory quoted = router.getAmountsOut(100e18, path);

        vm.prank(alice);
        uint256[] memory amounts = router.swapExactTokensForTokens(100e18, quoted[2], path, BOB, deadline);

        assertEq(amounts[2], quoted[2]);
        assertEq(tokenB.balanceOf(BOB), quoted[2]);
        assertEq(weth.balanceOf(address(router)), 0, "no intermediate token parked in the router");
    }

    function test_ethPathMustStartOrEndWithWeth() public {
        _seedEthPool(tokenA, 10_000e18, 100 ether);

        address[] memory wrongIn = _path2(address(tokenA), address(weth));
        vm.prank(alice);
        vm.expectRevert(UnderwaterRouter.InvalidPath.selector);
        router.swapExactETHForTokens{value: 1 ether}(0, wrongIn, BOB, deadline);

        address[] memory wrongOut = _path2(address(weth), address(tokenA));
        vm.prank(alice);
        vm.expectRevert(UnderwaterRouter.InvalidPath.selector);
        router.swapExactTokensForETH(1e18, 0, wrongOut, BOB, deadline);
    }

    function test_swapThroughAMissingPoolReverts() public {
        address[] memory path = _path2(address(tokenA), address(tokenB));

        vm.prank(alice);
        vm.expectRevert(UnderwaterLibrary.PairNotFound.selector);
        router.swapExactTokensForTokens(1e18, 0, path, BOB, deadline);
    }

    // ─── Fee-on-transfer tokens ───────────────────────────────────────────

    function test_taxedTokenNeedsTheSupportingVariant() public {
        TaxToken tax = new TaxToken();
        tax.mint(alice, 100_000e18);
        vm.startPrank(alice);
        tax.approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: 100 ether}(address(tax), 10_000e18, 0, 0, alice, deadline);
        vm.stopPrank();

        address[] memory path = _path2(address(tax), address(weth));

        // The plain variant assumes the pool received the full amount, so the
        // quote overshoots and the k check rejects it.
        vm.prank(alice);
        vm.expectRevert(UnderwaterPair.KInvariantViolated.selector);
        router.swapExactTokensForETH(100e18, 0, path, BOB, deadline);

        // The supporting variant measures what actually arrived.
        vm.prank(alice);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(100e18, 0, path, BOB, deadline);
        assertGt(BOB.balance, 0, "taxed sell settled in ETH");
    }

    function test_supportingVariantEnforcesMinimumOut() public {
        TaxToken tax = new TaxToken();
        tax.mint(alice, 100_000e18);
        vm.startPrank(alice);
        tax.approve(address(router), type(uint256).max);
        router.addLiquidityETH{value: 100 ether}(address(tax), 10_000e18, 0, 0, alice, deadline);
        vm.stopPrank();

        address[] memory path = _path2(address(tax), address(weth));

        vm.prank(alice);
        vm.expectRevert(UnderwaterRouter.InsufficientOutputAmount.selector);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(100e18, 100 ether, path, BOB, deadline);
    }

    // ─── Router hygiene ───────────────────────────────────────────────────

    function test_routerRejectsStrayEth() public {
        vm.deal(BOB, 1 ether);
        vm.prank(BOB);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "only WETH may push ETH to the router");
    }

    function test_routerHoldsNothingBetweenCalls() public {
        _seedEthPool(tokenA, 10_000e18, 100 ether);
        address[] memory path = _path2(address(weth), address(tokenA));

        vm.prank(alice);
        router.swapExactETHForTokens{value: 5 ether}(0, path, BOB, deadline);

        assertEq(address(router).balance, 0, "no ETH retained");
        assertEq(weth.balanceOf(address(router)), 0, "no WETH retained");
        assertEq(tokenA.balanceOf(address(router)), 0, "no tokens retained");
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(UnderwaterRouter.ZeroAddress.selector);
        new UnderwaterRouter(address(0), address(weth));

        vm.expectRevert(UnderwaterRouter.ZeroAddress.selector);
        new UnderwaterRouter(address(factory), address(0));
    }

    function test_immutableConfigIsExposed() public view {
        assertEq(router.factory(), address(factory));
        assertEq(router.WETH(), address(weth));
    }

    // ─── Invariants ───────────────────────────────────────────────────────

    function testFuzz_quotedOutputAlwaysMatchesExecution(uint256 amountIn) public {
        _seedEthPool(tokenA, 100_000e18, 1_000 ether);
        amountIn = bound(amountIn, 1e12, 100 ether);
        vm.deal(alice, amountIn + 1 ether);

        address[] memory path = _path2(address(weth), address(tokenA));
        uint256 quoted = router.getAmountsOut(amountIn, path)[1];

        vm.prank(alice);
        router.swapExactETHForTokens{value: amountIn}(quoted, path, BOB, deadline);

        assertEq(tokenA.balanceOf(BOB), quoted);
    }

    function testFuzz_exactOutputCostsAtLeastTheQuotedInput(uint256 amountOut) public {
        _seedEthPool(tokenA, 100_000e18, 1_000 ether);
        amountOut = bound(amountOut, 1e12, 10_000e18);

        address[] memory path = _path2(address(weth), address(tokenA));
        uint256 required = router.getAmountsIn(amountOut, path)[0];
        vm.deal(alice, required + 1 ether);

        // One wei less must never be enough.
        vm.prank(alice);
        vm.expectRevert(UnderwaterRouter.ExcessiveInputAmount.selector);
        router.swapETHForExactTokens{value: required - 1}(amountOut, path, BOB, deadline);

        vm.prank(alice);
        router.swapETHForExactTokens{value: required}(amountOut, path, BOB, deadline);
        assertEq(tokenA.balanceOf(BOB), amountOut);
    }
}

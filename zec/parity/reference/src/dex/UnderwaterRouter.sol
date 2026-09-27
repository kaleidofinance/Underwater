// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import {IERC20Minimal, IUnderwaterFactory, IUnderwaterPair, IWETH} from "./interfaces/IUnderwaterDex.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {UnderwaterLibrary} from "./libraries/UnderwaterLibrary.sol";

/// @title UnderwaterRouter
/// @notice Front door to the Underwater DEX: wraps ETH, resolves pools,
///         enforces slippage and deadlines, and chains multi-hop swaps.
///
/// @dev Ownerless and immutable by construction — it holds no funds between
///      calls and has no privileged functions, so there is nothing to govern.
///      Every entry point is stateless: tokens move from the caller straight
///      into a pool within the same call.
///
///      The ABI matches `UniswapV2Router02` for every function it implements,
///      so existing wallets, aggregators and bots work against it unchanged.
///      That compatibility is also what lets `UnderwaterLaunchpad` point at this
///      router through its existing `IUniswapV2Router02` interface with no
///      change to the launchpad at all.
contract UnderwaterRouter {
    error Expired();
    error InsufficientAAmount();
    error InsufficientBAmount();
    error ExcessiveInputAmount();
    error InsufficientOutputAmount();
    error InvalidPath();
    error OnlyWeth();
    error ZeroAddress();

    address public immutable factory;
    address public immutable WETH;

    /// @dev A deadline is user-supplied trade expiry, not a security boundary.
    modifier ensure(uint256 deadline) {
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    constructor(address factory_, address weth_) {
        if (factory_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        factory = factory_;
        WETH = weth_;
    }

    /// @dev Only WETH may push ETH here — that is the refund leg of `withdraw`.
    ///      Rejecting everything else means a stray transfer cannot sit in the
    ///      router waiting to be swept by the next caller.
    receive() external payable {
        if (msg.sender != WETH) revert OnlyWeth();
    }

    // ─── Add liquidity ────────────────────────────────────────────────────

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        (amountA, amountB) =
            _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = UnderwaterLibrary.pairFor(factory, tokenA, tokenB);
        SafeTransferLib.safeTransferFrom(tokenA, msg.sender, pair, amountA);
        SafeTransferLib.safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = IUnderwaterPair(pair).mint(to);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        (amountToken, amountETH) =
            _addLiquidity(token, WETH, amountTokenDesired, msg.value, amountTokenMin, amountETHMin);
        address pair = UnderwaterLibrary.pairFor(factory, token, WETH);
        SafeTransferLib.safeTransferFrom(token, msg.sender, pair, amountToken);
        IWETH(WETH).deposit{value: amountETH}();
        SafeTransferLib.safeTransfer(WETH, pair, amountETH);
        liquidity = IUnderwaterPair(pair).mint(to);
        // Refund the dust the pool ratio would not accept. The launchpad relies
        // on this to keep its graduation accounting exact.
        if (msg.value > amountETH) SafeTransferLib.safeTransferETH(msg.sender, msg.value - amountETH);
    }

    // ─── Remove liquidity ─────────────────────────────────────────────────

    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = UnderwaterLibrary.pairFor(factory, tokenA, tokenB);
        // The LP token is `UnderwaterPair` itself, whose `transferFrom` either
        // reverts or returns true — it has no false-returning path to check.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        IUnderwaterPair(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = IUnderwaterPair(pair).burn(to);
        (address token0,) = UnderwaterLibrary.sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        if (amountA < amountAMin) revert InsufficientAAmount();
        if (amountB < amountBMin) revert InsufficientBAmount();
    }

    function removeLiquidityETH(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountToken, uint256 amountETH) {
        // Unwrap through the router, so the caller receives native ETH.
        (amountToken, amountETH) =
            removeLiquidity(token, WETH, liquidity, amountTokenMin, amountETHMin, address(this), deadline);
        SafeTransferLib.safeTransfer(token, to, amountToken);
        IWETH(WETH).withdraw(amountETH);
        SafeTransferLib.safeTransferETH(to, amountETH);
    }

    /// @notice `removeLiquidityETH` for tokens that take a cut on transfer.
    /// @dev Pays out whatever actually arrived instead of the pool's reported
    ///      amount, which a taxed transfer would undershoot.
    function removeLiquidityETHSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) public ensure(deadline) returns (uint256 amountETH) {
        (, amountETH) = removeLiquidity(
            token, WETH, liquidity, amountTokenMin, amountETHMin, address(this), deadline
        );
        SafeTransferLib.safeTransfer(token, to, IERC20Minimal(token).balanceOf(address(this)));
        IWETH(WETH).withdraw(amountETH);
        SafeTransferLib.safeTransferETH(to, amountETH);
    }

    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountA, uint256 amountB) {
        address pair = UnderwaterLibrary.pairFor(factory, tokenA, tokenB);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IUnderwaterPair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountA, amountB) = removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline);
    }

    function removeLiquidityETHWithPermit(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountToken, uint256 amountETH) {
        address pair = UnderwaterLibrary.pairFor(factory, token, WETH);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IUnderwaterPair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        (amountToken, amountETH) =
            removeLiquidityETH(token, liquidity, amountTokenMin, amountETHMin, to, deadline);
    }

    function removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
        address token,
        uint256 liquidity,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline,
        bool approveMax,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 amountETH) {
        address pair = UnderwaterLibrary.pairFor(factory, token, WETH);
        uint256 value = approveMax ? type(uint256).max : liquidity;
        IUnderwaterPair(pair).permit(msg.sender, address(this), value, deadline, v, r, s);
        amountETH = removeLiquidityETHSupportingFeeOnTransferTokens(
            token, liquidity, amountTokenMin, amountETHMin, to, deadline
        );
    }

    // ─── Swap ─────────────────────────────────────────────────────────────

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = UnderwaterLibrary.getAmountsOut(factory, amountIn, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        SafeTransferLib.safeTransferFrom(
            path[0], msg.sender, UnderwaterLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to);
    }

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        amounts = UnderwaterLibrary.getAmountsIn(factory, amountOut, path);
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount();
        SafeTransferLib.safeTransferFrom(
            path[0], msg.sender, UnderwaterLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to);
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) returns (uint256[] memory amounts) {
        if (path[0] != WETH) revert InvalidPath();
        amounts = UnderwaterLibrary.getAmountsOut(factory, msg.value, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();
        IWETH(WETH).deposit{value: amounts[0]}();
        SafeTransferLib.safeTransfer(WETH, UnderwaterLibrary.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        if (path[path.length - 1] != WETH) revert InvalidPath();
        amounts = UnderwaterLibrary.getAmountsIn(factory, amountOut, path);
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount();
        SafeTransferLib.safeTransferFrom(
            path[0], msg.sender, UnderwaterLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this));
        uint256 amountETH = amounts[amounts.length - 1];
        IWETH(WETH).withdraw(amountETH);
        SafeTransferLib.safeTransferETH(to, amountETH);
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        if (path[path.length - 1] != WETH) revert InvalidPath();
        amounts = UnderwaterLibrary.getAmountsOut(factory, amountIn, path);
        uint256 amountETH = amounts[amounts.length - 1];
        if (amountETH < amountOutMin) revert InsufficientOutputAmount();
        SafeTransferLib.safeTransferFrom(
            path[0], msg.sender, UnderwaterLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this));
        IWETH(WETH).withdraw(amountETH);
        SafeTransferLib.safeTransferETH(to, amountETH);
    }

    function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external
        payable
        ensure(deadline)
        returns (uint256[] memory amounts)
    {
        if (path[0] != WETH) revert InvalidPath();
        amounts = UnderwaterLibrary.getAmountsIn(factory, amountOut, path);
        if (amounts[0] > msg.value) revert ExcessiveInputAmount();
        IWETH(WETH).deposit{value: amounts[0]}();
        SafeTransferLib.safeTransfer(WETH, UnderwaterLibrary.pairFor(factory, path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
        if (msg.value > amounts[0]) SafeTransferLib.safeTransferETH(msg.sender, msg.value - amounts[0]);
    }

    // ─── Swap, fee-on-transfer tokens ─────────────────────────────────────

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        SafeTransferLib.safeTransferFrom(
            path[0], msg.sender, UnderwaterLibrary.pairFor(factory, path[0], path[1]), amountIn
        );
        uint256 balanceBefore = IERC20Minimal(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        if (IERC20Minimal(path[path.length - 1]).balanceOf(to) - balanceBefore < amountOutMin) {
            revert InsufficientOutputAmount();
        }
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable ensure(deadline) {
        if (path[0] != WETH) revert InvalidPath();
        IWETH(WETH).deposit{value: msg.value}();
        SafeTransferLib.safeTransfer(WETH, UnderwaterLibrary.pairFor(factory, path[0], path[1]), msg.value);
        uint256 balanceBefore = IERC20Minimal(path[path.length - 1]).balanceOf(to);
        _swapSupportingFeeOnTransferTokens(path, to);
        if (IERC20Minimal(path[path.length - 1]).balanceOf(to) - balanceBefore < amountOutMin) {
            revert InsufficientOutputAmount();
        }
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) {
        if (path[path.length - 1] != WETH) revert InvalidPath();
        SafeTransferLib.safeTransferFrom(
            path[0], msg.sender, UnderwaterLibrary.pairFor(factory, path[0], path[1]), amountIn
        );
        _swapSupportingFeeOnTransferTokens(path, address(this));
        uint256 amountOut = IWETH(WETH).balanceOf(address(this));
        if (amountOut < amountOutMin) revert InsufficientOutputAmount();
        IWETH(WETH).withdraw(amountOut);
        SafeTransferLib.safeTransferETH(to, amountOut);
    }

    // ─── Quotes ───────────────────────────────────────────────────────────

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) external pure returns (uint256) {
        return UnderwaterLibrary.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256)
    {
        return UnderwaterLibrary.getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        external
        pure
        returns (uint256)
    {
        return UnderwaterLibrary.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory)
    {
        return UnderwaterLibrary.getAmountsOut(factory, amountIn, path);
    }

    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external
        view
        returns (uint256[] memory)
    {
        return UnderwaterLibrary.getAmountsIn(factory, amountOut, path);
    }

    // ─── Internals ────────────────────────────────────────────────────────

    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) private returns (uint256 amountA, uint256 amountB) {
        IUnderwaterFactory factory_ = IUnderwaterFactory(factory);
        if (factory_.getPair(tokenA, tokenB) == address(0)) factory_.createPair(tokenA, tokenB);

        (uint256 reserveA, uint256 reserveB) = UnderwaterLibrary.getReserves(factory, tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            // First deposit sets the price.
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            // Deposit at the pool's current ratio, scaling down whichever side
            // is in surplus so no value is donated to existing LPs.
            uint256 amountBOptimal = UnderwaterLibrary.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                if (amountBOptimal < amountBMin) revert InsufficientBAmount();
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = UnderwaterLibrary.quote(amountBDesired, reserveB, reserveA);
                // Implied by amountBOptimal > amountBDesired, but asserted
                // explicitly rather than left to an `assert` panic.
                if (amountAOptimal > amountADesired) revert ExcessiveInputAmount();
                if (amountAOptimal < amountAMin) revert InsufficientAAmount();
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    /// @dev Walks the path, sending each hop's output straight into the next
    ///      pool so intermediate tokens never touch the router.
    function _swap(uint256[] memory amounts, address[] memory path, address to_) private {
        for (uint256 i; i < path.length - 1; ++i) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = UnderwaterLibrary.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address recipient =
                i < path.length - 2 ? UnderwaterLibrary.pairFor(factory, output, path[i + 2]) : to_;
            IUnderwaterPair(UnderwaterLibrary.pairFor(factory, input, output))
                .swap(amount0Out, amount1Out, recipient, new bytes(0));
        }
    }

    /// @dev Same walk, but each hop's input is measured from the pool's actual
    ///      balance rather than assumed, so a transfer tax cannot desync the
    ///      chain.
    function _swapSupportingFeeOnTransferTokens(address[] memory path, address to_) private {
        for (uint256 i; i < path.length - 1; ++i) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = UnderwaterLibrary.sortTokens(input, output);
            IUnderwaterPair pair = IUnderwaterPair(UnderwaterLibrary.pairFor(factory, input, output));

            uint256 amountOutput;
            {
                (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
                (uint256 reserveInput, uint256 reserveOutput) = input == token0
                    ? (uint256(reserve0), uint256(reserve1))
                    : (uint256(reserve1), uint256(reserve0));
                uint256 amountInput = IERC20Minimal(input).balanceOf(address(pair)) - reserveInput;
                amountOutput = UnderwaterLibrary.getAmountOut(amountInput, reserveInput, reserveOutput);
            }

            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOutput) : (amountOutput, uint256(0));
            address recipient =
                i < path.length - 2 ? UnderwaterLibrary.pairFor(factory, output, path[i + 2]) : to_;
            pair.swap(amount0Out, amount1Out, recipient, new bytes(0));
        }
    }
}

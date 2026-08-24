// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

import {IUnderwaterFactory, IUnderwaterPair} from "../interfaces/IUnderwaterDex.sol";

/// @notice Pricing and pair-lookup helpers shared by the router and off-chain
///         callers.
library UnderwaterLibrary {
    error IdenticalAddresses();
    error ZeroAddress();
    error PairNotFound();
    error InsufficientAmount();
    error InsufficientLiquidity();
    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InvalidPath();

    /// @notice Order two token addresses canonically.
    function sortTokens(address tokenA, address tokenB)
        internal
        pure
        returns (address token0, address token1)
    {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
    }

    /// @notice Resolve the pool for a token pair.
    /// @dev Reads the factory registry rather than recomputing the CREATE2
    ///      address from a hard-coded init code hash. That costs one cold
    ///      external read, which is noise on an L2, and in exchange it is
    ///      impossible for this library to point at an address where no pool
    ///      lives — the failure mode that a stale hard-coded hash produces.
    function pairFor(address factory, address tokenA, address tokenB) internal view returns (address pair) {
        pair = IUnderwaterFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairNotFound();
    }

    /// @notice Reserves of a pool, ordered to match the arguments.
    function getReserves(address factory, address tokenA, address tokenB)
        internal
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        (address token0,) = sortTokens(tokenA, tokenB);
        (uint112 reserve0, uint112 reserve1,) =
            IUnderwaterPair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0
            ? (uint256(reserve0), uint256(reserve1))
            : (uint256(reserve1), uint256(reserve0));
    }

    /// @notice Equivalent amount of the other token at the current ratio, no fee.
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        internal
        pure
        returns (uint256 amountB)
    {
        if (amountA == 0) revert InsufficientAmount();
        if (reserveA == 0 || reserveB == 0) revert InsufficientLiquidity();
        amountB = amountA * reserveB / reserveA;
    }

    /// @notice Output for a given input, after the 0.3% fee.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientInputAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /// @notice Input required for an exact output, after the 0.3% fee.
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256 amountIn)
    {
        if (amountOut == 0) revert InsufficientOutputAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        // The original leaned on SafeMath underflow here; checking explicitly
        // turns "ask for the whole pool" into a named error instead of a panic.
        if (amountOut >= reserveOut) revert InsufficientLiquidity();
        uint256 numerator = reserveIn * amountOut * 1000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        // Round the required input up, so the k invariant always holds.
        amountIn = numerator / denominator + 1;
    }

    /// @notice Chained `getAmountOut` along a path.
    function getAmountsOut(address factory, uint256 amountIn, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; ++i) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    /// @notice Chained `getAmountIn` along a path, walked backwards.
    function getAmountsIn(address factory, uint256 amountOut, address[] memory path)
        internal
        view
        returns (uint256[] memory amounts)
    {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; --i) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Subset of the Uniswap V2 router used at graduation.
/// @dev V2-style routers are the common denominator across OP Stack DEXes.
///      Only the functions actually called are declared, so any router that
///      implements this shape works without pulling in a dependency.
interface IUniswapV2Router02 {
    function factory() external view returns (address);
    function WETH() external view returns (address);

    /// @notice Deposit `amountTokenDesired` plus `msg.value` as new liquidity.
    /// @return amountToken Tokens actually consumed by the pool.
    /// @return amountETH ETH actually consumed by the pool.
    /// @return liquidity LP tokens minted to `to`.
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

/// @notice Subset of the Uniswap V2 factory used to resolve the pair address.
interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

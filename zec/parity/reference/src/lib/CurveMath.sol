// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title CurveMath
/// @notice Constant-product bonding curve priced against *virtual* reserves.
///
/// The curve behaves like a Uniswap-V2 pool that was seeded with liquidity
/// nobody owns. Holding `x * y == k` with a virtual ETH reserve means the very
/// first buyer pays a finite, predictable price instead of dividing by zero,
/// and the price curve is smooth all the way to graduation.
///
///   x = ethReserve   (virtual seed + real ETH paid in so far)
///   y = tokenReserve (virtual ceiling - tokens sold so far)
///
/// Every function rounds in the pool's favour. Rounding dust therefore
/// accumulates as a tiny increase in k, which can only ever make the curve
/// marginally more expensive — never drainable by a rounding attack.
library CurveMath {
    error InsufficientReserve();

    /// @notice Tokens received for `ethIn`, solving `k = x*y` for the new y.
    /// @dev dy = y - k/(x+dx) = y*dx / (x+dx). Rounds down: buyer gets less.
    function tokensOut(uint256 ethReserve, uint256 tokenReserve, uint256 ethIn)
        internal
        pure
        returns (uint256)
    {
        if (ethIn == 0) return 0;
        // Bounded by design: tokenReserve <= 1e27 and ethIn is bounded by the
        // ETH supply, so the product stays far below 2**256.
        return (tokenReserve * ethIn) / (ethReserve + ethIn);
    }

    /// @notice ETH received for `tokensIn` sold back into the curve.
    /// @dev dx = x - k/(y+dy) = x*dy / (y+dy). Rounds down: seller gets less.
    function ethOut(uint256 ethReserve, uint256 tokenReserve, uint256 tokensIn)
        internal
        pure
        returns (uint256)
    {
        if (tokensIn == 0) return 0;
        return (ethReserve * tokensIn) / (tokenReserve + tokensIn);
    }

    /// @notice ETH required to buy exactly `tokensDesired` tokens.
    /// @dev dx = x*dy / (y-dy). Rounds up: buyer pays more. Used to size the
    ///      final buy before graduation so it lands exactly on the threshold.
    function ethInForTokens(uint256 ethReserve, uint256 tokenReserve, uint256 tokensDesired)
        internal
        pure
        returns (uint256)
    {
        if (tokensDesired == 0) return 0;
        if (tokensDesired >= tokenReserve) revert InsufficientReserve();
        uint256 numerator = ethReserve * tokensDesired;
        uint256 denominator = tokenReserve - tokensDesired;
        uint256 quotient = numerator / denominator;
        // Round up so the pool never gives away a wei of value.
        return quotient * denominator == numerator ? quotient : quotient + 1;
    }

    /// @notice Spot price scaled by 1e18: ETH per whole token at the margin.
    /// @dev Marginal price, not an execution price — any real trade moves it.
    function spotPriceE18(uint256 ethReserve, uint256 tokenReserve) internal pure returns (uint256) {
        if (tokenReserve == 0) return 0;
        return (ethReserve * 1e18) / tokenReserve;
    }
}

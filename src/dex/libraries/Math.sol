// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

/// @notice Arithmetic helpers used by the pool.
library Math {
    function min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }

    /// @notice Integer square root, rounded down.
    /// @dev Babylonian method, unchanged from Uniswap V2. Used only for the
    ///      first liquidity mint and the protocol fee, so its gas cost is
    ///      irrelevant next to the value of being the audited version.
    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

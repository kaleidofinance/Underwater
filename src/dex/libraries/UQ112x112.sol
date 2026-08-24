// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.26;

/// @notice Binary fixed point numbers with 112 integer and 112 fractional bits.
/// @dev Range [0, 2**112 - 1], resolution 1 / 2**112. Only used for the price
///      accumulators that back TWAP oracles.
library UQ112x112 {
    uint224 private constant Q112 = 2 ** 112;

    /// @notice Widen a uint112 into a UQ112x112.
    /// @dev `unchecked` is safe rather than merely cheap: the largest possible
    ///      input is 2**112 - 1, so the product is strictly below 2**224 and
    ///      cannot wrap a uint224.
    function encode(uint112 y) internal pure returns (uint224 z) {
        unchecked {
            z = uint224(y) * Q112;
        }
    }

    /// @notice Divide a UQ112x112 by a uint112, returning a UQ112x112.
    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / uint224(y);
    }
}

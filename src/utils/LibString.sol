// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice String helpers for on-chain metadata.
library LibString {
    bytes16 private constant HEX = "0123456789abcdef";

    /// @notice Decimal representation of `value`.
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";

        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) {
            digits++;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            // `value % 10` is 0..9, so the sum is 48..57 - always one byte.
            // forge-lint: disable-next-line(unsafe-typecast)
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }

    /// @notice Decimal representation of `value`, left-padded with '0' to
    ///         `width` characters. Values wider than `width` are not truncated.
    function toStringPadded(uint256 value, uint256 width) internal pure returns (string memory) {
        string memory s = toString(value);
        bytes memory b = bytes(s);
        if (b.length >= width) return s;

        bytes memory out = new bytes(width);
        uint256 pad = width - b.length;
        for (uint256 i; i < pad; ++i) {
            out[i] = "0";
        }
        for (uint256 i; i < b.length; ++i) {
            out[pad + i] = b[i];
        }
        return string(out);
    }

    /// @notice Checksum-free lowercase `0x…` representation of `value`.
    function toHexString(address value) internal pure returns (string memory) {
        bytes memory buffer = new bytes(42);
        buffer[0] = "0";
        buffer[1] = "x";

        uint256 v = uint256(uint160(value));
        for (uint256 i = 41; i > 1; --i) {
            buffer[i] = HEX[v & 0xf];
            v >>= 4;
        }
        return string(buffer);
    }

    /// @notice A 1e18-scaled value as a fixed-point decimal with `places`
    ///         fractional digits, truncated. `1_850_000_000_000_000_000` with
    ///         two places gives "1.85".
    function toFixed(uint256 value, uint256 places) internal pure returns (string memory) {
        uint256 scale = 10 ** places;
        uint256 whole = value / 1e18;
        uint256 frac = (value % 1e18) * scale / 1e18;
        return string.concat(toString(whole), ".", toStringPadded(frac, places));
    }
}

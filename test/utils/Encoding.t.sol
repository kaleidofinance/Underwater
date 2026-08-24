// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base64} from "../../src/utils/Base64.sol";
import {LibString} from "../../src/utils/LibString.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The metadata primitives, tested against fixed vectors rather than
///         against themselves. Every on-chain token URI in this repo is built out
///         of these two files, so a wrong byte here is a broken collection
///         everywhere it renders.
contract EncodingTest is Test {
    using LibString for uint256;
    using LibString for address;

    // ─── Base64 ───────────────────────────────────────────────────────────

    /// @dev RFC 4648 section 10.
    function test_base64MatchesTheRfcVectors() public pure {
        assertEq(Base64.encode(""), "");
        assertEq(Base64.encode("f"), "Zg==");
        assertEq(Base64.encode("fo"), "Zm8=");
        assertEq(Base64.encode("foo"), "Zm9v");
        assertEq(Base64.encode("foob"), "Zm9vYg==");
        assertEq(Base64.encode("fooba"), "Zm9vYmE=");
        assertEq(Base64.encode("foobar"), "Zm9vYmFy");
    }

    /// @dev The encoder's last read runs up to two bytes past the input, and the
    ///      word after a `bytes` in memory is only reliably zero when the length
    ///      is a multiple of 32. These four lengths straddle that boundary, so a
    ///      missing scrub shows up as corrupted trailing characters.
    function test_base64IsCorrectAcrossTheWordBoundary() public pure {
        assertEq(
            Base64.encode("abcdefghijklmnopqrstuvwxyz012345"), // 32 bytes
            "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU="
        );
        assertEq(
            Base64.encode("abcdefghijklmnopqrstuvwxyz0123456"), // 33
            "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2"
        );
        assertEq(
            Base64.encode("abcdefghijklmnopqrstuvwxyz01234567"), // 34
            "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nw=="
        );
        assertEq(
            Base64.encode("abcdefghijklmnopqrstuvwxyz012345678"), // 35
            "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg="
        );
    }

    /// @dev The scrub is a write into somebody else's memory, so it has to be put
    ///      back. Checks the input and the allocation after it are untouched.
    function test_base64LeavesTheSurroundingMemoryIntact() public pure {
        bytes memory data = "abcdefghijklmnopqrstuvwxyz01234567"; // 34 bytes
        bytes memory neighbour = "do not touch me";

        assertEq(Base64.encode(data), "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nw==");
        assertEq(string(data), "abcdefghijklmnopqrstuvwxyz01234567", "input unchanged");
        assertEq(string(neighbour), "do not touch me", "cached word restored");
    }

    function test_base64EmitsOnlyAlphabetCharacters() public pure {
        bytes memory data = new bytes(48);
        for (uint256 i; i < 48; ++i) {
            data[i] = bytes1(uint8(i * 5 + 3));
        }

        bytes memory out = bytes(Base64.encode(data));
        assertEq(out.length, 64, "48 bytes -> 64 chars, no padding");

        for (uint256 i; i < out.length; ++i) {
            uint8 c = uint8(out[i]);
            bool ok = (c >= 0x41 && c <= 0x5A) // A-Z
                || (c >= 0x61 && c <= 0x7A) // a-z
                || (c >= 0x30 && c <= 0x39) // 0-9
                || c == 0x2B // +
                || c == 0x2F; // /
            assertTrue(ok, "character outside the base64 alphabet");
        }
    }

    function testFuzz_base64LengthIsAlwaysAWholeGroup(bytes memory data) public {
        vm.assume(data.length > 0 && data.length <= 512);
        assertEq(bytes(Base64.encode(data)).length, 4 * ((data.length + 2) / 3));
    }

    // ─── LibString ────────────────────────────────────────────────────────

    function test_toString() public pure {
        assertEq(uint256(0).toString(), "0");
        assertEq(uint256(7).toString(), "7");
        assertEq(uint256(2222).toString(), "2222");
        assertEq(
            type(uint256).max.toString(),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
    }

    function test_toStringPadded() public pure {
        assertEq(uint256(1).toStringPadded(4), "0001");
        assertEq(uint256(447).toStringPadded(4), "0447");
        assertEq(uint256(2222).toStringPadded(4), "2222");
        assertEq(uint256(0).toStringPadded(3), "000");
        // Wider than the field: never truncated, because a silently shortened
        // plate number would name a different plate.
        assertEq(uint256(12345).toStringPadded(4), "12345");
    }

    function test_toHexString() public pure {
        assertEq(address(0).toHexString(), "0x0000000000000000000000000000000000000000");
        assertEq(address(uint160(0x1234)).toHexString(), "0x0000000000000000000000000000000000001234");
        assertEq(address(type(uint160).max).toHexString(), "0xffffffffffffffffffffffffffffffffffffffff");
    }

    function test_toFixed() public pure {
        assertEq(uint256(1.85e18).toFixed(2), "1.85");
        assertEq(uint256(1e18).toFixed(3), "1.000");
        assertEq(uint256(0.999e18).toFixed(3), "0.999");
        assertEq(uint256(0.07e18).toFixed(2), "0.07");
        assertEq(uint256(0).toFixed(2), "0.00");
        // Truncates rather than rounds. A health factor printed as 1.000 when it
        // is really 0.9999 would read as solvent on a plate that can be drowned.
        assertEq(uint256(0.9999e18).toFixed(3), "0.999");
    }

    function testFuzz_toFixedAlwaysHasTheRequestedPrecision(uint96 value) public pure {
        bytes memory b = bytes(uint256(value).toFixed(18));

        uint256 dot;
        for (uint256 i; i < b.length; ++i) {
            if (b[i] == ".") dot = i;
        }
        assertGt(dot, 0, "a decimal point, and a whole part before it");
        assertEq(b.length - dot - 1, 18, "18 fractional digits, always");
    }
}

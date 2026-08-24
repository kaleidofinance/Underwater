// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterTrophy} from "../../src/nft/UnderwaterTrophy.sol";
import {ERC721} from "../../src/utils/ERC721.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The kill plate. Driven directly here rather than through the
///         collection, so the metadata can be inspected without staging a
///         liquidation first.
contract TrophyTest is Test {
    UnderwaterTrophy trophy;

    address plates = makeAddr("plates");
    address hunter = makeAddr("hunter");

    function setUp() public {
        trophy = new UnderwaterTrophy(plates);
    }

    function _record(uint16 plate, address to, uint256 hf) internal returns (uint256) {
        vm.prank(plates);
        return trophy.record(plate, to, hf);
    }

    // ─── Minting ──────────────────────────────────────────────────────────

    function test_onlyThePlatesContractCanRecordAKill() public {
        vm.expectRevert(UnderwaterTrophy.OnlyPlates.selector);
        vm.prank(hunter);
        trophy.record(447, hunter, 0.9e18);

        vm.expectRevert(UnderwaterTrophy.OnlyPlates.selector);
        trophy.record(447, hunter, 0.9e18);
    }

    function test_recordMintsSequentiallyAndStoresTheKill() public {
        vm.roll(1234);

        uint256 first = _record(447, hunter, 0.87e18);
        uint256 second = _record(1108, hunter, 1e18);

        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(trophy.totalSupply(), 2);
        assertEq(trophy.balanceOf(hunter), 2);
        assertEq(trophy.ownerOf(first), hunter);

        (uint16 plate, uint64 block_, uint128 hf, address who) = trophy.kills(first);
        assertEq(plate, 447);
        assertEq(block_, 1234);
        assertEq(hf, 0.87e18);
        assertEq(who, hunter);
    }

    function test_nameAndSymbol() public view {
        assertEq(trophy.name(), "Underwater Kill");
        assertEq(trophy.symbol(), "KILL");
        assertEq(trophy.plates(), plates, "the only minter, immutable");
    }

    function test_trophiesAreTradeable() public {
        uint256 id = _record(447, hunter, 0.9e18);
        address buyer = makeAddr("buyer");

        vm.prank(hunter);
        trophy.transferFrom(hunter, buyer, id);

        assertEq(trophy.ownerOf(id), buyer);
        (,,, address who) = trophy.kills(id);
        assertEq(who, hunter, "the record of who took it does not transfer");
    }

    // ─── Metadata ─────────────────────────────────────────────────────────

    function test_tokenURIRejectsAnUnmintedTrophy() public {
        vm.expectRevert(ERC721.NotMinted.selector);
        trophy.tokenURI(1);
    }

    function test_tokenURIIsAFullyOnChainDataURI() public {
        vm.roll(9_000_001);
        uint256 id = _record(447, hunter, 0.874e18);

        string memory uri = trophy.tokenURI(id);
        string memory prefix = "data:application/json;base64,";
        assertEq(_slice(uri, 0, bytes(prefix).length), prefix, "json data URI");

        string memory json = string(_decode(_after(uri, bytes(prefix).length)));

        // Facts a buyer reads off the listing, not just bytes that happen to parse.
        assertTrue(_contains(json, '"name":"Kill No. 0447"'), "padded plate number");
        assertTrue(_contains(json, "drowned in block 9000001"), "block recorded");
        assertTrue(_contains(json, '{"trait_type":"Plate","value":447}'), "plate attribute");
        assertTrue(_contains(json, '{"trait_type":"Hunter","value":"0x'), "hunter attribute");
        assertTrue(_contains(json, '"image":"data:image/svg+xml;base64,'), "art is inline");

        // And the image really is an SVG once decoded, not a broken blob. The
        // image is the last field, so it runs to the closing `"}`.
        uint256 imageStart = _indexOf(json, "data:image/svg+xml;base64,") + 26;
        string memory svg = string(_decode(_slice(json, imageStart, bytes(json).length - imageStart - 2)));

        assertTrue(_contains(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\""), "well-formed root");
        assertTrue(_contains(svg, "</svg>"), "closed");
        assertTrue(_contains(svg, ">No. 0447<"), "the number is engraved on the plate");
        assertTrue(_contains(svg, ">DROWNED<"), "and what happened to it");
        assertTrue(_contains(svg, ">0.874<"), "health factor at the moment of the kill");
        assertTrue(_contains(svg, ">9000001<"), "block");
    }

    function test_tokenURIHandlesEveryPlateNumberWidth() public {
        uint16[4] memory plates_ = [uint16(1), 22, 333, 2222];
        for (uint256 i; i < plates_.length; ++i) {
            uint256 id = _record(plates_[i], hunter, 1e18);
            string memory json = string(_decode(_after(trophy.tokenURI(id), 29)));
            assertTrue(_contains(json, '"name":"Kill No. '), "named");
        }

        string memory one = string(_decode(_after(trophy.tokenURI(1), 29)));
        assertTrue(_contains(one, '"name":"Kill No. 0001"'), "single digit padded to four");

        string memory full = string(_decode(_after(trophy.tokenURI(4), 29)));
        assertTrue(_contains(full, '"name":"Kill No. 2222"'), "four digits unpadded");
    }

    // ─── String helpers ───────────────────────────────────────────────────

    function _slice(string memory s, uint256 start, uint256 len) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = b[start + i];
        }
        return string(out);
    }

    function _after(string memory s, uint256 start) internal pure returns (string memory) {
        return _slice(s, start, bytes(s).length - start);
    }

    function _indexOf(string memory haystack, string memory needle) internal pure returns (uint256) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return type(uint256).max;

        for (uint256 i; i <= h.length - n.length; ++i) {
            bool hit = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return i;
        }
        return type(uint256).max;
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        return _indexOf(haystack, needle) != type(uint256).max;
    }

    /// @dev Standard-alphabet base64 decode, so the assertions above read the
    ///      metadata the way a marketplace does instead of trusting the encoder.
    function _decode(string memory data) internal pure returns (bytes memory) {
        bytes memory b = bytes(data);
        require(b.length % 4 == 0, "base64: ragged input");
        if (b.length == 0) return "";

        uint256 pad;
        if (b[b.length - 1] == "=") pad++;
        if (b[b.length - 2] == "=") pad++;

        bytes memory out = new bytes(b.length / 4 * 3 - pad);
        uint256 o;
        for (uint256 i; i < b.length; i += 4) {
            uint256 group =
                _sextet(b[i]) << 18 | _sextet(b[i + 1]) << 12 | _sextet(b[i + 2]) << 6 | _sextet(b[i + 3]);
            for (uint256 k; k < 3; ++k) {
                if (o < out.length) out[o++] = bytes1(uint8(group >> (16 - k * 8)));
            }
        }
        return out;
    }

    function _sextet(bytes1 c) internal pure returns (uint256) {
        uint8 v = uint8(c);
        if (v >= 0x41 && v <= 0x5A) return v - 0x41; // A-Z
        if (v >= 0x61 && v <= 0x7A) return v - 0x61 + 26; // a-z
        if (v >= 0x30 && v <= 0x39) return v - 0x30 + 52; // 0-9
        if (v == 0x2B) return 62; // +
        if (v == 0x2F) return 63; // /
        if (v == 0x3D) return 0; // = padding
        revert("base64: bad character");
    }
}

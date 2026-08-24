// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base64} from "../utils/Base64.sol";
import {ERC721} from "../utils/ERC721.sol";
import {LibString} from "../utils/LibString.sol";

/// @title UnderwaterTrophy
/// @notice The engraved kill plate minted to whoever calls `drown` on a plate
///         whose position has crossed liquidation.
///
/// Deliberately inert, like [MemeToken](../token/MemeToken.sol): no owner, no
/// mint function reachable from outside the plates contract, no pause, no
/// upgrade. The plates contract address is immutable and is the only minter,
/// which is checkable by reading two lines of this file.
///
/// The art is generated entirely on-chain. A trophy is a record of something
/// that happened, so it must not depend on a server staying up to keep meaning
/// what it meant at mint.
contract UnderwaterTrophy is ERC721 {
    using LibString for uint256;
    using LibString for address;

    error OnlyPlates();

    /// @notice What was killed, by whom, and when.
    struct Kill {
        /// @dev Plate number that drowned. 1..2222.
        uint16 plate;
        /// @dev Block the drowning was recorded in.
        uint64 block_;
        /// @dev Health factor at the moment of the kill, 1e18-scaled.
        uint128 healthFactor;
        /// @dev Caller that recorded it.
        address hunter;
    }

    /// @notice The plates collection. The only address that can mint a trophy.
    address public immutable plates;

    /// @notice Trophies minted so far. Also the id of the most recent one.
    uint256 public totalSupply;

    mapping(uint256 => Kill) public kills;

    constructor(address _plates) ERC721("Underwater Kill", "KILL") {
        plates = _plates;
    }

    /// @notice Record a kill and hand the trophy to `hunter`.
    /// @dev Only callable by the plates contract, which calls it from `drown`
    ///      after verifying the health factor on-chain.
    function record(uint16 plate, address hunter, uint256 healthFactor) external returns (uint256 id) {
        if (msg.sender != plates) revert OnlyPlates();

        // Cannot overflow: bounded by the 2222 plates that can ever drown.
        unchecked {
            id = ++totalSupply;
        }

        kills[id] = Kill({
            // The caller only reaches this on a health factor at or below 1e18,
            // which is 20 orders of magnitude short of overflowing uint128.
            // forge-lint: disable-next-line(unsafe-typecast)
            plate: plate,
            block_: uint64(block.number),
            healthFactor: uint128(healthFactor),
            hunter: hunter
        });

        _mint(hunter, id);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        Kill memory k = kills[id];
        if (k.plate == 0) revert NotMinted();

        string memory plate = uint256(k.plate).toStringPadded(4);
        string memory json = string.concat(
            '{"name":"Kill No. ',
            plate,
            '","description":"Plate No. ',
            plate,
            " drowned in block ",
            uint256(k.block_).toString(),
            ". Recorded by ",
            k.hunter.toHexString(),
            '.","attributes":[{"trait_type":"Plate","value":',
            uint256(k.plate).toString(),
            '},{"trait_type":"Block","value":',
            uint256(k.block_).toString(),
            '},{"trait_type":"Hunter","value":"',
            k.hunter.toHexString(),
            '"}],"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(k, plate))),
            '"}'
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev An engraved brass plate: oxblood on black, monospaced, no figure.
    ///      The plate it commemorates is gone, so there is nothing to draw.
    function _svg(Kill memory k, string memory plate) private pure returns (string memory) {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 620" role="img">'
            '<rect width="400" height="620" fill="#05080D"/>'
            '<rect x="26" y="26" width="348" height="568" fill="none" stroke="#7A2318" stroke-width="1.4" opacity=".55"/>'
            '<g font-family="monospace" fill="#C9A24B" text-anchor="middle">'
            '<text x="200" y="132" font-size="13" letter-spacing="6" opacity=".7">RECOVERED</text>'
            '<text x="200" y="248" font-size="58" letter-spacing="2">No. ',
            plate,
            "</text>" '<text x="200" y="300" font-size="13" letter-spacing="4" fill="#7A2318">DROWNED</text>'
            "</g>" '<path d="M60 340 H340" stroke="#7A2318" stroke-width="1" opacity=".45"/>'
            '<g font-family="monospace" fill="#E8E2D2" font-size="11" letter-spacing="1.4" opacity=".62">'
            '<text x="60" y="388">BLOCK</text><text x="340" y="388" text-anchor="end">',
            uint256(k.block_).toString(),
            "</text>" '<text x="60" y="418">HEALTH</text><text x="340" y="418" text-anchor="end">',
            uint256(k.healthFactor).toFixed(3),
            "</text>"
            '<text x="60" y="448">HUNTER</text><text x="340" y="448" text-anchor="end" font-size="9">',
            k.hunter.toHexString(),
            "</text></g>" '<text x="200" y="556" font-family="monospace" font-size="10" fill="#7A2318"'
            ' text-anchor="middle" letter-spacing="3" opacity=".8">UNDERWATER</text>' "</svg>"
        );
    }
}

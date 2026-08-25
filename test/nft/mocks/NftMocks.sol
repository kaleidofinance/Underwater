// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnderwaterRenderer} from "../../../src/nft/interfaces/IUnderwaterRenderer.sol";
import {LibString} from "../../../src/utils/LibString.sol";

/// @notice Aave pool stand-in with a settable health factor per position.
/// @dev Mirrors the real contract's behaviour for a position carrying no debt:
///      an address nobody has configured reports `type(uint256).max`.
contract MockAavePool {
    mapping(address => uint256) private _hf;
    mapping(address => bool) private _configured;

    function setHealthFactor(address user, uint256 value) external {
        _hf[user] = value;
        _configured[user] = true;
    }

    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        return (0, 0, 0, 0, 0, _configured[user] ? _hf[user] : type(uint256).max);
    }

    /// @dev Only here to satisfy the deploy script's sanity probe, which rejects a
    ///      pool with nothing listed. One entry is enough; the collection never
    ///      reads this, since `getUserAccountData` is its single call into Aave.
    ///      The address is the OP Stack WETH predeploy, which is what the real Ink
    ///      market lists first.
    function getReservesList() external pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = 0x4200000000000000000000000000000000000006;
    }
}

/// @notice Renderer stand-in that echoes its arguments, so tests can assert what
///         the collection passes down rather than trusting the SVG.
contract MockRenderer is IUnderwaterRenderer {
    using LibString for uint256;

    function render(uint256 id, uint256 traits, uint256 healthFactor, uint256 scars, bool revealed)
        external
        pure
        returns (string memory)
    {
        return string.concat(
            "id=",
            id.toString(),
            ";traits=",
            traits.toString(),
            ";hf=",
            healthFactor.toString(),
            ";scars=",
            scars.toString(),
            ";revealed=",
            revealed ? "1" : "0"
        );
    }
}

/// @notice Recipient that accepts safe transfers.
contract GoodReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }
}

/// @notice Recipient that returns the wrong selector.
contract BadReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xdeadbeef;
    }
}

/// @notice Recipient that tries to mint again from inside the mint callback.
/// @dev `_safeMint` hands control to the recipient before the mint loop finishes,
///      which is the one place a plate buyer gets to run code mid-mint.
contract ReentrantReceiver {
    IMintable immutable target;
    uint256 immutable price;
    bool armed = true;

    constructor(address _target, uint256 _price) {
        target = IMintable(_target);
        price = _price;
    }

    function attack() external payable {
        target.mint{value: price}(1);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false;
            target.mint{value: price}(1);
        }
        return 0x150b7a02;
    }
}

interface IMintable {
    function mint(uint256 qty) external payable;
}

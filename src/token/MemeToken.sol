// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "../utils/ERC20.sol";

/// @title MemeToken
/// @notice The token minted for every underwater.fun launch.
///
/// Deliberately inert. There is no owner, no mint function, no pause, no
/// blacklist, no transfer tax and no upgrade path. Total supply is fixed at
/// construction and the only way to reduce it is `burn`, which spends the
/// caller's own balance. A trader can verify all of that by reading this file,
/// which is the entire point: the launchpad's credibility rests on the token
/// contract having no levers to pull.
contract MemeToken is ERC20 {
    /// @notice Launchpad that deployed this token and seeded the curve.
    address public immutable launchpad;

    /// @notice Address that submitted the launch.
    address public immutable creator;

    /// @notice Off-chain metadata pointer (image, description, socials).
    /// @dev Immutable in spirit — set once at construction, never written again.
    string public metadataURI;

    constructor(
        string memory _name,
        string memory _symbol,
        string memory _metadataURI,
        address _creator,
        uint256 _totalSupply
    ) ERC20(_name, _symbol, 18) {
        launchpad = msg.sender;
        creator = _creator;
        metadataURI = _metadataURI;

        // Entire supply goes to the launchpad: the curve float plus the
        // allocation held back for the DEX pool at graduation.
        _mint(msg.sender, _totalSupply);
    }

    /// @notice Irreversibly destroy `amount` of the caller's own tokens.
    /// @dev Used by the launchpad to burn the LP-ratio remainder at
    ///      graduation, and available to anyone who wants to burn their bag.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

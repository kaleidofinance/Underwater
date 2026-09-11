// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "../src/utils/ERC20.sol";

/// @title MockEquity
/// @notice A plain, 18-decimal, openly-mintable ERC20 that stands in for a
///         tokenized equity on testnet, where the real Robinhood equities do
///         not exist (they live only on Robinhood mainnet 4663).
///
/// @dev Faithful to the real thing for the launchpad's purposes: the real
///      equities are plain transferable 18-decimal ERC20s with unrestricted
///      transfers. The only difference is the open `mint`, which is a testnet
///      faucet convenience. NEVER deploy this to mainnet — there the launchpad
///      is pointed at the real equity token addresses instead.
contract MockEquity is ERC20 {
    constructor(string memory name_, string memory symbol_, address mintTo, uint256 initialSupply)
        ERC20(name_, symbol_, 18)
    {
        if (initialSupply > 0) _mint(mintTo, initialSupply);
    }

    /// @notice Mint test units to any address. Testnet faucet only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

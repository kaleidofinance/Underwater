// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The Aave V3 pools the plates collection reads health factors from, by
///         chain id.
///
/// These are here rather than in an env var because `aavePool` is **immutable** on
/// the collection. A wrong address is not a bad deploy that can be redone — it is
/// 2222 plates permanently reading a risk source that is not Aave, with no setter
/// to correct it. An env var that has to be right by hand, on the one deploy that
/// cannot be undone, is the wrong shape for that. `AAVE_POOL` still overrides, for
/// forks and local runs.
///
/// Verified on 2026-08-25 by calling both chains directly, not read off a docs
/// page: each address answers `getUserAccountData` with `type(uint256).max` for an
/// address holding no debt, reports a non-zero `POOL_REVISION`, and returns a
/// non-empty `getReservesList()`. [InkAavePool.t.sol](../test/fork/InkAavePool.t.sol)
/// re-checks all of that against the live chains, so this file going stale is a
/// test failure rather than a discovery made after the mint.
library InkAave {
    /// @dev Ink mainnet (57073). This is an Aave **whitelabel** instance — the Aave
    ///      V3 codebase, deployed and operated under licence by a third party,
    ///      rather than the canonical Aave DAO market. There is no canonical Aave
    ///      V3 deployment on Ink; `AaveV3InkWhitelabel` is what the official
    ///      address book carries. What that costs is written down in the README's
    ///      trust model: the collection's art depends on a market whose operator
    ///      is not Aave governance and not us.
    address internal constant POOL_INK = 0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA;

    /// @dev Ink Sepolia (763373).
    address internal constant POOL_INK_SEPOLIA = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;

    /// @dev Reverts rather than returning zero for an unknown chain. Zero would be
    ///      caught by the deploy script's probe, but "no pool on this chain" and
    ///      "you forgot to set one" are different problems and deserve different
    ///      messages.
    function poolFor(uint256 chainId) internal pure returns (address) {
        if (chainId == 57073) return POOL_INK;
        if (chainId == 763373) return POOL_INK_SEPOLIA;
        revert("InkAave: no known Aave pool for this chain - set AAVE_POOL");
    }
}

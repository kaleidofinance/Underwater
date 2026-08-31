// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The wrapped-ETH contract the router wraps and unwraps through, by chain
///         id.
///
/// This used to be one constant — the OP Stack predeploy — because both Ink networks
/// are OP Stack chains and put WETH at the same address as every other one. Robinhood
/// Chain is Arbitrum Nitro, which has no such predeploy, so WETH there is an ordinary
/// deployment at an ordinary address and the constant became a table.
///
/// A table rather than an env var for the same reason as [InkAave](InkAave.sol): `WETH`
/// is **immutable** on the router. A wrong address is not a bad deploy that can be
/// redone — it is a router that wraps ETH into a token nobody holds, so every
/// graduation seeds a pool against the wrong asset and every buy through the router
/// quotes against it. Requiring that to be right by hand, per chain, in an env var, is
/// the wrong shape for a value with no setter. `WETH` still overrides, for local runs
/// against a freshly deployed WETH9 and for forks.
///
/// Verified on 2026-08-30 by calling both Robinhood networks directly rather than
/// reading a docs page:
///
/// - The testnet's is WETH9 in the plainest sense — `deposit()`, `withdraw(uint256)`
///   and the whole ERC-20 set are present as selectors in its own runtime code, and
///   `deposit()` with value simulates clean.
/// - The mainnet's is an **EIP-1967 proxy** (implementation
///   `0xc6B81B429797E0f555440b70Cd99E032D7Ae947E` at the time of writing), which is why
///   none of those selectors appear in the code at the address. It behaves as WETH9:
///   `symbol()` is "WETH", `deposit()` with value mints, a bare value transfer mints
///   too, and `withdraw` burns. It is also therefore *upgradeable* by whoever holds
///   that proxy's admin, which is a trust fact to weigh before Robinhood mainnet rather
///   than a reason not to use it — it is the WETH the chain's existing venue already
///   names through `WETH9()`, so using anything else would split ETH liquidity in two.
///
/// [Weth.t.sol](../test/fork/Weth.t.sol) re-checks every address here against the live
/// chains, so this table going stale is a test failure rather than a discovery made
/// after a router is deployed against it.
library Weth {
    /// @dev Both Ink networks (57073, 763373) and every other OP Stack chain.
    address internal constant OP_STACK_PREDEPLOY = 0x4200000000000000000000000000000000000006;

    /// @dev Robinhood Chain (4663). Proxied and upgradeable — see above.
    address internal constant ROBINHOOD = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    /// @dev Robinhood Chain Testnet (46630).
    address internal constant ROBINHOOD_TESTNET = 0x33e4191705c386532ba27cBF171Db86919200B94;

    /// @dev Reverts rather than returning zero for an unknown chain. Zero would be
    ///      caught by the deploy script's code probe, but "this chain is not in the
    ///      table" and "the address in the table is wrong" are different problems and
    ///      deserve different messages.
    function forChain(uint256 chainId) internal pure returns (address) {
        if (chainId == 57073 || chainId == 763373) return OP_STACK_PREDEPLOY;
        if (chainId == 4663) return ROBINHOOD;
        if (chainId == 46630) return ROBINHOOD_TESTNET;
        revert("Weth: no known WETH for this chain - set WETH");
    }
}

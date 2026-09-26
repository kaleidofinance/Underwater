// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Reentrancy guard backed by a transient storage slot (EIP-1153).
/// @dev Transient storage is cleared at the end of every transaction, so the
///      guard costs ~100 gas per call instead of a warm SSTORE pair. Requires
///      the Cancun EVM, which Ink supports as an OP Stack chain.
///
///      The slot is read/written through assembly because Solidity 0.8.26 has
///      no `transient` variable keyword (introduced in 0.8.28), but the check
///      itself stays in Solidity so the revert reason is compiler-generated.
abstract contract ReentrancyGuard {
    error Reentrancy();

    /// @dev keccak256("underwater.fun.reentrancy.guard"), written as a literal
    ///      because inline assembly only accepts direct number constants.
    ///      Reproduce with: cast keccak "underwater.fun.reentrancy.guard"
    ///      Transient storage has its own address space, so this cannot collide
    ///      with regular contract storage.
    uint256 private constant LOCK_SLOT = 0x6209c3180cc13c3c7201fe5fc20a1c0923b3fcee539f2b3490e7bfce9fb5cc66;

    modifier nonReentrant() {
        if (_lockValue() != 0) revert Reentrancy();
        _setLock(1);
        _;
        _setLock(0);
    }

    function _lockValue() private view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(LOCK_SLOT)
        }
    }

    function _setLock(uint256 value) private {
        assembly ("memory-safe") {
            tstore(LOCK_SLOT, value)
        }
    }
}

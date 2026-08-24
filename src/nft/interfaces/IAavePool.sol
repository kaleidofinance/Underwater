// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The subset of the Aave V3 pool the collection reads.
/// @dev Only `getUserAccountData`, and only its final return value. The
///      collection never moves funds, never calls a state-changing Aave
///      function, and holds no approval on any user's position — it is a
///      read-only observer of a risk engine it does not implement.
interface IAavePool {
    /// @return totalCollateralBase Collateral in the pool's base currency.
    /// @return totalDebtBase Debt in the pool's base currency.
    /// @return availableBorrowsBase Remaining borrowing power.
    /// @return currentLiquidationThreshold Weighted liquidation threshold, bps.
    /// @return ltv Weighted loan-to-value, bps.
    /// @return healthFactor 1e18-scaled. `type(uint256).max` when debt is zero.
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

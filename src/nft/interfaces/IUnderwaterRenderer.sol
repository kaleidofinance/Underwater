// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Renders a plate to a data-URI. Split out from the collection because
///         the SVG asset library — 44 drawn illustrations across 10 trait
///         categories — does not fit in one 24KB contract alongside the
///         mechanics, and because art is the only part of this system anyone
///         would ever legitimately need to fix.
interface IUnderwaterRenderer {
    /// @param id Plate number, 1-indexed.
    /// @param traits Packed trait indices: 10 categories, 4 bits each, category
    ///        0 in the low nibble. Meaningless when `revealed` is false.
    /// @param healthFactor 1e18-scaled. `type(uint256).max` means dry dock —
    ///        no position attached, so the ink is fully crisp.
    /// @param scars Count of survived near-death dips. Renders on the paper as
    ///        salt rings and creases, never on the figure.
    /// @param revealed False until the trait offset is drawn, during which every
    ///        plate renders as an unopened survey tube.
    /// @return A complete `data:application/json;base64,…` token URI.
    function render(uint256 id, uint256 traits, uint256 healthFactor, uint256 scars, bool revealed)
        external
        view
        returns (string memory);
}

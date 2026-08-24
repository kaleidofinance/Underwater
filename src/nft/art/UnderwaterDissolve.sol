// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterMath as M} from "./UnderwaterMath.sol";

/// @title UnderwaterDissolve
/// @notice How far the ink has come apart, as a function of the health factor.
///
/// The plate's whole argument lives in these numbers. At a healthy position the
/// filters are near-identity and the drawing is crisp; as the health factor falls
/// toward liquidation the turbulence coarsens, the displacement grows, the blur
/// widens and the colour drains, until at 1.0 the plate is gone.
///
/// @dev The prototype computed this in floating point. Everything here is 1e18
///      fixed point instead, and `art/render.py` runs the same integers, so the
///      two renderers emit the same attribute strings rather than
///      almost-the-same ones. The one deliberate difference from the prototype is
///      the displacement exponent — see `UnderwaterMath.pow74`.
library UnderwaterDissolve {
    uint256 internal constant WAD = 1e18;

    /// @dev Dissolution starts here and completes 1.6 lower, i.e. at HF 1.0.
    uint256 internal constant CEILING = 2.6e18;

    /// @dev `t = (CEILING - hf) / SPAN`, and 1e18/1.6e18 is exactly 5/8, so the
    ///      clamp arithmetic is exact rather than a truncating division.
    uint256 internal constant T_NUM = 5;
    uint256 internal constant T_DEN = 8;

    /// @notice Filter parameters, each already scaled by the number of decimal
    ///         places it is printed with, so the renderer formats without
    ///         rescaling.
    struct Params {
        /// @dev 4 dp. Turbulence base frequency for the sharp layer.
        uint256 freq;
        /// @dev 4 dp. The bleed layer runs at 0.55x the frequency.
        uint256 bleedFreq;
        /// @dev 1 dp. Displacement scale, sharp layer.
        uint256 disp;
        /// @dev 1 dp. Displacement scale, bleed layer.
        uint256 bleedDisp;
        /// @dev 2 dp. Gaussian blur, sharp layer.
        uint256 blur;
        /// @dev 2 dp. Gaussian blur, bleed layer.
        uint256 bleedBlur;
        /// @dev 2 dp. Saturation, draining as the position deteriorates.
        uint256 sat;
        /// @dev 2 dp. Opacity of the sharp layer.
        uint256 op;
        /// @dev 2 dp. Opacity of the bleed layer, rising as the ink spreads.
        uint256 bleedOp;
    }

    /// @notice Dissolution progress, 0 crisp and WAD gone.
    function progress(uint256 healthFactor) internal pure returns (uint256) {
        if (healthFactor >= CEILING) return 0;
        uint256 t = (CEILING - healthFactor) * T_NUM / T_DEN;
        return t > WAD ? WAD : t;
    }

    /// @notice The filter parameters for a health factor.
    /// @dev `type(uint256).max` — dry dock, no position attached — lands on t = 0
    ///      through `progress`'s first branch, so no special case is needed here.
    ///
    ///      Every value is rounded once, from an exact rational, at the precision
    ///      it will be printed at — the same discipline the coordinate draws use.
    ///      The two derived parameters come off the *unrounded* numerator of the
    ///      one they scale, because that is what the prototype did and rounding
    ///      first would put the bleed layer out of step with the sharp one.
    function paramsFor(uint256 healthFactor) internal pure returns (Params memory p) {
        uint256 t = progress(healthFactor);

        // disp = 4 + 78 * t^(7/4). Printed at 1 dp, so the numerator is x10.
        uint256 dispNum = 40 * WAD + 780 * M.pow74(t);
        p.disp = M.nearest(dispNum, WAD);

        // The bleed layer displaces 2.4x as far, plus a fixed 22.
        p.bleedDisp = M.nearest(dispNum * 24, 10 * WAD) + 220;

        // freq = 0.01 + 0.014 * t. Printed at 4 dp.
        uint256 freqNum = 100 * WAD + 140 * t;
        p.freq = M.nearest(freqNum, WAD);
        p.bleedFreq = M.nearest(freqNum * 55, 100 * WAD);

        // blur = 0.2 + 2.6 * t^2, two places.
        p.blur = M.nearest(20 * WAD + 260 * M.mulWad(t, t), WAD);

        // The remaining three are linear in t. `sat` and `op` drain rather than
        // grow, and their numerators stay positive because t is clamped to WAD.
        p.bleedBlur = M.nearest(200 * WAD + 900 * t, WAD);
        p.bleedOp = M.nearest(10 * WAD + 50 * t, WAD);
        p.sat = M.nearest(100 * WAD - 72 * t, WAD);
        p.op = M.nearest(100 * WAD - 24 * t, WAD);
    }
}

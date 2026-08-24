// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {UnderwaterDissolve as Dis} from "../../src/nft/art/UnderwaterDissolve.sol";
import {UnderwaterMath as M} from "../../src/nft/art/UnderwaterMath.sol";
import {RenderFixtures as F} from "./fixtures/RenderFixtures.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The renderer's arithmetic: the dissolve curve, the prototype's PRNG,
///         and the decimal formatting that turns a draw into an SVG attribute.
///
/// @dev Two kinds of test here, and they do different jobs.
///
///      The fixture tests are differential. `art/render.py` is the oracle — it is
///      the renderer the art was designed with, it has produced every plate in
///      `art/showcase/`, and the port is only correct insofar as it agrees with
///      it byte for byte. Those expectations are captured output, regenerated with
///      `python art/fixtures.py`, not hand-written; a hand-written expectation can
///      be wrong in the same way the implementation is wrong.
///
///      The fuzz tests are property-based, and they cover what fixtures cannot: a
///      table of 16 health factors says nothing about the 2^256 - 16 others.
contract DissolveTest is Test {
    uint256 constant WAD = 1e18;
    uint256 constant CEILING = 2.6e18;
    uint256 constant TWO32 = 0x100000000;

    // ─── sqrt ─────────────────────────────────────────────────────────────

    /// @dev The defining property, and the reason `pow74` can be trusted:
    ///      `sqrt` is *exactly* `floor(sqrt(x))`, which is what makes it equal to
    ///      Python's `math.isqrt` rather than merely close to it. Anything looser
    ///      and the two renderers drift apart at the last decimal place.
    function testFuzz_sqrt_isTheFloorRoot(uint256 x) public pure {
        uint256 r = M.sqrt(x);
        assertLe(r * r, x, "root too large");

        // The upper bound only exists while (r+1)^2 fits. For x near 2^256 the
        // root is near 2^128 and squaring the successor would overflow, so the
        // lower bound is all there is to check — and it is the half that catches
        // Newton overshooting.
        if (r < type(uint128).max) {
            assertGt((r + 1) * (r + 1), x, "root too small");
        }
    }

    function test_sqrt_knownValues() public pure {
        assertEq(M.sqrt(0), 0);
        assertEq(M.sqrt(1), 1);
        assertEq(M.sqrt(2), 1);
        assertEq(M.sqrt(3), 1);
        assertEq(M.sqrt(4), 2);
        assertEq(M.sqrt(WAD), 1e9);
        assertEq(M.sqrt(type(uint256).max), 340282366920938463463374607431768211455);
    }

    /// @dev The seed is a power of two chosen by bit length, so every crossing is
    ///      a candidate for an off-by-one shift.
    function testFuzz_sqrt_exactSquaresAreExact(uint128 r) public pure {
        assertEq(M.sqrt(uint256(r) * r), r);
    }

    // ─── nearest ──────────────────────────────────────────────────────────

    /// @dev Rounding is the one thing both renderers must do identically, since
    ///      it is the last operation before a number becomes a string.
    function testFuzz_nearest_isWithinHalfAndTiesUp(uint128 num, uint128 den) public pure {
        vm.assume(den != 0);
        uint256 q = M.nearest(num, den);

        // Within half a denominator of the true value, i.e. it really is nearest.
        assertLe(q * den, uint256(num) + uint256(den) / 2 + 1, "rounded up too far");
        assertGe(uint256(q + 1) * den, uint256(num) + 1, "rounded down too far");

        // And a tie goes up, not to even. 2*num == den means num/den is exactly
        // one half, which must round to 1 rather than 0.
        if (uint256(num) * 2 == den) assertEq(q, 1, "tie did not round up");
    }

    function test_nearest_knownValues() public pure {
        assertEq(M.nearest(0, 100), 0);
        assertEq(M.nearest(49, 100), 0);
        assertEq(M.nearest(50, 100), 1); // the tie
        assertEq(M.nearest(51, 100), 1);
        assertEq(M.nearest(150, 100), 2); // and again, one up
        assertEq(M.nearest(TWO32, TWO32), 1);
    }

    // ─── pow74 ────────────────────────────────────────────────────────────

    function test_pow74_endpoints() public pure {
        assertEq(M.pow74(0), 0);
        assertEq(M.pow74(WAD), WAD);
    }

    /// @dev In [0, WAD] an exponent above 1 sits under the identity, and the curve
    ///      is monotone. Both hold for 1.7 as well, so this is a property the
    ///      substitution had to preserve and not just an artefact of 7/4.
    function testFuzz_pow74_staysUnderTheIdentity(uint256 t) public pure {
        t = bound(t, 0, WAD);
        uint256 p = M.pow74(t);
        assertLe(p, t, "t^1.75 exceeded t");
        assertLe(p, WAD, "escaped the unit interval");
    }

    function testFuzz_pow74_isMonotone(uint256 a, uint256 b) public pure {
        a = bound(a, 0, WAD);
        b = bound(b, a, WAD);
        assertLe(M.pow74(a), M.pow74(b), "curve went backwards");
    }

    // ─── progress ─────────────────────────────────────────────────────────

    function test_progress_clampsAtBothEnds() public pure {
        assertEq(Dis.progress(type(uint256).max), 0, "dry dock is not crisp");
        assertEq(Dis.progress(CEILING), 0, "the ceiling is not t = 0");
        assertEq(Dis.progress(WAD), WAD, "liquidation is not t = WAD");
        assertEq(Dis.progress(0), WAD, "below liquidation is not clamped");
    }

    /// @dev A falling health factor may never make a plate crisper. This is the
    ///      collection's whole promise, so it is fuzzed rather than sampled.
    function testFuzz_progress_neverImprovesAsHealthFalls(uint256 hi, uint256 lo) public pure {
        lo = bound(lo, 0, hi);
        assertGe(Dis.progress(lo), Dis.progress(hi), "dissolution reversed");
    }

    // ─── The dissolve table, against the Python renderer ──────────────────

    function test_paramsMatchTheRenderer() public pure {
        F.Dissolve[] memory cases = F.dissolve();

        for (uint256 i = 0; i < cases.length; ++i) {
            F.Dissolve memory c = cases[i];
            Dis.Params memory p = Dis.paramsFor(c.healthFactor);

            assertEq(Dis.progress(c.healthFactor), c.t, _why("t", i));
            assertEq(M.decimal(p.freq, 4), c.freq, _why("freq", i));
            assertEq(M.decimal(p.bleedFreq, 4), c.bleedFreq, _why("bleedFreq", i));
            assertEq(M.decimal(p.disp, 1), c.disp, _why("disp", i));
            assertEq(M.decimal(p.bleedDisp, 1), c.bleedDisp, _why("bleedDisp", i));
            assertEq(M.decimal(p.blur, 2), c.blur, _why("blur", i));
            assertEq(M.decimal(p.bleedBlur, 2), c.bleedBlur, _why("bleedBlur", i));
            assertEq(M.decimal(p.sat, 2), c.sat, _why("sat", i));
            assertEq(M.decimal(p.op, 2), c.op, _why("op", i));
            assertEq(M.decimal(p.bleedOp, 2), c.bleedOp, _why("bleedOp", i));
        }
    }

    // ─── The PRNG, against the Python renderer ────────────────────────────

    /// @dev The art was tuned against this exact stream. A different stream is a
    ///      different collection, so every draw is pinned rather than sampled.
    function test_prngMatchesTheRenderer() public pure {
        (uint256 seed, uint256[] memory expected) = F.stream();
        assertEq(M.seedFor(F.STREAM_ID), seed, "seed derivation drifted");

        uint256 state = seed;
        for (uint256 i = 0; i < expected.length; ++i) {
            uint256 d;
            (state, d) = M.next(state);
            assertEq(d, expected[i], _why("draw", i));
            assertLt(d, TWO32, "draw escaped u32");
        }
    }

    function test_seedsMatchTheRenderer() public pure {
        (uint256[] memory ids, uint256[] memory expected) = F.seeds();
        for (uint256 i = 0; i < ids.length; ++i) {
            assertEq(M.seedFor(ids[i]), expected[i], _why("seed", i));
        }
    }

    /// @dev The turbulence was tuned against seeds in this window; a seed outside
    ///      it is a plate whose texture nobody has ever looked at.
    function testFuzz_seedFor_staysInTheTunedRange(uint256 id) public pure {
        uint256 s = M.seedFor(id);
        assertGe(s, 100);
        assertLt(s, 9100);
    }

    // ─── Draw formatting, against the Python renderer ─────────────────────

    function test_drawsMatchTheRenderer() public pure {
        F.Draw[] memory cases = F.shapes();

        for (uint256 i = 0; i < cases.length; ++i) {
            F.Draw memory c = cases[i];
            string memory got =
                c.subtracts ? M.drawSigned(c.d, c.mul, c.add, c.places) : M.draw(c.d, c.mul, c.add, c.places);
            assertEq(got, c.expected, _why("draw shape", i));
        }
    }

    function test_decimal_placesAndPadding() public pure {
        assertEq(M.decimal(0, 0), "0");
        assertEq(M.decimal(328, 0), "328");
        assertEq(M.decimal(25, 1), "2.5");
        assertEq(M.decimal(2705, 2), "27.05");
        assertEq(M.decimal(100, 2), "1.00"); // the zeros have to survive
        assertEq(M.decimal(5, 2), "0.05"); // and so does the leading one
        assertEq(M.decimal(132, 4), "0.0132");
        assertEq(M.decimal(2188, 1), "218.8");
    }

    /// @dev JS `toFixed` writes "-0.00" for a negative value that rounds to zero,
    ///      so the port does too. SVG reads it identically; the sign exists so the
    ///      two renderers produce the same bytes, not for the picture.
    function test_drawSigned_keepsTheSignOnNegativeZero() public pure {
        // d/2^32 * 1.70 - 0.85 with d just under half of 2^32: a hair below zero,
        // rounding to zero at two places.
        assertEq(M.drawSigned(TWO32 / 2 - 1, 170, 85, 2), "-0.00");
        assertEq(M.drawSigned(TWO32 / 2, 170, 85, 2), "0.00");
        assertEq(M.drawSigned(0, 170, 85, 2), "-0.85");
        assertEq(M.drawSigned(TWO32 - 1, 170, 85, 2), "0.85");
    }

    /// @dev A draw is `[add, add + mul)`, and the renderer's coordinates assume it:
    ///      a mote at cx 400 would sit on the plate's edge.
    function testFuzz_draw_staysInRange(uint32 d, uint16 mul, uint16 add) public pure {
        uint256 v = M.drawInt(d, mul, add);
        assertGe(v, add);
        assertLe(v, uint256(add) + mul);
    }

    function _why(string memory what, uint256 i) private pure returns (string memory) {
        return string.concat(what, " mismatched at fixture ", vm.toString(i));
    }
}

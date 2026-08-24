// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LibString} from "../../utils/LibString.sol";

/// @title UnderwaterMath
/// @notice The arithmetic the plate renderer needs and Solidity does not have:
///         fixed-point powers, the prototype's 32-bit PRNG, and decimal
///         formatting of a random draw.
///
/// @dev Every function here has a byte-exact twin in `art/render.py`. That is the
///      whole design constraint: the off-chain renderer is the oracle the port is
///      tested against, so anything that cannot be reproduced identically in both
///      places — a float, a transcendental, a language's rounding mode — is not
///      allowed in the output path. What is left is integers.
library UnderwaterMath {
    /// @dev 1e18 fixed point, matching the health factor's own scale so no
    ///      conversion is needed on the way in.
    uint256 internal constant WAD = 1e18;

    /// @dev The PRNG's modulus. Draws are u32, exactly as in JS.
    uint256 internal constant TWO32 = 0x100000000;

    // ─── Fixed point ──────────────────────────────────────────────────────

    function mulWad(uint256 a, uint256 b) internal pure returns (uint256) {
        // Both operands are bounded by a few WAD in every call site here, so the
        // product cannot approach 2^256 and the multiply needs no guard.
        return a * b / WAD;
    }

    /// @notice Floor of the square root of `x`.
    /// @dev Newton's method from a power-of-two seed. Returns *exactly*
    ///      `floor(sqrt(x))`, which is what makes it equal to Python's
    ///      `math.isqrt` — the property the differential tests rely on, and the
    ///      one [the fuzz test](../../../test/nft/Dissolve.t.sol) pins directly
    ///      via `r*r <= x < (r+1)*(r+1)`.
    function sqrt(uint256 x) internal pure returns (uint256 r) {
        if (x == 0) return 0;

        // Seed with 2^(ceil(bits(x)/2)) so Newton converges in a fixed number of
        // steps for any input, rather than iterating until stable.
        uint256 n = x;
        r = 1;
        if (n >= 0x100000000000000000000000000000000) {
            n >>= 128;
            r <<= 64;
        }
        if (n >= 0x10000000000000000) {
            n >>= 64;
            r <<= 32;
        }
        if (n >= 0x100000000) {
            n >>= 32;
            r <<= 16;
        }
        if (n >= 0x10000) {
            n >>= 16;
            r <<= 8;
        }
        if (n >= 0x100) {
            n >>= 8;
            r <<= 4;
        }
        if (n >= 0x10) {
            n >>= 4;
            r <<= 2;
        }
        if (n >= 0x4) {
            r <<= 1;
        }

        // Seven steps take any uint256 to within one of the true root.
        unchecked {
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;

            // Newton can land one above; never more, and never below. The test is
            // `r > x / r` rather than the more obvious `r * r > x` because the two
            // are exactly equivalent for integers — `r > floor(x/r)` iff
            // `r*r > x` — and this one cannot overflow. At `x = type(uint256).max`
            // the root is 2^128 - 1, Newton lands on 2^128, and squaring that
            // wraps to zero, which would silently return a root one too large.
            return r > x / r ? r - 1 : r;
        }
    }

    /// @notice Square root in 1e18 fixed point.
    function sqrtWad(uint256 x) internal pure returns (uint256) {
        return sqrt(x * WAD);
    }

    /// @notice `t` to the power 7/4, for `t` in [0, WAD].
    /// @dev The prototype's dissolve curve used an exponent of 1.7, which has no
    ///      exact integer form. 7/4 does — `sqrt(sqrt(t^7))` — and it costs six
    ///      multiplies and two square roots instead of a fixed-point `exp`/`ln`
    ///      pair that both this and the Python renderer would then have to
    ///      implement bit-identically.
    ///
    ///      The substitution is deliberate and it is not free, but it is small and
    ///      it is bounded: across the whole health-factor range it moves the
    ///      displacement scale by at most 0.83 out of a 78-wide range — 1.07%,
    ///      worst at t = 0.56, zero at both ends — on a turbulence filter whose
    ///      output is visual noise. Nothing on chain commits to the exponent;
    ///      `provenance` covers the trait table, not the rendered bytes.
    function pow74(uint256 t) internal pure returns (uint256) {
        if (t == 0) return 0;
        if (t >= WAD) return WAD;

        uint256 t2 = mulWad(t, t);
        uint256 t4 = mulWad(t2, t2);
        uint256 t7 = mulWad(mulWad(t4, t2), t);
        return sqrtWad(sqrtWad(t7));
    }

    // ─── PRNG ─────────────────────────────────────────────────────────────

    /// @notice One mulberry32 step: advances `state` and returns the u32 draw.
    /// @dev Ported from the prototype, which is why it is u32 arithmetic and not
    ///      `keccak256`. The art was tuned against this sequence; a different
    ///      stream is a different collection.
    ///
    ///      JS mixes int32 and uint32 views of the same bits. Masking to 32 bits
    ///      throughout is bit-identical, because the operations differ only in how
    ///      the result is interpreted and the value that escapes is the u32 one.
    function next(uint256 state) internal pure returns (uint256 nextState, uint256 value) {
        unchecked {
            nextState = (state + 0x6D2B79F5) & 0xFFFFFFFF;

            uint256 t = nextState;
            t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF;
            t = (((t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF) ^ t);
            value = (t ^ (t >> 14)) & 0xFFFFFFFF;
        }
    }

    /// @notice The plate's texture seed.
    /// @dev The prototype drew this at random and never committed it, so it has to
    ///      be derived — and derived identically here and in `art/render.py`, or
    ///      every turbulence pattern, barnacle and salt ring diverges. Knuth
    ///      multiplicative, held to the prototype's 100..9099 range because the
    ///      turbulence was tuned against those values.
    function seedFor(uint256 id) internal pure returns (uint256) {
        unchecked {
            return 100 + ((id * 2654435761) & 0xFFFFFFFF) % 9000;
        }
    }

    // ─── Formatting ───────────────────────────────────────────────────────

    /// @notice `num / den` as the nearest integer, ties away from zero.
    /// @dev The one rounding primitive everything else here is built on, and the
    ///      reason none of this needs floating point: the doubled numerator plus
    ///      the denominator, over the doubled denominator, *is* the nearest
    ///      integer. No representation error, so nothing to round twice.
    ///
    ///      Values are carried as exact rationals right up to this call, because
    ///      several of the renderer's coordinates are derived from a draw — the
    ///      salt ring's inner radius is 0.62 of its outer — and rounding before
    ///      deriving gives a different answer than deriving before rounding.
    ///
    ///      Deliberately not `unchecked`: it is the one helper here that callers
    ///      hand arbitrary products to, and the two extra opcodes buy a revert
    ///      instead of a wrapped coordinate.
    function nearest(uint256 num, uint256 den) internal pure returns (uint256) {
        return (2 * num + den) / (2 * den);
    }

    /// @notice `value / 10**places` as a decimal string, e.g. (2705, 2) -> "27.05".
    /// @dev Takes an already-scaled integer rather than a wad, because every
    ///      caller here knows its own precision and scaling once is exact where
    ///      scaling twice is not. Deliberately not `LibString.toFixed`, which
    ///      takes a wad and truncates.
    function decimal(uint256 value, uint256 places) internal pure returns (string memory) {
        uint256 unit = 10 ** places;
        string memory whole = LibString.toString(value / unit);
        if (places == 0) return whole;
        return string.concat(whole, ".", LibString.toStringPadded(value % unit, places));
    }

    /// @notice A random draw mapped onto `[add, add + mul)` and printed with
    ///         `places` decimals, where `mul` and `add` are pre-scaled by
    ///         `10**places`.
    /// @dev The integer form of the prototype's `r() * mul + add` followed by
    ///      `toFixed(places)`. Rounding is half-up, which is what JS `toFixed` does
    ///      for the non-negative values used here.
    function draw(uint256 d, uint256 mul, uint256 add, uint256 places) internal pure returns (string memory) {
        return decimal(drawInt(d, mul, add), places);
    }

    /// @notice `draw`, but returning the scaled integer instead of a string, for
    ///         the handful of coordinates the renderer has to do arithmetic on
    ///         before printing.
    function drawInt(uint256 d, uint256 mul, uint256 add) internal pure returns (uint256) {
        unchecked {
            return nearest(d * mul, TWO32) + add;
        }
    }

    /// @notice The exact numerator of `d / 2**32 * mul + add`, over `2**32`.
    /// @dev For the one coordinate the art *derives* rather than draws: a salt
    ///      ring's inner radius is 0.62 of its outer, and the prototype took that
    ///      fraction of the unrounded radius. Rounding first and scaling second
    ///      gives a visibly different ellipse, so the caller keeps the numerator
    ///      and rounds each of the two radii once, separately.
    function numerator(uint256 d, uint256 mul, uint256 add) internal pure returns (uint256) {
        unchecked {
            return d * mul + add * TWO32;
        }
    }

    /// @notice `d / 2**32 * mul - sub`, printed with `places` decimals, where
    ///         `mul` and `sub` are pre-scaled by `10**places`.
    /// @dev The relic encrustation is the only place the art offsets a draw into
    ///      negative territory, and it needs its own path because rounding a
    ///      negative tie goes *away* from zero — `round(x) - k` and `round(x - k)`
    ///      disagree across the boundary.
    ///
    ///      Emits "-0.00" rather than "0.00" for a value that is negative but
    ///      rounds to zero, because that is what JS `toFixed` does and the point
    ///      of this function is to agree with it byte for byte. SVG reads the two
    ///      identically, so the sign is carried for the diff, not for the picture.
    function drawSigned(uint256 d, uint256 mul, uint256 sub, uint256 places)
        internal
        pure
        returns (string memory)
    {
        unchecked {
            uint256 positive = d * mul;
            uint256 negative = sub * TWO32;
            bool isNegative = positive < negative;

            uint256 magnitude = isNegative ? negative - positive : positive - negative;
            string memory body = decimal(nearest(magnitude, TWO32), places);
            return isNegative ? string.concat("-", body) : body;
        }
    }
}

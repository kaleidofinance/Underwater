#!/usr/bin/env python3
"""Generates the Solidity test fixtures from art/render.py.

The Python renderer is the oracle for the on-chain port, so the port has to be
tested against its actual output rather than against a second reading of the same
spec. This writes that output into a Solidity library the tests import.

    python art/fixtures.py

Writes test/nft/fixtures/RenderFixtures.sol.

Committed rather than generated at test time, and read from a library rather than
through `ffi`: `foundry.toml` sets `ffi = false` and grants no `fs_permissions`, so
`forge test` needs neither a Python interpreter nor the ability to shell out. The
cost is that the fixtures can go stale — which is exactly why they are generated
from the renderer instead of typed in, and why regenerating is one command.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from render import (  # noqa: E402
    CEILING,
    COLLECTION,
    ROOT,
    TWO32,
    WAD,
    Assets,
    decimal,
    fmt,
    load_collection,
    mulberry32,
    numerator,
    params,
    progress,
    rel,
    render_token,
    seed_for,
    to_wad,
)

from keccak import keccak256  # noqa: E402

OUT = ROOT / "test" / "nft" / "fixtures" / "RenderFixtures.sol"

MAX = 2**256 - 1

# Health factors worth pinning: both ends, every clamp boundary, both exact ties
# the float prototype got wrong, and a few ordinary points in between.
DISSOLVE_CASES = [
    ("dry dock: no position attached", MAX),
    ("far above the ceiling", 3 * WAD),
    ("the ceiling exactly, so t = 0", CEILING),
    ("one wei below the ceiling", CEILING - 1),
    ("Surface band boundary", 25 * WAD // 10),
    ("an exact tie in bleedOp, 0.225", 22 * WAD // 10),
    ("an exact tie in sat, 0.685", 19 * WAD // 10),
    ("Twilight band boundary", 18 * WAD // 10),
    ("mid-Midnight", 145 * WAD // 100),
    ("Midnight band boundary", 14 * WAD // 10),
    ("deep in Crush", 112 * WAD // 100),
    ("about to liquidate", 105 * WAD // 100),
    ("one wei above liquidation", WAD + 1),
    ("liquidation exactly, so t = WAD", WAD),
    ("under water, t stays clamped", WAD // 2),
    ("zero, the degenerate clamp", 0),
]

# Each param, and the precision it is printed at. Order is the struct's order.
PARAMS = [
    ("freq", 4),
    ("bleedFreq", 4),
    ("disp", 1),
    ("bleedDisp", 1),
    ("blur", 2),
    ("bleedBlur", 2),
    ("sat", 2),
    ("op", 2),
    ("bleedOp", 2),
]

# Plate 6 is the showcase hero, so its stream is the one already visible in
# art/showcase/. 24 draws covers a full scar (6) plus the encrustation (4) plus
# most of a mote field, which is every draw shape the renderer uses.
STREAM_ID = 6
STREAM_LEN = 24

# ids chosen to exercise the multiply's wraparound, not just small numbers.
SEED_IDS = [0, 1, 6, 446, 1111, 2222, 65535, 2**32 - 1]

# The four coordinate shapes, one representative each, so `nearest` and `decimal`
# are pinned at every precision the art actually asks for. (mul, add, places),
# `add` negative only for the encrustation.
DRAW_SHAPES = [
    ("mote cx, 0 dp", 400, 0, 0),
    ("mote r, 1 dp", 34, 10, 1),
    ("shoal scale, 2 dp", 50, 50, 2),
    ("encrustation cx, 2 dp, signed", 170, -85, 2),
    ("encrustation cy, 2 dp, signed", 150, -55, 2),
    ("a 4 dp mapping", 140, 100, 4),
]

# ─── Whole plates ─────────────────────────────────────────────────────────
#
# The arithmetic fixtures above pin the numbers. These pin the bytes: one row per
# branch the on-chain renderer can take, chosen so that each varies one thing from
# a neighbour. A failure pattern across them localises the bug — all rows failing
# is the shell or the defs, only the blueprint rows failing is `_substrate`, only
# the scarred rows failing is `_scars`, and so on.
#
# Slots are the table's, not invented: `python art/fixtures.py` reads
# traits/traits.json, so a row cannot describe a plate that does not exist. The
# plate *number* is the slot plus one, which is what `render` is called with.
PLATE_CASES = [
    # The showcase hero, across the whole life of a position. These seven are the
    # plates in art/showcase/, so a failure here is visible in the repo.
    #
    # The sealed row is handed real traits, a real health factor and real scars on
    # purpose: an unrevealed plate that changed with any of them would be leaking the
    # reveal, so the fixture pins that all three are ignored rather than assuming it.
    ("hero, sealed before the reveal", 5, {"sealed": True, "hf": 1.45, "scars": 3}),
    ("hero, dry dock", 5, {"dry": True}),
    ("hero at the dissolve ceiling", 5, {"hf": 2.60}),
    ("hero in Twilight", 5, {"hf": 1.90}),
    ("hero in Midnight, one scar", 5, {"hf": 1.45, "scars": 1}),
    ("hero in Crush, three scars", 5, {"hf": 1.05, "scars": 3}),
    ("hero drowned", 5, {"drowned": True, "scars": 3}),
    # The same plate at the scar clamp, and one past it: both renderers draw eight
    # and burn eight scars' worth of the stream, so these two must come out equal.
    ("hero with every scar it can have", 5, {"hf": 1.20, "scars": 8}),
    ("hero with one scar more than it can have", 5, {"hf": 1.20, "scars": 9}),
    # One row per substrate, since each takes a different branch of `_substrate`:
    # nothing, a gradient, 22 rules and a margin, or a 42-line grid.
    ("washi, and a shoal", 4, {"hf": 2.20}),
    ("vellum, gradient wash", 1, {"hf": 2.20}),
    ("ledger, ruled and margined", 2, {"hf": 2.20}),
    ("blueprint, inverted ink", 0, {"hf": 2.20}),
    ("blueprint with gold leaf, the one pigment that does not invert", 89, {"hf": 2.20}),
    # The remaining fauna branches, and the two blanks that must consume no PRNG.
    ("a lone predator, the fauna with no randomness in it", 17, {"hf": 2.20}),
    ("motes with no relic, so the stream starts at the fauna", 10, {"hf": 2.20}),
    ("nothing held, worn, stamped, carded or swimming", 678, {"hf": 2.20}),
]

# The two states drawn without traits are also the two whose markup was
# transcribed into Solidity by hand rather than generated from art/traits/**, so
# on top of the digest above they are pinned as whole strings: a diff on a 3 KB
# token URI is readable, and these are the rows where a hand-transcription typo is
# most likely. Same slot as the hero's sealed/drowned rows, so the verbatim string
# and the hashed one are the very same bytes.
VERBATIM = [
    ("sealed", 5, {"sealed": True, "hf": 1.45, "scars": 3}),
    ("drowned", 5, {"drowned": True, "scars": 3}),
]


def lit(s: str) -> str:
    return f'"{s}"'


def dissolve_rows() -> list[str]:
    rows = []
    for i, (note, hf) in enumerate(DISSOLVE_CASES):
        p = params(hf)
        values = ", ".join(lit(decimal(p[k], places)) for k, places in PARAMS)
        hf_lit = "type(uint256).max" if hf == MAX else str(hf)
        rows.append(
            f"        // {note}\n"
            f"        f[{i}] = Dissolve({hf_lit}, {p['t']}, {values});"
        )
    return rows


def stream_rows() -> tuple[int, list[str]]:
    seed = seed_for(STREAM_ID)
    r = mulberry32(seed)
    return seed, [str(r()) for _ in range(STREAM_LEN)]


def draw_rows() -> list[str]:
    """One draw per shape, taken off a stream nobody else uses so the expected
    strings cannot accidentally coincide with a real plate's."""
    r = mulberry32(seed_for(STREAM_ID) + 7)
    rows = []
    for i, (note, mul, add, places) in enumerate(DRAW_SHAPES):
        d = r()
        den = TWO32 * 10**places
        expected = fmt(numerator(d, mul, add), den, places)
        signed = "true" if add < 0 else "false"
        rows.append(
            f"        // {note} -> {expected}\n"
            f"        f[{i}] = Draw({d}, {abs(add)}, {mul}, {places}, {signed}, {lit(expected)});"
        )
    return rows


# Dry dock is not a health factor, it is the absence of one, and the renderer reads
# `type(uint256).max` as exactly that. The sentinel matters: a merely enormous
# number like 1e27 is above every band boundary and would render as Surface, so
# "no position attached" cannot be spelled as a large health factor.
DRY_DOCK_HF = "type(uint256).max"


def pack(plate: dict) -> int:
    """The plate's ten trait indices in one word, four bits each, category 0 in the
    low nibble — the layout `web/scripts/traits.mjs` writes and `traitsOf` returns.
    """
    word = 0
    for category, index in enumerate(plate["indices"]):
        word |= index << (4 * category)
    return word


def call_args(slot: int, kw: dict, plates: list[dict]) -> tuple[int, int, str, int, str]:
    """The five arguments `render` is called with, for one case.

    The Python renderer takes booleans for the two states that are not a health
    factor; the contract takes only numbers, so this is where `dry` becomes the
    sentinel and `drowned` becomes a health factor at the liquidation boundary.
    Both mappings live here rather than in the rows because a wrong one is the one
    mistake that would let these fixtures pass while the chain is wrong.
    """
    if kw.get("dry"):
        health = DRY_DOCK_HF
    elif kw.get("drowned"):
        # `render` calls anything at or below 1.0 drowned, so the drowned rows are
        # called at exactly WAD — the boundary, where an off-by-one would show.
        health = str(WAD)
    else:
        health = str(to_wad(kw["hf"]))

    return slot + 1, pack(plates[slot]), health, kw.get("scars", 0), (
        "false" if kw.get("sealed") else "true"
    )


def _case(slot: int, kw: dict, a: Assets, plates: list[dict]) -> tuple[str, str, tuple]:
    """One case rendered: its image, its token URI, and the arguments the contract
    has to be handed to reproduce them."""
    image, uri = render_token(slot + 1, plates[slot]["traits"], a, **kw)
    return image, uri, call_args(slot, kw, plates)


def plate_rows(a: Assets, plates: list[dict]) -> list[str]:
    rows = []
    for i, (note, slot, kw) in enumerate(PLATE_CASES):
        image, uri, (plate_id, traits, health, scars, revealed) = _case(slot, kw, a, plates)
        digest = keccak256(uri.encode("utf8")).hex()
        rows.append(
            f"        // {note}\n"
            f"        //   slot {slot}, {len(image)} B of SVG in a {len(uri)} B URI\n"
            f"        f[{i}] = Plate({lit(note)}, {plate_id}, {traits:#x}, {health},"
            f" {scars}, {revealed}, 0x{digest});"
        )
    return rows


def verbatim_rows(a: Assets, plates: list[dict]) -> list[str]:
    rows = []
    for i, (note, slot, kw) in enumerate(VERBATIM):
        _, uri, (plate_id, traits, health, scars, revealed) = _case(slot, kw, a, plates)
        rows.append(
            f"        // {note}, plate {plate_id}\n"
            f"        f[{i}] = Verbatim({lit(note)}, {plate_id}, {traits:#x}, {health},"
            f" {scars}, {revealed},\n"
            f"            {lit(uri)});"
        )
    return rows


def source() -> str:
    rows = dissolve_rows()
    seed, draws = stream_rows()
    shapes = draw_rows()

    a = Assets()
    plates = load_collection()["plates"]
    for note, slot, _ in PLATE_CASES + VERBATIM:
        if not 0 <= slot < len(plates):
            raise SystemExit(f"case {note!r} names slot {slot}, which is not in the table")
    whole = plate_rows(a, plates)
    verbatim = verbatim_rows(a, plates)

    return f"""// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title RenderFixtures
/// @notice What `art/render.py` actually produces, for the port to be tested
///         against.
///
/// @dev GENERATED by `python art/fixtures.py`. Do not edit by hand — regenerate.
///
///      These are not a second reading of the spec; they are the off-chain
///      renderer's real output, captured. A hand-written expectation can be wrong
///      in the same way the implementation is wrong, which is the failure mode
///      this exists to rule out.
///
///      Committed rather than fetched at test time because `foundry.toml` sets
///      `ffi = false` and grants no filesystem permissions, so `forge test` needs
///      no interpreter and no shell.
///
///      Dynamic arrays throughout: a caller cannot size a fixed-length array from
///      a library constant, and `.length` at the call site is one less thing to
///      keep in step when a case is added here.
library RenderFixtures {{
    /// @notice One health factor and every filter parameter it produces, as the
    ///         strings the renderer will emit.
    struct Dissolve {{
        uint256 healthFactor;
        uint256 t;
        string freq;
        string bleedFreq;
        string disp;
        string bleedDisp;
        string blur;
        string bleedBlur;
        string sat;
        string op;
        string bleedOp;
    }}

    /// @notice One coordinate draw: the u32 the PRNG gave, the mapping applied to
    ///         it, and the string that has to come out.
    /// @dev `add` is a magnitude and `subtracts` says which way it goes, because
    ///      the struct is unsigned and the encrustation is the one place the art
    ///      offsets a draw below zero.
    struct Draw {{
        uint256 d;
        uint256 add;
        uint256 mul;
        uint256 places;
        bool subtracts;
        string expected;
    }}

    /// @notice One whole plate: the five arguments `render` is called with, and the
    ///         keccak256 of the token URI it has to return.
    ///
    /// @dev Pinned by digest rather than embedded. A composed plate is 3-22 KB of
    ///      SVG and `render` returns it base64'd inside the JSON, so a literal copy
    ///      would be an unreadable blob either way, 250 KB of it across these rows.
    ///      The digest is 32 bytes, native to `keccak256`, and a single byte of drift
    ///      anywhere in the markup, the metadata or the encoding changes it.
    ///
    ///      `healthFactor` is what the *contract* is handed, which is not always what
    ///      `art/render.py` is handed: dry dock is `type(uint256).max` here and 3.0
    ///      there, drowned is a number at the liquidation boundary here and a flag
    ///      there. `art/fixtures.py:call_args` is the one place that translates.
    struct Plate {{
        string note;
        uint256 id;
        uint256 traits;
        uint256 healthFactor;
        uint256 scars;
        bool revealed;
        bytes32 uri;
    }}

    /// @notice A plate whose whole token URI is pinned, not only its digest.
    /// @dev For the two states the renderer draws from hand-written markup instead of
    ///      from the generated asset contracts. A digest mismatch says only "these
    ///      bytes are wrong"; comparing the strings prints both, which is what you
    ///      want on the two rows most likely to be holding a transcription typo.
    ///      Both also appear in `plates()`, so this is a second look at the same
    ///      bytes rather than extra coverage.
    struct Verbatim {{
        string note;
        uint256 id;
        uint256 traits;
        uint256 healthFactor;
        uint256 scars;
        bool revealed;
        string uri;
    }}

    /// @dev The plate whose stream `stream()` captures — the showcase hero, so the
    ///      numbers below correspond to art visible in the repo.
    uint256 internal constant STREAM_ID = {STREAM_ID};

    function dissolve() internal pure returns (Dissolve[] memory f) {{
        f = new Dissolve[]({len(rows)});
{chr(10).join(rows)}
    }}

    /// @notice mulberry32 seeded for plate {STREAM_ID}, first {len(draws)} draws.
    function stream() internal pure returns (uint256 seed, uint256[] memory draws) {{
        seed = {seed};
        draws = new uint256[]({len(draws)});
{chr(10).join(f"        draws[{i}] = {d};" for i, d in enumerate(draws))}
    }}

    function shapes() internal pure returns (Draw[] memory f) {{
        f = new Draw[]({len(shapes)});
{chr(10).join(shapes)}
    }}

    /// @notice Plate ids and the texture seeds they derive to.
    function seeds() internal pure returns (uint256[] memory ids, uint256[] memory expected) {{
        ids = new uint256[]({len(SEED_IDS)});
        expected = new uint256[]({len(SEED_IDS)});
{chr(10).join(
    f"        ids[{i}] = {plate};" + chr(10) + f"        expected[{i}] = {seed_for(plate)};"
    for i, plate in enumerate(SEED_IDS)
)}
    }}

    /// @notice One row per branch `render` can take, each pinned by the keccak256 of
    ///         the token URI the Python renderer produced.
    function plates() internal pure returns (Plate[] memory f) {{
        f = new Plate[]({len(whole)});
{chr(10).join(whole)}
    }}

    /// @notice The two trait-free states, their whole token URI captured so a
    ///         mismatch prints the bytes.
    function verbatim() internal pure returns (Verbatim[] memory f) {{
        f = new Verbatim[]({len(verbatim)});
{chr(10).join(verbatim)}
    }}
}}
"""


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(source(), encoding="utf8")

    dim = "\x1b[2m{}\x1b[0m".format
    gold = "\x1b[33m{}\x1b[0m".format
    print(f"\n  {gold('Underwater')} test fixtures\n")
    print(f"  {len(DISSOLVE_CASES):3} dissolve cases   {dim('every clamp boundary and both float ties')}")
    print(f"  {STREAM_LEN:3} PRNG draws       {dim(f'plate {STREAM_ID}, seed {seed_for(STREAM_ID)}')}")
    print(f"  {len(DRAW_SHAPES):3} draw shapes      {dim('0, 1, 2 and 4 dp, signed and not')}")
    print(f"  {len(SEED_IDS):3} seed derivations {dim('including the u32 wraparound')}")
    print(f"  {len(PLATE_CASES):3} whole plates     {dim('one per render branch, pinned by keccak256')}")
    print(f"  {len(VERBATIM):3} verbatim URIs    {dim('the two hand-written trait-free states')}")
    print(dim(f"\n  wrote {rel(OUT)}\n"))


if __name__ == "__main__":
    main()

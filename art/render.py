#!/usr/bin/env python3
"""Composes Underwater plates from the extracted trait files.

The 2222 pieces are not a fixed set of images. A plate's art is a function of its
traits *and* the live state of the Aave position it is attached to, so this
renders (trait set, health factor, scars) -> SVG. Pass --all to walk the whole
collection at a given health factor, which is what you want for previews, sheets
and rarity pages.

Inputs, all files, nothing hardcoded:
    art/traits/**/*.svg      one file per drawn asset, from art/extract.mjs
    art/traits/manifest.json anchors, transforms, colours, dissolve constants
    traits/traits.json       the sealed trait table, from web/scripts/traits.mjs

Usage:
    python art/render.py --slot 446                     one plate, dry dock
    python art/render.py --slot 446 --hf 1.12 --scars 3 mid-dissolve
    python art/render.py --slot 446 --drowned           after liquidation
    python art/render.py --all --hf 2.4                 all 2222
    python art/render.py --all --png                    needs cairosvg
    python art/render.py --showcase                     the two contact sheets

This is the off-chain twin of the on-chain renderer, and its oracle: both read the
same trait indices and must produce the same bytes, not merely the same picture.
So there is no floating point anywhere in the output path — the PRNG returns u32
draws, coordinates are exact rationals over 2**32, and the dissolve curve is 1e18
fixed point. Every numeric function here has a twin in src/nft/art/.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from decimal import Decimal
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
TRAITS_DIR = Path(__file__).resolve().parent / "traits"
MANIFEST = TRAITS_DIR / "manifest.json"
COLLECTION = ROOT / "traits" / "traits.json"

ASSET_RE = re.compile(r"<!--asset-->(.*?)<!--/asset-->", re.DOTALL)


# ─── JS-compatible primitives ─────────────────────────────────────────────
#
# The prototype's output is the reference, so these have to match JS semantics
# rather than merely be reasonable. Divergence here shows as art that is subtly
# not the art that was committed.

U32 = 0xFFFFFFFF


def mulberry32(a: int) -> Callable[[], int]:
    """The prototype's PRNG, emulated in unsigned 32-bit.

    JS mixes int32 (`^`, `|`, `Math.imul`) and uint32 (`>>>`) views of the same
    bits. Working purely in u32 is bit-identical: the operations differ only in
    how the result is *interpreted*, and the value that escapes is the u32 one.

    Returns that u32 rather than the prototype's `u32 / 2**32` float. Nothing is
    lost — 2**32 is a power of two and a u32 is under 2**53, so the division was
    exact and reversible — but it keeps every draw an integer, which is what
    Solidity can mirror. See `numerator` for how a draw becomes a coordinate.
    """
    state = a & U32

    def rnd() -> int:
        nonlocal state
        state = (state + 0x6D2B79F5) & U32
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & U32
        t = (t + (((t ^ (t >> 7)) * (t | 61)) & U32)) & U32 ^ t
        return (t ^ (t >> 14)) & U32

    return rnd


def seed_for(plate_id: int) -> int:
    """Per-plate texture seed.

    The prototype drew this at random and never committed it, but the on-chain
    renderer only receives `id` and the packed traits — so it has to be derived,
    and derived the same way in both places or the two renderers disagree. Knuth
    multiplicative on the id, kept to the prototype's 100..9099 range because the
    turbulence seeds were tuned against it. Trivial to mirror in Solidity.
    """
    return 100 + ((plate_id * 2654435761) & U32) % 9000


# ─── Assets ───────────────────────────────────────────────────────────────


def minify(fragment: str) -> str:
    """Strip the prototype's pretty-printing.

    Safe because no asset contains a `<text>` node or `xml:space="preserve"` —
    asserted by `art/solidify.py` before it embeds any of this on chain — so
    whitespace between tags carries no meaning. Runs inside attributes collapse to
    one space rather than vanishing, since path data needs its separators.
    """
    fragment = re.sub(r"\s+", " ", fragment)
    fragment = re.sub(r">\s+<", "><", fragment)
    fragment = re.sub(r"\s+/>", "/>", fragment)
    return fragment.strip()


class Assets:
    def __init__(self, traits_dir: Path = TRAITS_DIR) -> None:
        if not MANIFEST.exists():
            die(f"{rel(MANIFEST)} missing — run `node art/extract.mjs` first")
        self.manifest = json.loads(MANIFEST.read_text(encoding="utf8"))
        self.dir = traits_dir
        self._cache: dict[tuple[str, str], str] = {}

        self.plate = self.manifest["plate"]
        self.ink = self.manifest["ink"]
        self.paper = self.manifest["paper"]
        self.anchors = self.manifest["diverAnchors"]
        self.transforms = self.manifest["transforms"]
        self.states = self.manifest["states"]
        self.dissolve = self.manifest["dissolve"]
        self.categories = {c["key"]: c for c in self.manifest["categories"]}

        check_dissolve(self.dissolve)
        check_palette(self)

    def fragment(self, category: str, key: str) -> str:
        """The markup between the <!--asset--> markers, minified.

        Delimiters rather than an XML parse, so the same two-line extraction works
        in any language. Minified here, in the one place both consumers read
        through: `art/solidify.py` embeds exactly these bytes in the Solidity
        libraries, so the Python and on-chain renderers cannot disagree about
        whitespace — and the chain stops paying for the prototype's indentation.
        """
        hit = self._cache.get((category, key))
        if hit is not None:
            return hit

        path = self.dir / category / f"{key}.svg"
        if not path.exists():
            die(f"missing asset {rel(path)}")
        match = ASSET_RE.search(path.read_text(encoding="utf8"))
        if not match:
            die(f"{rel(path)} has no <!--asset--> block")
        self._cache[(category, key)] = minify(match.group(1))
        return self._cache[(category, key)]

    def option_key(self, category: str, index: int) -> str:
        options = self.categories[category]["options"]
        if not 0 <= index < len(options):
            die(f"{category} index {index} out of range (0..{len(options) - 1})")
        return options[index]["key"]


# ─── Exact draw arithmetic ────────────────────────────────────────────────
#
# Mirrors src/nft/art/UnderwaterMath.sol. A draw's value is kept as an exact
# rational `num/den` until the moment it is printed, because several coordinates
# are *derived* from a draw — `rx * 0.62`, `y - 16` — and rounding before deriving
# gives a different answer than deriving before rounding. The prototype derived
# from unrounded floats, so exact rationals are what reproduce it.

TWO32 = 1 << 32


def numerator(d: int, mul: int, add: int) -> int:
    """Exact numerator of `d/2**32 * mul + add` over `2**32 * scale`, where `mul`
    and `add` are pre-scaled by that same `scale`."""
    return d * mul + add * TWO32


def decimal(value: int, places: int) -> str:
    """`value / 10**places` as a string. UnderwaterMath.decimal."""
    unit = 10**places
    return f"{value // unit}.{value % unit:0{places}d}" if places else str(value // unit)


def fmt(num: int, den: int, places: int = 0) -> str:
    """`num/den` printed with `places` decimals, rounded half away from zero.

    Half-up on non-negative values is what JS `toFixed` does, and the doubled
    numerator over the doubled denominator *is* the nearest integer — no float, so
    nothing to round twice.
    """
    negative = num < 0
    scaled = (2 * abs(num) * 10**places + den) // (2 * den)
    return ("-" if negative else "") + decimal(scaled, places)


def nearest(num: int, den: int) -> int:
    """`num/den` as the nearest integer. For coordinates that get arithmetic done
    on them before printing."""
    return (2 * num + den) // (2 * den)


# ─── Dissolution ──────────────────────────────────────────────────────────
#
# Integer arithmetic, mirroring src/nft/art/UnderwaterDissolve.sol line for line.
# It used to be floats. Floats cannot be reproduced in Solidity, which made this
# renderer useless as an oracle for the port — the whole reason it exists — so the
# float version is gone rather than kept alongside. Every value below is scaled by
# the decimal places it will be printed with.

WAD = 10**18
CEILING = 26 * WAD // 10  # HF 2.6: dissolution starts here
T_NUM, T_DEN = 5, 8  # 1/1.6 exactly, so the clamp needs no rounding


def to_wad(value: float) -> int:
    """A health factor as 1e18 fixed point, the scale Aave itself reports it in.

    Via `Decimal(str(...))` rather than `int(value * WAD)`: the CLI's `--hf 1.45`
    means 1.45, and the double nearest 1.45 is not. The float multiply happens to
    round back to the right integer for every value used here, but "happens to" is
    not a property to depend on when the whole point is exactness.
    """
    if value == float("inf"):
        return WAD * 10**9  # dry dock: above any ceiling, and nowhere near overflow
    return int(Decimal(str(value)) * WAD)


def progress(hf_wad: int) -> int:
    """Dissolution progress in wad: 0 crisp, WAD gone."""
    if hf_wad >= CEILING:
        return 0
    t = (CEILING - hf_wad) * T_NUM // T_DEN
    return min(t, WAD)


def isqrt_wad(x: int) -> int:
    """Square root in wad. `math.isqrt` is exact floor, which is what the Solidity
    twin is fuzz-pinned to produce."""
    from math import isqrt

    return isqrt(x * WAD)


def pow74(t: int) -> int:
    """t**(7/4) in wad, as sqrt(sqrt(t**7)).

    The prototype used an exponent of 1.7. 7/4 is the nearest exponent expressible
    as repeated square roots, which is what lets this be exact integer arithmetic
    on both sides instead of a fixed-point exp/ln pair that would have to agree to
    the last bit. Costs at most 0.83 of the 78-wide displacement range, 1.07%,
    worst at t = 0.56 and zero at both ends — see UnderwaterMath.pow74 for the
    full argument.
    """
    if t <= 0:
        return 0
    if t >= WAD:
        return WAD
    t2 = t * t // WAD
    t4 = t2 * t2 // WAD
    t7 = (t4 * t2 // WAD) * t // WAD
    return isqrt_wad(isqrt_wad(t7))


def params(hf_wad: int) -> dict:
    """Filter parameters, each pre-scaled by its own print precision.

    Every value is rounded once, from an exact rational, at the precision it will
    be printed at — the same discipline as the coordinate draws. The two derived
    parameters (`bleedFreq`, `bleedDisp`) come off the *unrounded* numerator of the
    one they scale, because that is what the prototype did.
    """
    t = progress(hf_wad)

    # disp = 4 + 78 * t**(7/4), printed at 1 dp, so the numerator is x10.
    disp_num = 40 * WAD + 780 * pow74(t)
    # freq = 0.01 + 0.014 * t, printed at 4 dp.
    freq_num = 100 * WAD + 140 * t

    return {
        "t": t,
        "disp": nearest(disp_num, WAD),
        "bleedDisp": nearest(disp_num * 24, 10 * WAD) + 220,
        "freq": nearest(freq_num, WAD),
        "bleedFreq": nearest(freq_num * 55, 100 * WAD),
        "blur": nearest(20 * WAD + 260 * (t * t // WAD), WAD),
        "bleedBlur": nearest(200 * WAD + 900 * t, WAD),
        "bleedOp": nearest(10 * WAD + 50 * t, WAD),
        "sat": nearest(100 * WAD - 72 * t, WAD),
        "op": nearest(100 * WAD - 24 * t, WAD),
    }


def state_for(hf_wad: int, states: list[dict]) -> dict:
    """Which depth band the position is in. Named in the plate's footer and in the
    token's attributes, so it is compared in wad like everything else."""
    if hf_wad <= WAD:
        return {"key": "drowned", "name": "Drowned"}
    for s in states:
        if hf_wad >= to_wad(s["min"]):
            return s
    return states[-1]


def check_dissolve(spec: dict) -> None:
    """Assert the integer constants above still describe the curve the manifest
    declares.

    The coefficients are inlined rather than read from the manifest because they
    have to be inlined in Solidity — a contract cannot load JSON — and one
    hardcoded copy that is checked beats two that are merely hoped to agree. This
    is the check: edit the manifest without editing both renderers and the next
    render fails instead of quietly producing different art.
    """
    want = {
        ("tFrom", "ceiling"): Decimal(CEILING) / WAD,
        ("tFrom", "span"): Decimal(T_DEN) / T_NUM,
        ("disp", "base"): Decimal(4),
        ("disp", "gain"): Decimal(78),
        ("disp", "pow"): Decimal("1.75"),
        ("blur", "base"): Decimal("0.2"),
        ("blur", "gain"): Decimal("2.6"),
        ("blur", "pow"): Decimal(2),
        ("freq", "base"): Decimal("0.01"),
        ("freq", "gain"): Decimal("0.014"),
        ("bleed", "dispMul"): Decimal("2.4"),
        ("bleed", "dispAdd"): Decimal(22),
        ("bleed", "blurBase"): Decimal(2),
        ("bleed", "blurGain"): Decimal(9),
        ("bleed", "opBase"): Decimal("0.1"),
        ("bleed", "opGain"): Decimal("0.5"),
        ("sat", "base"): Decimal(1),
        ("sat", "gain"): Decimal("0.72"),
        ("op", "base"): Decimal(1),
        ("op", "gain"): Decimal("0.24"),
    }
    for (group, field), expected in want.items():
        got = Decimal(str(spec[group][field]))
        if got != expected:
            die(
                f"manifest dissolve.{group}.{field} is {got}, but render.py and "
                f"UnderwaterDissolve.sol are built for {expected}"
            )


# ─── Procedural layers (ported from the prototype) ────────────────────────

# A near-death dip leaves a salt ring and a crease, and the collection caps them
# at 8. Both renderers clamp rather than reject: a `tokenURI` that reverts on a
# plate which somehow earned nine is worse than one that draws eight. Mirrors
# UnderwaterRenderer.MAX_SCARS.
MAX_SCARS = 8


def fauna_layer(kind: str, r: Callable[[], int]) -> str:
    if kind == "none":
        return ""
    if kind == "motes":
        return "".join(
            f'<circle cx="{fmt(numerator(r(), 400, 0), TWO32)}" '
            f'cy="{fmt(numerator(r(), 620, 0), TWO32)}" '
            f'r="{fmt(numerator(r(), 34, 10), TWO32 * 10, 1)}" class="fill" '
            f'opacity="{fmt(numerator(r(), 40, 16), TWO32 * 100, 2)}"/>'
            for _ in range(26)
        )
    if kind == "predator":
        return (
            '<g opacity=".5"><path d="M300 470 q34 -19 68 0 q-30 12 -68 0 z" class="fill"/>'
            '<path d="M368 470 l20 -13 v26 z" class="fill"/>'
            '<circle cx="318" cy="468" r="2.6" class="paperfill"/></g>'
        )

    out = []
    for _ in range(9):
        # Draw order is the prototype's: x, y, scale, then opacity. Reordering
        # these would reshuffle the whole stream and change every later layer.
        x = numerator(r(), 300, 40)
        y = numerator(r(), 180, 400)
        k = numerator(r(), 50, 50)
        op = numerator(r(), 34, 24)
        out.append(
            f'<g opacity="{fmt(op, TWO32 * 100, 2)}" '
            f'transform="translate({fmt(x, TWO32)} {fmt(y, TWO32)}) '
            f'scale({fmt(k, TWO32 * 100, 2)})">'
            '<path d="M0 0 q15 -8 30 0 q-13 6 -30 0 z" class="fill"/>'
            '<path d="M30 0 l9 -6 v12 z" class="fill"/></g>'
        )
    return "".join(out)


def scar_layer(n: int, r: Callable[[], int]) -> str:
    """Salt rings and creases on the paper. Deliberately never on the figure —
    a scar records that the holder survived, not that the diver was injured.

    Clamped to `MAX_SCARS` here the same way the port clamps it, so a count past
    the cap draws the cap and consumes exactly the cap's worth of the stream —
    the two renderers have to agree on how much PRNG a scarred plate burns."""
    out = []
    for _ in range(min(n, MAX_SCARS)):
        cx = numerator(r(), 340, 30)
        cy = numerator(r(), 540, 40)
        rx = numerator(r(), 66, 42)
        ry = numerator(r(), 44, 30)
        # The inner ring is 0.62 of the outer, taken from the exact radius rather
        # than the printed one.
        out.append(
            f'<ellipse cx="{fmt(cx, TWO32)}" cy="{fmt(cy, TWO32)}" '
            f'rx="{fmt(rx, TWO32)}" ry="{fmt(ry, TWO32)}"'
            ' fill="none" stroke="#7A5A2A" stroke-width="2.4" opacity=".2"/>'
            f'<ellipse cx="{fmt(cx, TWO32)}" cy="{fmt(cy, TWO32)}" '
            f'rx="{fmt(rx * 62, TWO32 * 100)}"'
            f' ry="{fmt(ry * 62, TWO32 * 100)}" fill="#8A6A34" opacity=".07"/>'
        )
        # The crease's two derived heights shift by whole pixels, so they can come
        # off the rounded value: shifting by an integer commutes with rounding.
        y = nearest(numerator(r(), 520, 50), TWO32)
        qx = fmt(numerator(r(), 160, 60), TWO32)
        out.append(
            f'<path d="M0 {y} Q{qx} {y - 16} 200 {y}'
            f' T400 {y - 8}" fill="none" stroke="#6B5433" stroke-width="1.1" opacity=".24"/>'
        )
    return "".join(out)


def substrate_layer(sub: str, uid: str, a: Assets) -> str:
    extra = ""
    if sub == "ledger":
        extra += "".join(
            f'<path d="M0 {y} H400" stroke="#9C8A63" stroke-width=".9" opacity=".34"/>'
            for y in range(52, 620, 26)
        )
        extra += '<path d="M54 0 V620" stroke="#A5543F" stroke-width="1.2" opacity=".42"/>'
    if sub == "blueprint":
        extra += "".join(
            f'<path d="M{x} 0 V620" stroke="#5B8FB0" stroke-width=".7" opacity=".26"/>'
            for x in range(0, 401, 25)
        )
        extra += "".join(
            f'<path d="M0 {y} H400" stroke="#5B8FB0" stroke-width=".7" opacity=".26"/>'
            for y in range(0, 621, 25)
        )
    if sub == "vellum":
        extra += f'<rect width="400" height="620" fill="url(#vg{uid})"/>'
    return f'<rect width="400" height="620" fill="{a.paper[sub]}"/>{extra}'


def ink_for(traits: dict, a: Assets) -> str:
    """Blueprint paper is dark, so the ink inverts — except gold leaf, which is
    the one pigment that reads on both."""
    if traits["substrate"] == "blueprint" and traits["pigment"] != "goldleaf":
        return a.manifest["blueprintInk"]
    return a.ink[traits["pigment"]]


# ─── Compose ──────────────────────────────────────────────────────────────
#
# The palette the trait-free states are drawn in. Hardcoded because the plates that
# use them have no traits to look a pigment up from — a drowned plate has no
# substrate, and a sealed one has no anything — and because the on-chain renderer
# has to hardcode them too. `check_palette` keeps these honest against the
# manifest, so the two copies cannot drift the way the dissolve coefficients did.

OXBLOOD = "#7A2318"  # ink.oxblood — what a liquidated plate is stamped in
SEPIA = "#5C3A1E"  # ink.sepia — the survey tube's own ink
WASHI = "#E8E2D2"  # paper.washi
ABYSS = "#060A10"  # the drowned plate's paper; not a substrate, so manifest-free

# What UnderwaterRenderer.sol has compiled into it, transcribed. This whole block
# is a guard, not a source: nothing in this file reads it to render with. It exists
# because a Solidity contract cannot load JSON, so those literals had to be typed
# out once — and one typed copy that is checked against the manifest on every
# render is worth more than two copies nobody compares.
#
# The orderings matter as much as the colours. `_ink`, `_paper`, `_fauna` and
# `_substrate` dispatch on a raw nibble, so inserting an option into the middle of
# a category silently repaints the collection rather than failing.
RENDERER_INK = ["#12100E", SEPIA, "#1E2F5C", OXBLOOD, "#B08A34"]
RENDERER_PAPER = [WASHI, "#EFE7D0", "#E6DFCB", "#153044"]
RENDERER_BLUEPRINT_INK = "#DCE9EF"

# The four categories the renderer branches on itself, rather than passing through
# to the generated contracts.
RENDERER_ORDER = {
    "pigment": ["sumi", "sepia", "indigo", "oxblood", "goldleaf"],
    "substrate": ["washi", "vellum", "ledger", "blueprint"],
    "fauna": ["shoal", "predator", "motes", "none"],
    "diver": ["human", "skeleton", "cephalopod", "jellyfish", "angler", "drone"],
}

# The depth bands, in the order `_band` tests them and with the names it prints.
RENDERER_STATES = [("surface", "Surface", 2.5), ("twilight", "Twilight", 1.8),
                   ("midnight", "Midnight", 1.4), ("crush", "Crush Depth", 1.0)]


def check_palette(a: Assets) -> None:
    """Assert the manifest still says what UnderwaterRenderer.sol was built for.

    Same job as `check_dissolve`, applied to the other half of what the on-chain
    renderer had to inline: colour, category order, and the depth bands. Fails the
    render rather than producing art the chain will not reproduce.
    """

    def want(name: str, got: object, expected: object) -> None:
        if got != expected:
            die(
                f"manifest {name} is {got!r}, but render.py and UnderwaterRenderer.sol "
                f"are built for {expected!r}"
            )

    for i, key in enumerate(RENDERER_ORDER["pigment"]):
        want(f"ink.{key}", a.ink.get(key), RENDERER_INK[i])
    for i, key in enumerate(RENDERER_ORDER["substrate"]):
        want(f"paper.{key}", a.paper.get(key), RENDERER_PAPER[i])
    want("blueprintInk", a.manifest["blueprintInk"], RENDERER_BLUEPRINT_INK)

    # The trait-free states pick their colours out of the same manifest by a
    # different route, so they are checked by identity rather than by index.
    want("ink.oxblood", a.ink["oxblood"], OXBLOOD)
    want("ink.sepia", a.ink["sepia"], SEPIA)
    want("paper.washi", a.paper["washi"], WASHI)

    for category, expected in RENDERER_ORDER.items():
        got = [o["key"] for o in a.categories[category]["options"]]
        want(f"{category} option order", got, expected)

    want(
        "states",
        [(s["key"], s["name"], float(s["min"])) for s in a.states],
        RENDERER_STATES,
    )


def render_plate(
    plate_id: int,
    traits: dict,
    a: Assets,
    hf: float = float("inf"),
    scars: int = 0,
    dry: bool = False,
    drowned: bool = False,
    sealed: bool = False,
) -> str:
    """One plate, at one moment in the life of the position behind it."""
    # Before the reveal there is nothing to look up, so this branch comes first and
    # ignores everything else it was handed — including the traits, which the
    # collection passes as zero until the offset is drawn.
    if sealed:
        return _sealed_plate(plate_id)

    uid = f"p{plate_id}"
    seed = seed_for(plate_id)
    ink = ink_for(traits, a)
    paper = a.paper[traits["substrate"]]

    emblem_frame = a.fragment("_frame", "emblem")
    emblem = (
        ""
        if not a.fragment("emblem", traits["emblem"]).strip()
        else emblem_frame.replace("{{CONTENT}}", a.fragment("emblem", traits["emblem"]))
    )

    if drowned or hf <= 1.0:
        return _drowned_plate(plate_id, uid, emblem)

    # Dry dock is drawn at a healthy-but-real health factor rather than at
    # infinity, so the plate looks like a plate and not like a special case.
    effective = to_wad(3.0 if dry else hf)
    p = params(effective)
    st = state_for(effective, a.states)

    anchor = a.anchors[traits["diver"]]
    head, hand = anchor["head"], anchor["hand"]
    r = mulberry32(seed)

    body = a.fragment("diver", traits["diver"])

    headgear_frag = a.fragment("headgear", traits["headgear"])
    headgear = (
        f'<g transform="translate({head["x"]} {head["y"]}) scale({head["r"]})">{headgear_frag}</g>'
        if headgear_frag.strip()
        else ""
    )

    held_frag = a.fragment("held", traits["held"])
    held = (
        f'<g transform="translate({hand["x"]} {hand["y"]}) rotate({hand["rot"]}) '
        f'scale({a.transforms["held"]["scale"]})">{held_frag}</g>'
        if held_frag.strip()
        else ""
    )

    relic = _relic(traits["relic"], a, r)
    scene = a.fragment("scene", traits["scene"])

    tether_frag = a.fragment("tether", traits["tether"])
    tether = f'<g transform="translate({head["x"] + 32} {head["y"] - 24})">{tether_frag}</g>'

    # RNG order matters: relic encrustation, then fauna, off the same stream, the
    # way the prototype consumes it.
    fauna = fauna_layer(traits["fauna"], r)

    inner = f"{scene}{relic}{tether}{body}{headgear}{held}{fauna}"

    # Written minified, one logical line per source line, rather than pretty and
    # collapsed afterwards. The on-chain renderer holds this same template as
    # string literals and its output has to match byte for byte, so the whitespace
    # is not cosmetic — every space is a byte both sides have to agree on, and the
    # cheapest way to agree is to have none that does not do work.
    return (
        f'<svg viewBox="0 0 400 620" id="{uid}" xmlns="http://www.w3.org/2000/svg" role="img"'
        f' aria-label="Plate {plate_id}, {"dry dock" if dry else st["name"].lower()}">'
        f'<defs>'
        f'<linearGradient id="vg{uid}" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="#F4EDD8"/><stop offset="1" stop-color="#E2D8BE"/>'
        f'</linearGradient>'
        f'<filter id="grain{uid}" x="0" y="0" width="100%" height="100%">'
        f'<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" result="n"/>'
        f'<feColorMatrix in="n" type="saturate" values="0"/></filter>'
        f'<filter id="dis{uid}" x="-35%" y="-30%" width="170%" height="165%"'
        f' color-interpolation-filters="sRGB">'
        f'<feTurbulence type="fractalNoise" baseFrequency="{decimal(p["freq"], 4)}"'
        f' numOctaves="4" seed="{seed}" result="n"/>'
        f'<feDisplacementMap in="SourceGraphic" in2="n" scale="{decimal(p["disp"], 1)}"'
        f' xChannelSelector="R" yChannelSelector="G" result="w"/>'
        f'<feGaussianBlur in="w" stdDeviation="{decimal(p["blur"], 2)}" result="s"/>'
        f'<feColorMatrix in="s" type="saturate" values="{decimal(p["sat"], 2)}"/></filter>'
        f'<filter id="ble{uid}" x="-55%" y="-45%" width="210%" height="195%"'
        f' color-interpolation-filters="sRGB">'
        f'<feTurbulence type="fractalNoise" baseFrequency="{decimal(p["bleedFreq"], 4)}"'
        f' numOctaves="3" seed="{seed + 11}" result="n"/>'
        f'<feDisplacementMap in="SourceGraphic" in2="n" scale="{decimal(p["bleedDisp"], 1)}"'
        f' xChannelSelector="R" yChannelSelector="G" result="w"/>'
        f'<feGaussianBlur in="w" stdDeviation="{decimal(p["bleedBlur"], 2)}"/></filter>'
        f'<style>#{uid} .fill{{fill:{ink}}}'
        f'#{uid} .st{{fill:none;stroke:{ink};stroke-linecap:round;stroke-linejoin:round}}'
        f'#{uid} .paperfill{{fill:{paper}}}'
        f'#{uid} .paperst{{fill:none;stroke:{paper};stroke-linecap:round}}</style>'
        f'</defs>'
        f'{substrate_layer(traits["substrate"], uid, a)}'
        f'{scar_layer(scars, mulberry32(seed + 7))}'
        f'<g filter="url(#ble{uid})" opacity="{0 if dry else decimal(p["bleedOp"], 2)}">{inner}</g>'
        f'<g filter="url(#dis{uid})" opacity="{decimal(p["op"], 2)}">{inner}</g>'
        f'{emblem}'
        f'<rect width="400" height="620" filter="url(#grain{uid})" opacity=".055"'
        f' style="mix-blend-mode:multiply"/>'
        f'{_footer(plate_id, ink, "DRY DOCK" if dry else st["name"].upper())}'
        f'</svg>'
    )


def _footer(plate_id: int, ink: str, right: str) -> str:
    """The plate number and the state it was last read at, along the bottom edge.

    Every state of a plate carries this, which is why it is factored out: it is the
    one part of the picture that is the same whether the ink is crisp, dissolving,
    drowned or still in the tube.
    """
    return (
        f'<g font-family="\'JetBrains Mono\',monospace" fill="{ink}" opacity=".5">'
        f'<text x="20" y="600" font-size="11" letter-spacing="1.6">No. {plate_id:04d} / 2222</text>'
        f'<text x="380" y="600" font-size="11" letter-spacing="1.6" text-anchor="end">{right}</text>'
        f'</g>'
    )


def _relic(key: str, a: Assets, r: Callable[[], int]) -> str:
    """Relic in its specimen card, with four encrustation barnacles drawn off the
    plate's own stream so no two cards weather identically.

    The only place in the art where a draw is offset into negative territory, which
    is why `fmt` carries a sign at all.
    """
    fragment = a.fragment("relic", key)
    if not fragment.strip():
        return ""
    encrustation = "".join(
        f'<circle cx="{fmt(numerator(r(), 170, -85), TWO32 * 100, 2)}" '
        f'cy="{fmt(numerator(r(), 150, -55), TWO32 * 100, 2)}" '
        f'r="{fmt(numerator(r(), 10, 6), TWO32 * 100, 2)}" class="fill" '
        f'opacity="{fmt(numerator(r(), 30, 30), TWO32 * 100, 2)}"/>'
        for _ in range(4)
    )
    return (
        a.fragment("_frame", "relic")
        .replace("{{CONTENT}}", fragment)
        .replace("{{ENCRUSTATION}}", encrustation)
    )


def _drowned_plate(plate_id: int, uid: str, emblem: str) -> str:
    """What is left when the position liquidated. The underwriter's stamp stays
    crisp while everything it insured is gone — the plate's whole argument."""
    return (
        f'<svg viewBox="0 0 400 620" id="{uid}" xmlns="http://www.w3.org/2000/svg" role="img"'
        f' aria-label="Plate {plate_id}, drowned">'
        f'<defs><radialGradient id="dg{uid}" cx="50%" cy="42%" r="72%">'
        f'<stop offset="0" stop-color="#0A131C"/><stop offset="1" stop-color="#03060A"/>'
        f'</radialGradient>'
        f'<style>#{uid} .fill{{fill:{OXBLOOD}}}'
        f'#{uid} .st{{fill:none;stroke:{OXBLOOD};stroke-linecap:round;stroke-linejoin:round}}'
        f'#{uid} .paperfill{{fill:{ABYSS}}}'
        f'#{uid} .paperst{{fill:none;stroke:{ABYSS};stroke-linecap:round}}</style></defs>'
        f'<rect width="400" height="620" fill="url(#dg{uid})"/>'
        f'<path d="M0 300 Q100 288 200 300 T400 296" stroke="#16303F" stroke-width="1.4"'
        f' fill="none" opacity=".7"/>'
        f'<path d="M0 334 Q120 320 200 334 T400 328" stroke="#16303F" stroke-width="1"'
        f' fill="none" opacity=".5"/>'
        f'{emblem}'
        f'<text x="200" y="586" text-anchor="middle" fill="{OXBLOOD}"'
        f' font-family="\'JetBrains Mono\',monospace" font-size="13" letter-spacing="3">DROWNED</text>'
        f'</svg>'
    )


def _sealed_plate(plate_id: int) -> str:
    """Before the reveal: the plate still rolled up in its survey tube.

    Deliberately not a placeholder image. Every plate is identical here, which is
    the honest thing to show while the trait offset is undrawn — there is nothing
    to reveal yet, and a teaser that hinted otherwise would be a lie about when the
    randomness happened. Sepia on washi with no dissolve filter at all: the tube
    has not been in the water.

    The plate number is real, though, and it is the same footer every other state
    carries. What is sealed is which plate it is, not that it is one.
    """
    uid = f"p{plate_id}"
    return (
        f'<svg viewBox="0 0 400 620" id="{uid}" xmlns="http://www.w3.org/2000/svg" role="img"'
        f' aria-label="Plate {plate_id}, sealed survey tube">'
        f'<defs>'
        f'<filter id="grain{uid}" x="0" y="0" width="100%" height="100%">'
        f'<feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="3" result="n"/>'
        f'<feColorMatrix in="n" type="saturate" values="0"/></filter>'
        f'<style>#{uid} .fill{{fill:{SEPIA}}}'
        f'#{uid} .st{{fill:none;stroke:{SEPIA};stroke-linecap:round;stroke-linejoin:round}}'
        f'#{uid} .paperfill{{fill:{WASHI}}}</style>'
        f'</defs>'
        f'<rect width="400" height="620" fill="{WASHI}"/>'
        # The hanging ring, then the tube: cap, body, base.
        f'<circle cx="200" cy="94" r="11" class="st" stroke-width="2.6"/>'
        f'<path d="M200 105 V126" class="st" stroke-width="2.6"/>'
        f'<rect x="146" y="126" width="108" height="34" rx="8" class="st" stroke-width="2.6"/>'
        f'<rect x="152" y="158" width="96" height="318" rx="12" class="st" stroke-width="2.6"/>'
        f'<rect x="146" y="470" width="108" height="30" rx="8" class="st" stroke-width="2.6"/>'
        # The rolled chart showing through, and the seams of the roll.
        f'<path d="M176 180 V456 M200 174 V462 M224 180 V456" class="st" stroke-width="1"'
        f' opacity=".38"/>'
        # Wax, with an ink drop struck into it in place of the emblem nobody has
        # been assigned yet.
        f'<circle cx="200" cy="318" r="27" class="fill" opacity=".88"/>'
        f'<circle cx="200" cy="318" r="27" fill="none" stroke="{WASHI}" stroke-width="1.4"/>'
        f'<path d="M200 306 q10 13 0 22 q-10 -9 0 -22 z" class="paperfill"/>'
        f'<rect width="400" height="620" filter="url(#grain{uid})" opacity=".055"'
        f' style="mix-blend-mode:multiply"/>'
        f'{_footer(plate_id, SEPIA, "SEALED")}'
        f'</svg>'
    )


# ─── Metadata ─────────────────────────────────────────────────────────────
#
# The other half of what the chain returns. `render_plate` produces the image;
# `token_uri` produces the `data:application/json;base64,…` that wraps it, so this
# file is the oracle for the whole of `tokenURI` and not just the picture.
#
# The prose is transcribed from UnderwaterRenderer.sol rather than read from
# anywhere, for the same reason the palette is: a contract cannot load JSON. The
# difference is that nothing has to guard these — the fixtures are generated from
# here and the differential test compares the finished URI byte for byte, so drift
# fails a test instead of shipping.

LIVE_NOTE = (
    "A leveraged Aave position on Ink, drawn from life. The ink holds while the position does,"
    " and comes apart in the water as the health factor falls toward liquidation. Rendered"
    " entirely on chain, from the health factor at the moment you asked for it."
)

DROWNED_NOTE = (
    "This position liquidated. What the plate recorded is gone and the paper with it; the"
    " underwriter's stamp is all that stayed crisp. The engraved kill went to whoever closed"
    " the position."
)

SEALED_NOTE = (
    "A sealed survey tube. Which plate is inside is decided when the collection reveals - not"
    " before it, and not by anyone. Every tube looks like this one, because at this point every"
    " tube is this one."
)


def attributes(traits: dict, a: Assets, state: str, scars: int | None) -> str:
    """The token's `attributes` array contents.

    Ten static traits then the two that move. Deliberately no health factor and no
    depth: the health factor changes every block and marketplaces cache metadata,
    and depth is a restatement of the state band that the two non-depth states
    would need one invented for.
    """
    out = ""
    for cat in a.manifest["categories"]:
        key = cat["key"]
        option = next(o for o in cat["options"] if o["key"] == traits[key])
        out += f'{{"trait_type":"{cat["label"]}","value":"{option["label"]}"}},'

    out += f'{{"trait_type":"State","value":"{state}"}}'
    if scars is not None:
        out += f',{{"display_type":"number","trait_type":"Scars","value":{min(scars, MAX_SCARS)}}}'
    return out


def token_uri(plate_id: int, image: str, attrs: str, note: str) -> str:
    """`data:application/json;base64,…`, the way UnderwaterRenderer._uri builds it.

    Base64 for the image rather than a raw SVG data URI: the palette is full of `#`,
    which a raw data URI has to percent-encode and which several marketplaces get
    wrong when it is not encoded.
    """
    from base64 import b64encode  # noqa: PLC0415

    def b64(s: str) -> str:
        return b64encode(s.encode("utf8")).decode("ascii")

    body = (
        f'{{"name":"Underwater #{plate_id}","description":"{note}",'
        f'"image":"data:image/svg+xml;base64,{b64(image)}",'
        f'"attributes":[{attrs}]}}'
    )
    return f"data:application/json;base64,{b64(body)}"


def render_token(
    plate_id: int,
    traits: dict,
    a: Assets,
    hf: float = float("inf"),
    scars: int = 0,
    dry: bool = False,
    drowned: bool = False,
    sealed: bool = False,
) -> tuple[str, str]:
    """One plate's image and token URI together, from the same arguments the
    on-chain `render` takes. The whole of what a wallet sees."""
    image = render_plate(plate_id, traits, a, hf=hf, scars=scars, dry=dry, drowned=drowned,
                         sealed=sealed)

    if sealed:
        return image, token_uri(plate_id, image, '{"trait_type":"State","value":"Sealed"}',
                                SEALED_NOTE)
    if drowned or hf <= 1.0:
        return image, token_uri(plate_id, image, attributes(traits, a, "Drowned", scars),
                                DROWNED_NOTE)

    state = "Dry Dock" if dry else state_for(to_wad(hf), a.states)["name"]
    return image, token_uri(plate_id, image, attributes(traits, a, state, scars), LIVE_NOTE)


# ─── Showcase sheets ──────────────────────────────────────────────────────
#
# Committed output, so it has to be reproducible from the repo rather than from
# a throwaway script: same table, same picks, same sheets on every run.

SHOWCASE = ROOT / "art" / "showcase"

# What a plate looks like as the position behind it goes under. Ordered.
PROGRESSION = [
    ("sealed", "SEALED", {"sealed": True}),
    ("dry", "DRY DOCK", {"dry": True}),
    ("surface", "SURFACE 2.60", {"hf": 2.60}),
    ("twilight", "TWILIGHT 1.90", {"hf": 1.90}),
    ("midnight", "MIDNIGHT 1.45", {"hf": 1.45, "scars": 1}),
    ("crush", "CRUSH 1.05", {"hf": 1.05, "scars": 3}),
    ("drowned", "DROWNED", {"drowned": True, "scars": 3}),
]

VARIETY_HF = 2.2
VARIETY_COLS = 3
VARIETY_COUNT = 6


def _body(svg: str) -> str:
    """The plate's contents without its <svg> shell, for nesting into a sheet."""
    return svg[svg.index(">", svg.index("<svg")) + 1 : svg.rindex("</svg>")]


def _sheet(cells: list[tuple[str, str]], path: Path, cols: int) -> None:
    w, h, gap, caption = 400, 620, 24, 70
    rows = -(-len(cells) // cols)
    cw, ch = w + gap, h + caption
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{cw * cols}" height="{ch * rows}"'
        f' viewBox="0 0 {cw * cols} {ch * rows}"><rect width="100%" height="100%" fill="#0B0F14"/>'
    ]
    for i, (label, inner) in enumerate(cells):
        x, y = (i % cols) * cw + gap // 2, (i // cols) * ch + 46
        parts.append(f'<g transform="translate({x} {y})">{inner}</g>')
        parts.append(
            f'<text x="{x + w // 2}" y="{y - 14}" text-anchor="middle" fill="#8FA3B0"'
            f' font-family="monospace" font-size="16" letter-spacing="1.5">{label}</text>'
        )
    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf8")


def showcase(a: Assets, plates: list[dict]) -> None:
    """Two sheets: one plate across every state, and one state across plates.

    Separating the two axes is the point. A single grid of random plates at random
    health factors shows neither what the traits do nor what the dissolve does.
    """
    SHOWCASE.mkdir(parents=True, exist_ok=True)

    # Pick from the table, not by number, and pick for coverage: a plate that
    # exercises the specimen card, a headgear, a scene and the stamp puts four of
    # the six drawn categories on one sheet. The stamp is pinned to Ink·Kraken
    # because the emblem frame is identical for all eight marks, so choosing the
    # chain's own costs nothing and says where this launches.
    hero = next(
        (
            p
            for p in plates
            if p["traits"]["relic"] != "none"
            and p["traits"]["emblem"] == "kraken"
            and p["traits"]["headgear"] != "bare"
            and p["traits"]["scene"] != "openWater"
        ),
        None,
    )
    if hero is None:
        die("no plate matches the showcase criteria — is traits.json stale?")

    base = {"hf": float("inf"), "scars": 0, "dry": False, "drowned": False, "sealed": False}
    cells = []
    for name, label, kw in PROGRESSION:
        svg = render_plate(hero["slot"] + 1, hero["traits"], a, **{**base, **kw})
        (SHOWCASE / f"{name}.svg").write_text(svg, encoding="utf8")
        cells.append((label, _body(svg)))
    _sheet(cells, SHOWCASE / "progression.svg", len(cells))

    # One plate per diver, all at the same health factor, so the difference on
    # screen is the traits and not the state.
    picks: list[dict] = []
    for p in plates:
        t = p["traits"]
        if t["relic"] == "none" or t["emblem"] == "none":
            continue
        if any(t["diver"] == q["traits"]["diver"] for q in picks):
            continue
        picks.append(p)
        if len(picks) == VARIETY_COUNT:
            break
    _sheet(
        [
            (
                f"#{p['slot'] + 1:04d} {p['traits']['diver']}/{p['traits']['pigment']}",
                _body(render_plate(p["slot"] + 1, p["traits"], a, hf=VARIETY_HF)),
            )
            for p in picks
        ],
        SHOWCASE / "variety.svg",
        VARIETY_COLS,
    )

    traits = hero["traits"]
    summary = "/".join(traits[k] for k in ("diver", "headgear", "held", "relic", "emblem", "pigment"))
    print(f"\n  progression  plate {hero['slot'] + 1}  {summary}")
    print(f"  variety      {len(picks)} plates at HF {VARIETY_HF}")
    print(f"  -> {rel(SHOWCASE)}\n")


# ─── CLI ──────────────────────────────────────────────────────────────────


def die(message: str) -> None:
    print(f"\n  \033[31mfailed\033[0m {message}\n", file=sys.stderr)
    raise SystemExit(1)


def rel(path: Path) -> str:
    """Repo-relative when it can be, absolute when it can't. `--out` is free to
    point anywhere, and `relative_to` raises rather than falling back."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_collection() -> dict:
    if not COLLECTION.exists():
        die(f"{rel(COLLECTION)} missing — run `cd web && npm run traits` first")
    return json.loads(COLLECTION.read_text(encoding="utf8"))


def to_png(svg_path: Path) -> bool:
    try:
        import cairosvg  # noqa: PLC0415
    except ImportError:
        return False
    cairosvg.svg2png(url=str(svg_path), write_to=str(svg_path.with_suffix(".png")), output_width=800)
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description="Render Underwater plates from the extracted trait files.")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--slot", type=int, help="one table slot (0-based, as in traits.json)")
    group.add_argument("--all", action="store_true", help="the whole collection")
    group.add_argument("--showcase", action="store_true", help="the committed contact sheets")
    ap.add_argument("--hf", type=float, default=None, help="health factor; omit for dry dock")
    ap.add_argument("--scars", type=int, default=0, help="survived near-death dips (0-8)")
    ap.add_argument("--drowned", action="store_true", help="render the post-liquidation state")
    ap.add_argument("--sealed", action="store_true", help="render the pre-reveal survey tube")
    ap.add_argument("--out", type=Path, default=ROOT / "art" / "out", help="output directory")
    ap.add_argument("--png", action="store_true", help="also write PNG (requires cairosvg)")
    args = ap.parse_args()

    a = Assets()
    collection = load_collection()
    plates = collection["plates"]

    if not 0 <= args.scars <= 8:
        die("--scars must be 0..8, the collection's MAX_SCARS")

    if args.showcase:
        # The sheets fix their own states, so the state flags would be ignored
        # rather than honoured. Say so instead of quietly dropping them.
        if args.hf is not None or args.scars or args.drowned or args.sealed:
            die("--showcase sets its own states; drop --hf/--scars/--drowned/--sealed")
        showcase(a, plates)
        return

    if args.slot is not None:
        if not 0 <= args.slot < len(plates):
            die(f"--slot must be 0..{len(plates) - 1}")
        targets = [plates[args.slot]]
    else:
        targets = plates

    args.out.mkdir(parents=True, exist_ok=True)
    dry = args.hf is None and not args.drowned and not args.sealed
    hf = float("inf") if args.hf is None else args.hf

    wrote = 0
    pngs = 0
    for plate in targets:
        # Slot is table order. The plate *number* is only known after reveal, so
        # previews are labelled by slot and the number is stamped at mint time.
        svg = render_plate(
            plate["slot"] + 1,
            plate["traits"],
            a,
            hf=hf,
            scars=args.scars,
            dry=dry,
            drowned=args.drowned,
            sealed=args.sealed,
        )
        path = args.out / f"{plate['slot']:04d}.svg"
        path.write_text(svg, encoding="utf8")
        wrote += 1
        if args.png and to_png(path):
            pngs += 1

    state = (
        "sealed"
        if args.sealed
        else "drowned"
        if args.drowned
        else "dry dock"
        if dry
        else f"HF {hf}"
    )
    print(f"\n  wrote {wrote} SVG{'s' if wrote != 1 else ''} at {state}, {args.scars} scars")
    if args.png:
        print(f"  {pngs} PNGs" if pngs else "  no PNGs — pip install cairosvg")
    print(f"  -> {rel(args.out)}\n")


if __name__ == "__main__":
    main()

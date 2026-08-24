#!/usr/bin/env python3
"""Generates the Solidity asset libraries from art/traits/**.

The on-chain renderer needs the drawn assets as bytecode. Hand-transcribing 44
SVG fragments into string literals is exactly the kind of job that produces a
typo in one path nobody notices until a plate renders wrong on a marketplace, so
it is generated — from the same files, through the same loader, as art/render.py.
That shared loader is the point: `Assets.fragment` minifies, so the bytes embedded
here are byte-for-byte the bytes the Python renderer composes, which is what makes
differential testing of the port meaningful.

    python art/solidify.py

Writes src/nft/art/UnderwaterFigures.sol, UnderwaterMarks.sol, UnderwaterScenes.sol
and UnderwaterNames.sol.

Why four contracts: EIP-170 caps runtime code at 24,576 B and the assets are
~17.8 KB minified, so they cannot share a contract with the compose logic, the
dissolve math, Base64 and the JSON. Grouping is by how the renderer uses them —
the figure and what it wears, the marks and their chrome, the backdrop, and the
trait names that go in the metadata rather than the picture — so each call fetches
things that are always needed together.

The generated files are committed. They are build output, but they are also the
art, and a deployment should not depend on a Python interpreter being present.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from render import Assets, ROOT, die, rel  # noqa: E402

OUT = ROOT / "src" / "nft" / "art"

# Solidity string literals: single-quoted, so the SVG's own double quotes need no
# escaping. Asserted rather than assumed — see `check_literal`.
QUOTE = "'"

# fmt.line_length is 110. Adjacent string literals concatenate at compile time,
# so chunking costs nothing at runtime and keeps the source readable.
CHUNK = 88

# Which categories each contract carries, and the accessor that returns them.
# Order inside a group is the order the renderer asks for them in.
CONTRACTS = [
    {
        "name": "UnderwaterFigures",
        "notice": "The figure, and what it wears and carries — already planted on it.",
        "detail": (
            "The body is drawn in plate space. The headgear and the held item are unit sketches, "
            "which mean nothing until they are scaled onto a particular diver, so this contract "
            "wraps them in that diver's own anchor group before returning them."
        ),
        "params": [("diver", "diver"), ("headgear", "headgear"), ("held", "held")],
        "returns": ["body", "worn", "carried"],
    },
    {
        "name": "UnderwaterMarks",
        "notice": "The relic in its specimen card, and the underwriter's stamp.",
        "detail": (
            "Both unit-space, both returned already framed. The card comes back in two halves "
            "because the renderer has to drop four encrustation barnacles into the gap, drawn off "
            "the plate's own PRNG stream — which this contract has no access to and should not."
        ),
        "params": [("relic", "relic"), ("emblem", "emblem")],
        "returns": ["card", "cardClose", "stamp"],
    },
    {
        "name": "UnderwaterScenes",
        "notice": "The backdrop and the umbilical.",
        "detail": (
            "The backdrop is plate space. The tether is drawn as pure offsets from the diver's "
            "head, so it too comes back translated onto the diver it belongs to."
        ),
        "params": [("scene", "scene"), ("tether", "tether")],
        "returns": ["backdrop", "umbilical"],
    },
]

# The frame files carry these markers. Splitting on them yields N+1 literals.
PLACEHOLDERS = ["{{CONTENT}}", "{{ENCRUSTATION}}"]


# ─── Guards ───────────────────────────────────────────────────────────────


def check_literal(name: str, text: str) -> None:
    """Everything that would need escaping, or would silently corrupt the art."""
    if QUOTE in text:
        die(f"{name}: contains a single quote, which breaks the literal quoting")
    if "\\" in text:
        die(f"{name}: contains a backslash, which Solidity would read as an escape")
    if any(ord(c) > 127 or ord(c) < 32 for c in text):
        die(f"{name}: contains a non-printable or non-ASCII byte")
    if "{{" in text or "}}" in text:
        die(f"{name}: an unsubstituted placeholder survived into the output")


def check_minifiable(name: str, raw: str) -> None:
    """Minification drops whitespace between tags. That is only safe while no
    asset has text content or asks for whitespace to be preserved."""
    if re.search(r"<text|xml:space", raw):
        die(f"{name}: has a text node or xml:space, so minifying it would change the art")


# ─── Emit ─────────────────────────────────────────────────────────────────


def literal(text: str, indent: str) -> str:
    """One Solidity string literal, chunked across lines."""
    if not text:
        return f'{QUOTE}{QUOTE}'
    chunks = [text[i : i + CHUNK] for i in range(0, len(text), CHUNK)]
    joiner = f"\n{indent}"
    return joiner.join(f"{QUOTE}{c}{QUOTE}" for c in chunks)


def dispatch(category: str, options: list[str], a: Assets, indent: str = "        ") -> str:
    """An index -> markup lookup.

    A branch chain rather than an array of storage strings: the assets never
    change, so they belong in code where they cost nothing to hold and a
    `codecopy` to read, not in storage at 20k gas a slot to write.
    """
    lines = []
    for i, key in enumerate(options):
        frag = a.fragment(category, key)
        check_literal(f"{category}/{key}", frag)
        if not frag:
            # An intentionally blank option — "Bare", "Empty hands", "Unstamped".
            # Returns "" so the renderer needs no per-category special case.
            lines.append(f'{indent}if (i == {i}) return ""; // {key}')
            continue
        body = literal(frag, indent + "    ")
        lines.append(f"{indent}if (i == {i}) {{\n{indent}    // {key}\n{indent}    return {body};\n{indent}}}")
    return "\n".join(lines)


def frame_parts(name: str, a: Assets) -> list[str]:
    """A frame split at its placeholders, in order."""
    raw = a.fragment("_frame", name)
    parts = [raw]
    for marker in PLACEHOLDERS:
        parts = [seg for part in parts for seg in part.split(marker)]
    return [p for p in parts if p != ""] if len(parts) > 1 else parts


# ─── Anchors ──────────────────────────────────────────────────────────────
#
# Three of the drawn categories are unit sketches: a diving helmet is a 1x1
# drawing that means nothing until it is scaled onto a particular skull, and no
# two divers' skulls are in the same place. The prototype assembled those
# transforms at render time from the manifest's anchor table.
#
# On chain they are emitted as one finished literal per diver instead. Six short
# strings cost less code than an anchor table plus the integer formatting needed
# to read it, they cost nothing at all to evaluate, and — the actual reason — the
# renderer then never handles a coordinate. There is no arithmetic to get wrong in
# the one place a mistake would be invisible until a helmet floated off a head.


def head_group(anchor: dict) -> str:
    """The group that plants a unit-space headgear on this diver's head."""
    head = anchor["head"]
    return f'<g transform="translate({head["x"]} {head["y"]}) scale({head["r"]})">'


def hand_group(anchor: dict, scale: int) -> str:
    """...and one in the hand, turned to the angle the hand is held at."""
    hand = anchor["hand"]
    return f'<g transform="translate({hand["x"]} {hand["y"]}) rotate({hand["rot"]}) scale({scale})">'


def tether_group(anchor: dict) -> str:
    """The umbilical leaves from just above and behind the head."""
    head = anchor["head"]
    return f'<g transform="translate({head["x"] + 32} {head["y"] - 24})">'


ANCHORS = {
    "head": ("_headAnchor", "Where a headgear sits on each diver", head_group),
    "hand": ("_handAnchor", "Where a held item sits, and at what angle", hand_group),
    "tether": ("_tetherAnchor", "Where the umbilical leaves the helmet", tether_group),
}


def anchor_fn(kind: str, a: Assets) -> str:
    name, note, build = ANCHORS[kind]
    scale = [a.transforms["held"]["scale"]] if kind == "hand" else []

    branches = []
    for i, opt in enumerate(a.categories["diver"]["options"]):
        group = build(a.anchors[opt["key"]], *scale)
        check_literal(f"anchor/{kind}/{opt['key']}", group)
        branches.append(f"        if (diver == {i}) return {QUOTE}{group}{QUOTE}; // {opt['key']}")

    return (
        f"    /// @dev {note}, as the group that puts it there. Generated from the\n"
        f"    ///      manifest's anchor table, so the six transforms cannot drift from the\n"
        f"    ///      ones art/render.py composes.\n"
        f"    function {name}(uint256 diver) private pure returns (string memory) {{\n"
        + "\n".join(branches)
        + "\n        revert BadIndex();\n    }"
    )


# ─── Assembly ─────────────────────────────────────────────────────────────
#
# What each contract's `parts` does with its lookups. The three differ enough
# that a table would be three exceptions, so they are written out.
#
# The shared idiom is that a blank option returns "" and the wrapper is skipped
# with it: an empty <g> would be harmless in the picture but it would not be the
# bytes art/render.py produces, and byte-identity is the only thing making the
# differential test worth running.

ASSEMBLY = {
    "UnderwaterFigures": """        body = _diver(diver);

        string memory sketch = _headgear(headgear);
        if (bytes(sketch).length != 0) worn = string.concat(_headAnchor(diver), sketch, "</g>");

        sketch = _held(held);
        if (bytes(sketch).length != 0) carried = string.concat(_handAnchor(diver), sketch, "</g>");""",
    "UnderwaterMarks": """        string memory specimen = _relic(relic);
        if (bytes(specimen).length != 0) {
            card = string.concat(CARD_OPEN, specimen);
            cardClose = CARD_CLOSE;
        }

        string memory mark = _emblem(emblem);
        if (bytes(mark).length != 0) stamp = string.concat(STAMP_OPEN, mark, STAMP_CLOSE);""",
    "UnderwaterScenes": """        backdrop = _scene(scene);

        // Unconditional, unlike the other wrappers: every tether option draws
        // something, so there is no blank case to skip and no reason to pay for
        // the check.
        umbilical = string.concat(_tetherAnchor(diver), _tether(tether), "</g>");""",
}

# The literals `UnderwaterMarks.parts` reaches for, in the order the frames split.
MARK_FRAMES = [("relic", ["CARD_OPEN", "CARD_CLOSE"]), ("emblem", ["STAMP_OPEN", "STAMP_CLOSE"])]

RETURN_DOCS = {
    "UnderwaterFigures": [
        "The diver, in plate space.",
        "The headgear, anchored to this diver's head, or \"\" if bare.",
        "The held item, anchored and rotated to this diver's hand, or \"\" if empty-handed.",
    ],
    "UnderwaterMarks": [
        "The specimen card up to the point the encrustation goes, or \"\" if there is no relic.",
        "The rest of the card, to close after it.",
        "The emblem in the underwriter's stamp, or \"\" if unstamped.",
    ],
    "UnderwaterScenes": [
        "The backdrop, in plate space.",
        "The umbilical, translated onto this diver's helmet.",
    ],
}


def contract(spec: dict, a: Assets) -> str:
    name = spec["name"]
    params = spec["params"]
    returns = spec["returns"]

    # The diver index is an input to Figures and Scenes because both plant
    # something on the figure. Marks does not need it.
    needs_diver = name != "UnderwaterMarks"
    args = [p for _, p in params]
    if name == "UnderwaterScenes":
        args.append("diver")

    sig_args = ", ".join(f"uint256 {p}" for p in args)
    ret_sig = ", ".join(f"string memory {r}" for r in returns)
    ret_doc = "\n".join(
        f"    /// @return {r} {d}" for r, d in zip(returns, RETURN_DOCS[name], strict=True)
    )

    fns = []
    for cat, _ in params:
        options = [o["key"] for o in a.categories[cat]["options"]]
        counts = f"{len(options)} option{'s' if len(options) != 1 else ''}"
        fns.append(
            f"    /// @dev {a.categories[cat]['label']}, {counts}, index order fixed by the\n"
            f"    ///      trait table. Reverts on an out-of-range index rather than drawing\n"
            f"    ///      nothing, because a silent blank would look like valid art.\n"
            f"    function _{cat}(uint256 i) private pure returns (string memory) {{\n"
            f"{dispatch(cat, options, a)}\n"
            f"        revert BadIndex();\n"
            f"    }}"
        )

    if name == "UnderwaterFigures":
        fns = [anchor_fn("head", a), anchor_fn("hand", a)] + fns
    elif name == "UnderwaterScenes":
        fns = [anchor_fn("tether", a)] + fns

    # The frame chrome, as constants rather than lookups: there is one card and
    # one stamp, so there is nothing to dispatch on.
    frames = ""
    if name == "UnderwaterMarks":
        consts = []
        for fname, const_names in MARK_FRAMES:
            pieces = frame_parts(fname, a)
            if len(pieces) != len(const_names):
                die(f"_frame/{fname}: split into {len(pieces)} literals, expected {len(const_names)}")
            for i, (piece, const) in enumerate(zip(pieces, const_names, strict=True)):
                check_literal(f"_frame/{fname}[{i}]", piece)
                consts.append(
                    f"    string private constant {const} =\n        {literal(piece, '        ')};"
                )
        frames = (
            "\n    /// @dev The chrome around the marks, split where content goes into it.\n"
            + "\n\n".join(consts)
            + "\n"
        )

    detail = "\n".join(f"///         {line}" for line in wrap(spec["detail"], 84))
    diver_note = (
        "\n    ///      Takes the diver index as well as its own, because what it returns is\n"
        "    ///      positioned against that diver and a caller has no business doing that\n"
        "    ///      arithmetic itself.\n"
        if needs_diver
        else ""
    )

    return f"""// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title {name}
/// @notice {spec["notice"]}
{detail}
///
/// @dev GENERATED by `python art/solidify.py` from art/traits/**. Do not edit by
///      hand — regenerate. The markup is byte-for-byte what art/render.py
///      composes off chain, which is what lets the two be diffed against each
///      other instead of eyeballed.
///
///      Stateless, ownerless, immutable: there is nothing to configure and
///      nothing to trust here beyond the bytes, which anyone can read back with
///      `eth_getCode` and compare against this file.
contract {name} {{
    error BadIndex();
{frames}
    /// @notice Every asset this contract holds, for one plate, ready to compose.
    /// @dev Batched because the renderer always needs all of them, and one
    ///      staticcall returning {len(returns)} strings beats {len(returns)} calls returning one.
{diver_note}{ret_doc}
    function parts({sig_args})
        external
        pure
        returns ({ret_sig})
    {{
{ASSEMBLY[name]}
    }}

{chr(10).join(fns)}
}}
"""


def wrap(text: str, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines


# ─── Names ────────────────────────────────────────────────────────────────
#
# The metadata half. Separate from the art because it covers all ten categories —
# including fauna, pigment and substrate, which are procedural or colour and have
# no drawn file — and because building the JSON where the label bytes already live
# is cheaper than returning ten strings across a call boundary for the renderer to
# assemble.

TRAIT_BITS = 4
NIBBLE = (1 << TRAIT_BITS) - 1


def check_label(name: str, label: str) -> None:
    """A label lands inside a JSON string in the token URI, so the two characters
    that would break out of it are fatal, and so is anything unprintable."""
    if '"' in label or "\\" in label:
        die(f"{name}: label {label!r} contains a quote or backslash, which would break the JSON")
    if any(ord(c) < 32 for c in label):
        die(f"{name}: label {label!r} contains a control character")


def label_literal(label: str) -> str:
    """A Solidity string literal for a label.

    `unicode"..."` when the label is not pure ASCII — the Ink emblem is called
    "Ink · Kraken" and the middle dot is the point of it. Two UTF-8 bytes land in
    the JSON, which is UTF-8 by specification, so marketplaces read it correctly.
    """
    prefix = "" if label.isascii() else "unicode"
    return f'{prefix}"{label}"'


def names_contract(a: Assets) -> str:
    categories = [a.categories[c["key"]] for c in a.manifest["categories"]]

    entries, lookups = [], []
    for slot, cat in enumerate(categories):
        key, label = cat["key"], cat["label"]
        check_label(key, label)
        extract = "traits & 15" if slot == 0 else f"(traits >> {slot * TRAIT_BITS}) & {NIBBLE}"
        entries.append(f"            _attr({label_literal(label)}, _{key}({extract}))")

        branches = []
        for opt in cat["options"]:
            check_label(f"{key}/{opt['key']}", opt["label"])
            branches.append(f'        if (i == {opt["index"]}) return {label_literal(opt["label"])};')
        lookups.append(
            f"    /// @dev {label}, {len(cat['options'])} options. Reverts rather than\n"
            f"    ///      returning a placeholder, so a bad index cannot mint quiet metadata.\n"
            f"    function _{key}(uint256 i) private pure returns (string memory) {{\n"
            + "\n".join(branches)
            + "\n        revert BadIndex();\n    }"
        )

    # Split in half. Ten `_attr` calls in one `concat` is ten inlined lookups and
    # ten inlined concats in a single stack frame, which overflows the stack
    # allocator — `Stack too deep` at the Yul stage, with no line number to point
    # at. Two halves of five is well clear of it, and the seam is invisible in the
    # output.
    half = len(entries) // 2
    groups = [
        ("_first", entries[:half], categories[:half]),
        ("_rest", entries[half:], categories[half:]),
    ]
    builders = [
        f"    /// @dev {', '.join(c['label'] for c in cats)}.\n"
        f"    function {fname}(uint256 traits) private pure returns (string memory) {{\n"
        f"        return string.concat(\n" + ",\n".join(group) + "\n        );\n    }"
        for fname, group, cats in groups
    ]

    return f"""// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title UnderwaterNames
/// @notice The trait names, and the metadata attributes built from them.
///
/// @dev GENERATED by `python art/solidify.py` from art/traits/manifest.json. Do
///      not edit by hand — regenerate.
///
///      Held apart from the art contracts because this covers all ten categories,
///      including the three with nothing drawn: fauna is procedural, pigment and
///      substrate are colour. And because the JSON is assembled here, where the
///      label bytes already are, rather than returning ten strings for the
///      renderer to stitch together.
///
///      Labels are not part of `provenance` — that hash covers the trait table,
///      which is indices. A name can be corrected by deploying a new renderer,
///      right up until `freezeRenderer`.
contract UnderwaterNames {{
    error BadIndex();

    /// @notice The token's `attributes` entries for one plate's packed traits.
    /// @dev Every entry carries a trailing comma, because the renderer always
    ///      appends the live ones — depth, state, scars — after these. Ten static
    ///      traits followed by at least one dynamic one, so the comma is never
    ///      dangling.
    function attributes(uint256 traits) external pure returns (string memory) {{
        return string.concat(_first(traits), _rest(traits));
    }}

{chr(10).join(builders)}

    /// @dev One attribute object. Factored out so the JSON punctuation is stored
    ///      once instead of ten times.
    function _attr(string memory kind, string memory value) private pure returns (string memory) {{
        return string.concat('{{"trait_type":"', kind, '","value":"', value, '"}},');
    }}

{chr(10).join(lookups)}
}}
"""


# ─── Main ─────────────────────────────────────────────────────────────────


def main() -> None:
    a = Assets()

    # Minification is only sound while this holds, and it is cheap to keep checking.
    for cat in a.categories:
        if a.categories[cat].get("space") == "procedural":
            continue
        for opt in a.categories[cat]["options"]:
            path = a.dir / cat / f"{opt['key']}.svg"
            if path.exists():
                check_minifiable(f"{cat}/{opt['key']}", path.read_text(encoding="utf8"))

    OUT.mkdir(parents=True, exist_ok=True)
    dim = "\x1b[2m{}\x1b[0m".format
    gold = "\x1b[33m{}\x1b[0m".format

    print(f"\n  {gold('Underwater')} asset libraries\n")
    total = 0
    for spec in CONTRACTS:
        source = contract(spec, a)
        path = OUT / f"{spec['name']}.sol"
        path.write_text(source, encoding="utf8")

        assets = sum(
            len(a.fragment(cat, o["key"]))
            for cat, _ in spec["params"]
            for o in a.categories[cat]["options"]
        )
        if spec["name"] == "UnderwaterMarks":
            assets += sum(len(a.fragment("_frame", f)) for f, _ in MARK_FRAMES)
        total += assets
        cats = "+".join(cat for cat, _ in spec["params"])
        print(f"  {spec['name']:20} {assets:6} B of markup  {dim(cats)}")

    (OUT / "UnderwaterNames.sol").write_text(names_contract(a), encoding="utf8")
    labels = sum(
        len(c["label"]) + sum(len(o["label"]) for o in c["options"])
        for c in a.manifest["categories"]
    )
    print(f"  {'UnderwaterNames':20} {labels:6} B of labels  {dim('all 10 categories')}")

    print(f"\n  {total} B total, {total / 24576:.0%} of one EIP-170 contract if merged")
    print(dim(f"  wrote {rel(OUT)}/*.sol"))
    print(dim("  check the compiled sizes with: forge build --sizes\n"))


if __name__ == "__main__":
    main()

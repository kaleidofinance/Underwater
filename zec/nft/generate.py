"""
Generate the Underwater Plates trait table for Zcash: 4,444 unique plates.

    python zec/nft/generate.py

Ported from the EVM collection's web/scripts/traits.mjs: the same weighted
draw from art/traits/manifest.json, the same mulberry32 stream, the same
rejection of any repeated trait set. What changed: the supply (2,222 → 4,444),
44 gold-leaf aberrations instead of 22, and no EVM bit-packing. The
commitment is a SHA-256 over the canonical table instead of keccak over
packed words.

Writes traits/traits.json and traits/provenance.txt. Publish the provenance
hash before minting: it proves the table wasn't rearranged after anyone knew
which plate they'd get.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "art" / "traits" / "manifest.json"
OUT = HERE / "traits"

SUPPLY = 4444
ABERRATIONS = 44
ABERRATION_SEED = 0xABE2A71
M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    """JavaScript's Math.imul: 32-bit multiply, signed result."""
    r = ((a & M32) * (b & M32)) & M32
    return r - (1 << 32) if r & 0x80000000 else r


def mulberry32(seed: int):
    """Ported from the JS generator bit for bit (including its signed 32-bit steps)."""
    a = seed & M32

    def rand() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        ua = a
        t = _imul(ua ^ (ua >> 15), 1 | ua) & M32
        t = ((t + _imul(t ^ (t >> 7), 61 | t)) & M32) ^ t
        return ((t ^ (t >> 14)) & M32) / 4294967296

    return rand


def weighted(rand, pairs: list[tuple[str, int]]) -> str:
    total = sum(w for _, w in pairs)
    x = rand() * total
    for value, w in pairs:
        x -= w
        if x <= 0:
            return value
    return pairs[0][0]


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf8"))
    categories = manifest["categories"]
    keys = [c["key"] for c in categories]
    weights = {c["key"]: [(o["key"], o["weight"]) for o in c["options"]] for c in categories}

    aberrant: set[int] = set()
    ar = mulberry32(ABERRATION_SEED)
    while len(aberrant) < ABERRATIONS:
        aberrant.add(1 + int(ar() * SUPPLY))

    seen: set[str] = set()
    plates = []
    attempts = rejected = 0
    while len(plates) < SUPPLY:
        attempts += 1
        n = len(plates) + 1
        rand = mulberry32((n * 2654435761) ^ ((attempts * 40503) & M32))
        rand()
        rand()
        traits = {k: weighted(rand, weights[k]) for k in keys}
        if n in aberrant:
            traits["pigment"] = "goldleaf"
        combo = "|".join(traits[k] for k in keys)
        if combo in seen:
            rejected += 1
            continue
        seen.add(combo)
        plates.append({"slot": len(plates), "traits": traits, "aberration": n in aberrant})

    if len({"|".join(p["traits"][k] for k in keys) for p in plates}) != SUPPLY:
        raise SystemExit("duplicate trait sets")

    canonical = json.dumps([[p["traits"][k] for k in keys] for p in plates], separators=(",", ":"))
    provenance = hashlib.sha256(canonical.encode()).hexdigest()

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "traits.json").write_text(
        json.dumps(
            {
                "supply": SUPPLY,
                "provenance": provenance,
                "note": "Underwater Plates on Zcash. provenance = sha256 of the JSON array of each plate's trait keys in category order, slot order, no spaces.",
                "categories": keys,
                "plates": plates,
            },
            indent=1,
        )
        + "\n",
        encoding="utf8",
    )
    (OUT / "provenance.txt").write_text(provenance + "\n", encoding="utf8")

    counts: dict[str, dict[str, int]] = {k: {} for k in keys}
    for p in plates:
        for k in keys:
            counts[k][p["traits"][k]] = counts[k].get(p["traits"][k], 0) + 1
    print(f"  plates      {SUPPLY}, all unique ({rejected} repeats rejected in {attempts} draws)")
    print(f"  gold leaf   {counts['pigment'].get('goldleaf', 0)} ({ABERRATIONS} forced)")
    print(f"  provenance  {provenance}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Builds the allowlist Merkle tree: one root for the contract, one proof per address.

Run before `setMerkleRoot`. Reads a list of addresses and writes:

  * the root, to paste into `script/SetWhitelist.s.sol` or a `cast send`
  * `web/public/whitelist.json`, which the mint page fetches to hand each visitor
    the proof for their own address — proofs are public data, they authorise
    nothing on their own, and there are only as many as there are members

The tree matches `src/utils/MerkleProof.sol` exactly, which means three rules that
are easy to get subtly wrong:

  1. **Leaves are hashed twice**: `keccak256(keccak256(abi.encode(address)))`.
     `abi.encode` of an address is 32 bytes, left-padded — not 20. The second hash
     is what stops an internal node being presented as somebody's leaf.
  2. **Pairs are sorted** before hashing, so a proof needs no left/right flags.
  3. **A lone node at the end of an odd layer is promoted**, not hashed against
     itself. That is what merkletreejs does, and it changes the root.

Written against the vendored `art/keccak.py` for the same reason that exists: no
dependency should sit between a launch parameter and the person checking it. The
tree is also rebuilt independently in `test/utils/MerkleProof.t.sol` from this
script's own output, so the two implementations are pinned against each other.

Usage:
    python script/whitelist.py                       # reads script/whitelist.txt
    python script/whitelist.py members.txt
    python script/whitelist.py --addresses 0xabc...,0xdef...
    python script/whitelist.py --solidity            # emit the Solidity fixture
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "art"))

from keccak import keccak256  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / "script" / "whitelist.txt"
# Inside `public/`, so Next serves it as a static asset at /whitelist.json and a
# deployment with no allowlist yet answers 404 instead of failing the build. The
# mint page checks the root in here against the root on chain before trusting a
# proof from it — see `useMembership`.
DEFAULT_OUTPUT = ROOT / "web" / "public" / "whitelist.json"


def leaf(address: str) -> bytes:
    """keccak256(keccak256(abi.encode(address))) — the contract's `_leaf`."""
    word = bytes(12) + bytes.fromhex(address[2:])
    return keccak256(keccak256(word))


def pair(a: bytes, b: bytes) -> bytes:
    return keccak256(a + b) if a < b else keccak256(b + a)


def build(addresses: list[str]) -> tuple[bytes, list[list[bytes]]]:
    """Returns the root and every layer, leaves first."""
    layers = [[leaf(a) for a in addresses]]
    while len(layers[-1]) > 1:
        below = layers[-1]
        layers.append([
            pair(below[i], below[i + 1]) if i + 1 < len(below) else below[i]
            for i in range(0, len(below), 2)
        ])
    return layers[-1][0], layers


def proof(layers: list[list[bytes]], index: int) -> list[bytes]:
    """Sibling hashes from a leaf to the root. A promoted node contributes none."""
    path: list[bytes] = []
    for layer in layers[:-1]:
        sibling = index ^ 1
        if sibling < len(layer):
            path.append(layer[sibling])
        index //= 2
    return path


# ─── Input ────────────────────────────────────────────────────────────────


def normalize(raw: str) -> str:
    """Lowercase 0x-prefixed address, or a hard failure.

    Checksum case is discarded on purpose: `abi.encode` sees bytes, so
    `0xAbC…` and `0xabc…` are the same leaf, and keeping both spellings in the
    list would silently produce a tree with a duplicate member.
    """
    address = raw.strip()
    if not address.startswith("0x") or len(address) != 42:
        raise SystemExit(f"not an address: {raw!r}")
    try:
        int(address, 16)
    except ValueError:
        raise SystemExit(f"not hex: {raw!r}") from None
    return address.lower()


def read_addresses(args: argparse.Namespace) -> list[str]:
    if args.addresses:
        raw = args.addresses.replace(",", "\n").splitlines()
    else:
        path = Path(args.input) if args.input else DEFAULT_INPUT
        if not path.exists():
            raise SystemExit(
                f"{path} not found. Write one address per line, or pass --addresses."
            )
        # `#` comments so the list can carry notes about who is on it and why.
        raw = [line.split("#")[0] for line in path.read_text().splitlines()]

    addresses: list[str] = []
    seen: set[str] = set()
    for line in raw:
        if not line.strip():
            continue
        address = normalize(line)
        # A duplicate is not an error worth failing on, but it must not become two
        # leaves: `wlClaimed` is per address, so the second one buys nothing and
        # only inflates the tree.
        if address in seen:
            print(f"  ! skipping duplicate {address}", file=sys.stderr)
            continue
        seen.add(address)
        addresses.append(address)

    if not addresses:
        raise SystemExit("no addresses")
    return addresses


# ─── Output ───────────────────────────────────────────────────────────────


def solidity_fixture(addresses: list[str], root: bytes, layers: list[list[bytes]]) -> str:
    """The vector `test/utils/MerkleProof.t.sol` pins its own tree against."""
    lines = [
        f"// {len(addresses)} members, generated by script/whitelist.py",
        f'bytes32 constant ROOT = 0x{root.hex()};',
        "",
    ]
    for i, address in enumerate(addresses):
        path = proof(layers, i)
        joined = ", ".join(f"0x{h.hex()}" for h in path)
        lines.append(f"// {address}  leaf 0x{leaf(address).hex()}")
        lines.append(f"// proof [{joined}]")
    return "\n".join(lines)


def _display(path: Path) -> str:
    """Repo-relative when it is in the repo, absolute when `--out` points elsewhere."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", help="file of addresses, one per line")
    parser.add_argument("--addresses", help="comma-separated addresses instead of a file")
    parser.add_argument("--out", help=f"where to write the proofs (default {DEFAULT_OUTPUT})")
    parser.add_argument("--solidity", action="store_true", help="print a Solidity fixture")
    args = parser.parse_args()

    addresses = read_addresses(args)
    root, layers = build(addresses)

    if args.solidity:
        print(solidity_fixture(addresses, root, layers))
        return 0

    entries = {
        address: ["0x" + h.hex() for h in proof(layers, i)]
        for i, address in enumerate(addresses)
    }

    # Self-check before anything is written: re-verify every proof the way the
    # contract will. A tree that fails here would be a root nobody can mint
    # against, discovered after `setMerkleRoot` rather than before it.
    for i, address in enumerate(addresses):
        computed = leaf(address)
        for sibling in proof(layers, i):
            computed = pair(computed, sibling)
        assert computed == root, f"proof does not verify for {address}"

    out = Path(args.out) if args.out else DEFAULT_OUTPUT
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {"root": "0x" + root.hex(), "members": len(addresses), "proofs": entries},
            indent=2,
        )
        + "\n"
    )

    print(f"members  {len(addresses)}")
    print(f"depth    {len(layers) - 1}")
    print(f"root     0x{root.hex()}")
    print(f"proofs   {_display(out)}")
    print()
    print("Next: owner calls setMerkleRoot(<root>) on UnderwaterPlates.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

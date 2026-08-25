#!/usr/bin/env python3
"""Applies the published allowlist selection criteria to a waitlist snapshot.

The criteria are in [ALLOWLIST.md](../ALLOWLIST.md) and this is the code for them.
Read that first — this file is deliberately not the specification, because a
procedure whose only statement is an implementation is a procedure nobody outside
the repo can check.

    npm run waitlist                       # → script/waitlist-snapshot.txt (intake)
    python script/select.py --seed 0x…     # → script/whitelist.txt (selection)
    python script/whitelist.py             # → web/public/whitelist.json (the tree)

Three rounds over one draw per address, all of it a function of the seed and public
chain state at the snapshot block:

  1. Divers — `getUserAccountData(a).totalDebtBase > 0` at block S. Up to 350.
  2. Crew   — a `Trade` from the launchpad with `trader == a`, at or before S.
              Fills whatever is left of the 350.
  3. Everyone else, including whoever rounds 1 and 2 did not reach, to 500.

`draw(a) = uint256(keccak256(abi.encode(seed, a)))`, lowest first, ties on the
address. One draw per address across all three rounds, so a Diver who misses the cut
falls back into round 3 with the same number and qualifying can never cost anybody a
spot.

Stdlib only, against the vendored `art/keccak.py`, for the same reason
`whitelist.py` is: this decides who gets a discounted plate, and nobody checking it
should have to install anything first. JSON-RPC is hand-rolled over urllib for that
reason too — the two calls it needs are a selector plus a padded address, and an
`eth_getLogs` topic filter.

Every read is pinned to the snapshot block, which is what makes the run
reproducible: the same snapshot and the same seed produce the same list forever,
including after the positions it graded have been closed.

Usage:
    python script/select.py --seed 0x<blockhash> --rpc https://rpc-gel.inkonchain.com
    python script/select.py --seed 0x… --snapshot-block 12345678
    python script/select.py --seed 0x… --no-tiers          # round 3 only
    python script/select.py --seed 0x… --dry-run           # print, write nothing
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "art"))

from keccak import keccak256  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SNAPSHOT = ROOT / "script" / "waitlist-snapshot.txt"
# The file `whitelist.py` reads by default, and the one the layout calls "the
# allowlist itself". Overwriting it is the point; it is in git, so the diff that
# lands when the list is drawn is the launch record.
DEFAULT_OUT = ROOT / "script" / "whitelist.txt"

# ─── The criteria's constants ─────────────────────────────────────────────
# All three come from ALLOWLIST.md and are duplicated here rather than derived,
# because a run that silently disagreed with the published document would be worse
# than one that failed. The self-check in `main` re-derives SPOTS from the pair the
# document justifies it from.

WL_ALLOCATION = 1000  # plates reserved for the allowlist phase (on chain)
MAX_PER_WALLET = 2  # allowlist plates per address at launch (on chain)
SPOTS = WL_ALLOCATION // MAX_PER_WALLET  # 500 addresses
PRIORITY_SPOTS = 350  # rounds 1 + 2 combined; the rest is the open lottery

TRADE_TOPIC = "0x" + keccak256(
    b"Trade(address,address,bool,uint256,uint256,uint256,uint128,uint128,uint128,uint256)"
).hex()

# Pool addresses, mirroring script/InkAave.sol. Same chain-id lookup for the same
# reason: this is not a value anybody should be retyping.
POOLS = {
    57073: "0x2816cf15f6d2a220e789aa011d5ee4eb6c47feba",
    763373: "0x6807dc923806fe8fd134338eabca509979a7e0cb",
}

RPCS = {
    57073: "https://rpc-gel.inkonchain.com",
    763373: "https://rpc-gel-sepolia.inkonchain.com",
}


# ─── The draw ─────────────────────────────────────────────────────────────

# Memoised because `draw` is pure and the vendored Keccak is pure Python: the
# self-test re-runs the rounds hundreds of times over the same addresses, and
# recomputing a value that cannot change would make it minutes instead of seconds.
_DRAWS: dict[tuple[bytes, str], int] = {}


def draw(seed: bytes, address: str) -> int:
    """uint256(keccak256(abi.encode(seed, a))) — 32 bytes of seed, then the address
    left-padded to 32. The encoding rule is MerkleProof.sol's, so there is one to
    get right in this repo and not two."""
    key = (seed, address)
    cached = _DRAWS.get(key)
    if cached is None:
        word = bytes(12) + bytes.fromhex(address[2:])
        cached = int.from_bytes(keccak256(seed + word), "big")
        _DRAWS[key] = cached
    return cached


# ─── Chain reads ──────────────────────────────────────────────────────────


class Rpc:
    """The three JSON-RPC methods this needs, and nothing else."""

    def __init__(self, url: str):
        self.url = url
        self._id = 0

    def call(self, method: str, params: list) -> object:
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        request = urllib.request.Request(
            self.url, data=body.encode(), headers={"content-type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.load(response)
        except urllib.error.URLError as err:
            raise SystemExit(f"{method} failed: {err}") from None
        if "error" in payload:
            raise SystemExit(f"{method} failed: {payload['error'].get('message', payload['error'])}")
        return payload["result"]

    def chain_id(self) -> int:
        return int(self.call("eth_chainId", []), 16)

    def block_number(self) -> int:
        return int(self.call("eth_blockNumber", []), 16)

    def total_debt_base(self, pool: str, who: str, block: int) -> int:
        """Word 1 of `getUserAccountData` — (collateral, DEBT, borrows, threshold,
        ltv, healthFactor). Reverts are fatal rather than treated as no debt: a pool
        that will not answer means the tier cannot be graded, and grading everybody
        as unqualified is a silent wrong answer."""
        selector = keccak256(b"getUserAccountData(address)")[:4].hex()
        data = "0x" + selector + "00" * 12 + who[2:]
        raw = self.call("eth_call", [{"to": pool, "data": data}, hex(block)])
        words = bytes.fromhex(raw[2:])
        if len(words) < 192:
            raise SystemExit(f"getUserAccountData({who}) returned {len(words)} bytes, expected 192")
        return int.from_bytes(words[32:64], "big")

    def traders(self, launchpad: str, from_block: int, to_block: int, page: int) -> set[str]:
        """Every distinct `trader` in a `Trade` log up to `to_block`.

        Paged because public endpoints cap the range, and every page is required to
        come back — a range that quietly returned nothing would drop real members of
        the Crew tier, which is the failure mode that looks like success.
        """
        found: set[str] = set()
        start = from_block
        while start <= to_block:
            end = min(start + page - 1, to_block)
            logs = self.call(
                "eth_getLogs",
                [
                    {
                        "address": launchpad,
                        "fromBlock": hex(start),
                        "toBlock": hex(end),
                        "topics": [TRADE_TOPIC],
                    }
                ],
            )
            for entry in logs:
                # topic2 is `trader`; topic1 is `token`.
                found.add("0x" + entry["topics"][2][-40:].lower())
            sys.stderr.write(f"\r  scanning   {end - from_block + 1}/{to_block - from_block + 1} blocks")
            start = end + 1
        sys.stderr.write("\n")
        return found


# ─── Input ────────────────────────────────────────────────────────────────


def read_snapshot(path: Path) -> list[str]:
    """Addresses in registration order, `#` comments stripped.

    Order is preserved and reported, because the snapshot's positions are the
    receipts registrants were given — but it is not an input to any round.
    """
    if not path.exists():
        raise SystemExit(f"{path} not found. Run `npm run waitlist` first.")

    addresses: list[str] = []
    seen: set[str] = set()
    for line in path.read_text().splitlines():
        text = line.split("#")[0].strip()
        if not text:
            continue
        if not text.startswith("0x") or len(text) != 42:
            raise SystemExit(f"not an address: {text!r}")
        try:
            int(text, 16)
        except ValueError:
            raise SystemExit(f"not hex: {text!r}") from None
        address = text.lower()
        # The contract makes this impossible, so it means the snapshot was edited.
        # Failing rather than skipping: a hand-edited intake file is not intake.
        if address in seen:
            raise SystemExit(f"duplicate in the snapshot: {address}")
        seen.add(address)
        addresses.append(address)

    if not addresses:
        raise SystemExit("no addresses in the snapshot")
    return addresses


def read_seed(raw: str) -> bytes:
    if not raw.startswith("0x") or len(raw) != 66:
        raise SystemExit(f"--seed must be a 32-byte hex block hash, got {raw!r}")
    try:
        return bytes.fromhex(raw[2:])
    except ValueError:
        raise SystemExit(f"--seed is not hex: {raw!r}") from None


# ─── The rounds ───────────────────────────────────────────────────────────


def select(
    addresses: list[str], seed: bytes, divers: set[str], crew: set[str]
) -> tuple[list[str], dict[str, tuple[int, str, int]]]:
    """Returns the selected addresses and, for every registrant, its
    (draw, tier, round) — where round 0 means it was not selected.

    The rounds are sequential rather than a single weighted sort, because that is
    what makes the two properties in ALLOWLIST.md checkable by hand: unused priority
    spots roll into round 3, and an unselected Diver re-enters round 3 carrying the
    same draw it had in round 1.
    """
    draws = {a: draw(seed, a) for a in addresses}
    tier = {a: "diver" if a in divers else "crew" if a in crew else "open" for a in addresses}

    def by_draw(pool: list[str]) -> list[str]:
        # Ties on the address, so the order is total. At 256 bits this branch is
        # unreachable in practice and still has to exist.
        return sorted(pool, key=lambda a: (draws[a], a))

    picked: list[str] = []
    chosen_in: dict[str, int] = {}

    def take(pool: list[str], limit: int, number: int) -> None:
        for a in by_draw(pool):
            if len(picked) >= limit:
                return
            if a in chosen_in:
                continue
            picked.append(a)
            chosen_in[a] = number

    take([a for a in addresses if tier[a] == "diver"], PRIORITY_SPOTS, 1)
    take([a for a in addresses if tier[a] == "crew"], PRIORITY_SPOTS, 2)
    take(addresses, SPOTS, 3)

    workings = {a: (draws[a], tier[a], chosen_in.get(a, 0)) for a in addresses}
    return picked, workings


# ─── Self-test ────────────────────────────────────────────────────────────


def self_test() -> int:
    """The properties ALLOWLIST.md claims, checked rather than asserted in prose.

    Here rather than in a test directory because this file is the only Python in the
    repo that decides anything, and a reader who wants to know whether the rounds do
    what the document says should be able to run the same file.
    """
    import random

    seed = bytes(range(32))
    addresses = [f"0x{i:040x}" for i in range(1, 901)]
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        mark = "ok  " if ok else "FAIL"
        print(f"  {mark}  {name}{('  ' + detail) if detail else ''}")

    def rounds(picked: list[str], workings: dict) -> dict[int, int]:
        counted = {1: 0, 2: 0, 3: 0}
        for _, _, number in workings.values():
            if number:
                counted[number] += 1
        return counted

    # The list is exactly SPOTS long, with no repeats, whenever there are enough
    # registrants — the property a wrong `take` bound would break.
    picked, workings = select(addresses, seed, set(addresses[:600]), set())
    counted = rounds(picked, workings)
    check("fills exactly the spots available", len(picked) == SPOTS, f"{len(picked)}")
    check("selects nobody twice", len(set(picked)) == len(picked))
    check(
        "priority rounds cannot exceed their cap",
        counted[1] + counted[2] == PRIORITY_SPOTS,
        f"{counted[1]}+{counted[2]}",
    )
    check("the open round always gets the rest", counted[3] == SPOTS - PRIORITY_SPOTS, f"{counted[3]}")

    # Unused priority spots roll into round 3 rather than shrinking the list.
    _, workings = select(addresses, seed, set(addresses[:10]), set(addresses[10:40]))
    counted = rounds([], workings)
    check(
        "unused priority spots roll into the open round",
        counted == {1: 10, 2: 30, 3: SPOTS - 40},
        str(counted),
    )

    # Round 2 gets only what round 1 left of the shared 350.
    _, workings = select(addresses, seed, set(addresses[:100]), set(addresses[100:800]))
    counted = rounds([], workings)
    check(
        "round 2 fills what round 1 left of the shared cap",
        counted[1] == 100 and counted[2] == PRIORITY_SPOTS - 100,
        str(counted),
    )

    # Rule 1: fewer registrants than spots means everybody, whatever the tiers.
    short = addresses[: SPOTS - 100]
    picked, _ = select(short, seed, set(short[:5]), set(short[5:9]))
    check("under the cap, everybody is selected", len(picked) == len(short), f"{len(picked)}")

    # The headline fairness property: for one address, holding every other input
    # fixed, being in a better tier is never worse. 300 randomised splits.
    random.seed(7)
    hurt = 0
    for _ in range(300):
        divers = set(random.sample(addresses, random.randint(0, 700)))
        rest = [a for a in addresses if a not in divers]
        crew = set(random.sample(rest, random.randint(0, min(300, len(rest)))))
        who = random.choice(addresses)
        base_d, base_c = divers - {who}, crew - {who}
        got = lambda w: w[who][2] != 0  # noqa: E731
        _, as_open = select(addresses, seed, base_d, base_c)
        _, as_crew = select(addresses, seed, base_d, base_c | {who})
        _, as_diver = select(addresses, seed, base_d | {who}, base_c)
        hurt += (
            (got(as_open) and not got(as_crew))
            + (got(as_crew) and not got(as_diver))
            + (got(as_open) and not got(as_diver))
        )
    check("qualifying for a tier is never worse than not", hurt == 0, f"{hurt} cases")

    # Determinism, which is the whole basis of "rebuild it yourself".
    first, _ = select(addresses, seed, set(addresses[:300]), set(addresses[300:400]))
    again, _ = select(addresses, seed, set(addresses[:300]), set(addresses[300:400]))
    check("the same inputs produce the same list", first == again)

    # A different seed must produce a different list, or the lottery is not one.
    other, _ = select(addresses, bytes(31) + b"\x01", set(addresses[:300]), set(addresses[300:400]))
    check("a different seed produces a different list", other != first)

    print("")
    print("  all properties hold" if failures == 0 else f"  {failures} FAILED")
    return 1 if failures else 0


# ─── Output ───────────────────────────────────────────────────────────────


def _display(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", help=f"intake file (default {_display(DEFAULT_SNAPSHOT)})")
    parser.add_argument("--seed", help="hash of the first block at or after closesAt")
    parser.add_argument("--snapshot", help="same as the positional argument")
    parser.add_argument("--rpc", help="Ink RPC; defaults by --chain-id")
    parser.add_argument("--chain-id", type=int, help="only needed without --rpc")
    parser.add_argument("--snapshot-block", type=int, help="block S; default: chain head")
    parser.add_argument("--pool", help="Aave pool; defaults to script/InkAave.sol's")
    parser.add_argument("--launchpad", help="UnderwaterLaunchpad, for the Crew tier")
    parser.add_argument("--from-block", type=int, default=0, help="launchpad deploy block")
    parser.add_argument("--log-page", type=int, default=50_000, help="blocks per eth_getLogs")
    parser.add_argument("--no-tiers", action="store_true", help="skip rounds 1 and 2 entirely")
    parser.add_argument("--out", help=f"where to write the list (default {_display(DEFAULT_OUT)})")
    parser.add_argument("--dry-run", action="store_true", help="print the workings, write nothing")
    parser.add_argument("--self-test", action="store_true", help="check ALLOWLIST.md's properties")
    args = parser.parse_args()

    # The published number, re-derived from the two on-chain values it comes from
    # rather than trusted as a literal.
    assert SPOTS == 500, "SPOTS must be WL_ALLOCATION / MAX_PER_WALLET"
    assert PRIORITY_SPOTS < SPOTS, "the open round must always have spots"

    if args.self_test:
        return self_test()
    if not args.seed:
        raise SystemExit("--seed is required (the hash of the first block at or after closesAt)")

    seed = read_seed(args.seed)
    snapshot = Path(args.input or args.snapshot) if (args.input or args.snapshot) else DEFAULT_SNAPSHOT
    addresses = read_snapshot(snapshot)

    print("")
    print(f"  snapshot     {_display(snapshot)}")
    print(f"  registrants  {len(addresses)}")
    print(f"  seed         0x{seed.hex()}")
    print(f"  spots        {SPOTS}  ({WL_ALLOCATION} plates / {MAX_PER_WALLET} per address)")

    # Rule 1. Announced before any chain read, because with the list this short the
    # tiers cannot change the outcome and grading people for nothing would only
    # invite an argument about the grades.
    if len(addresses) <= SPOTS:
        print("")
        print(f"  {len(addresses)} registrants for {SPOTS} spots — rule 1: everybody is on the list.")
        print("  No rounds, no tiers, no lottery. The seed is recorded and unused.")
        divers: set[str] = set()
        crew: set[str] = set()
    elif args.no_tiers:
        print("")
        print("  --no-tiers: rounds 1 and 2 skipped, the whole list drawn in round 3.")
        print("  This is NOT the published procedure. Use it to rehearse, never to launch.")
        divers, crew = set(), set()
    else:
        chain_id = args.chain_id
        rpc_url = args.rpc or (RPCS.get(chain_id) if chain_id else None)
        if not rpc_url:
            raise SystemExit("more than 500 registrants: pass --rpc (or --chain-id) to grade the tiers")

        rpc = Rpc(rpc_url)
        chain_id = rpc.chain_id()
        block = args.snapshot_block if args.snapshot_block is not None else rpc.block_number()
        pool = (args.pool or POOLS.get(chain_id, "")).lower()
        if not pool:
            raise SystemExit(f"no known Aave pool for chain {chain_id} — pass --pool")

        print(f"  rpc          {rpc_url}  (chain {chain_id})")
        print(f"  block S      {block}")
        print(f"  pool         {pool}")
        if args.snapshot_block is None:
            print("  ! block S defaulted to the chain head, not the waitlist's deploy block")

        divers = set()
        for i, a in enumerate(addresses, 1):
            if rpc.total_debt_base(pool, a, block) > 0:
                divers.add(a)
            sys.stderr.write(f"\r  grading    {i}/{len(addresses)}")
        sys.stderr.write("\n")

        crew = set()
        if args.launchpad:
            print(f"  launchpad    {args.launchpad.lower()}")
            traders = rpc.traders(args.launchpad.lower(), args.from_block, block, args.log_page)
            crew = {a for a in addresses if a in traders and a not in divers}
        else:
            print("  ! no --launchpad: round 2 (Crew) graded as empty, its spots roll to round 3")

    picked, workings = select(addresses, seed, divers, crew)

    # ─── The workings ─────────────────────────────────────────────────────
    # Printed in full, always. The point of a published procedure is that a
    # disagreement about the result can be pinned to one line of it.

    counts = {1: 0, 2: 0, 3: 0}
    for _, _, number in workings.values():
        if number:
            counts[number] += 1

    print("")
    print(f"  round 1  divers  {counts[1]:>4} of {sum(1 for _, t, _ in workings.values() if t == 'diver')}"
          f"  (cap {PRIORITY_SPOTS})")
    print(f"  round 2  crew    {counts[2]:>4} of {sum(1 for _, t, _ in workings.values() if t == 'crew')}"
          f"  (cap {PRIORITY_SPOTS} shared with round 1)")
    print(f"  round 3  open    {counts[3]:>4}  (to {SPOTS})")
    print(f"  selected         {len(picked):>4} of {len(addresses)}")
    print("")

    lines = [
        "# The allowlist. Written by script/select.py under the criteria in ALLOWLIST.md.",
        "#",
        f"# {len(picked)} of {len(addresses)} registrants · {SPOTS} spots"
        f" · {WL_ALLOCATION} plates at {MAX_PER_WALLET} per address",
        f"# seed 0x{seed.hex()}",
        f"# rounds: {counts[1]} divers, {counts[2]} crew, {counts[3]} open",
        "#",
        "# Rebuild: see the Rebuilding the result section of ALLOWLIST.md. Every line",
        "# below is a function of the seed above and public chain state — nothing here",
        "# was decided by hand.",
        "#",
        "# Next: python script/whitelist.py script/whitelist.txt",
        "",
    ]
    order = {a: i for i, a in enumerate(addresses, 1)}
    for a in picked:
        d, t, number = workings[a]
        lines.append(f"{a}  # round {number} {t:<5} registered #{order[a]} draw 0x{d:064x}")

    # And the ones who did not make it, as comments in the same file, so the
    # published list carries its own negative space rather than requiring the
    # snapshot alongside it to see who was considered.
    missed = [a for a in addresses if workings[a][2] == 0]
    if missed:
        lines.append("")
        lines.append(f"# Not selected ({len(missed)}). Kept here as a record, commented out:")
        for a in sorted(missed, key=lambda x: workings[x][0]):
            d, t, _ = workings[a]
            lines.append(f"# {a}  {t:<5} registered #{order[a]} draw 0x{d:064x}")

    if args.dry_run:
        print("\n".join(lines))
        print("")
        print("  --dry-run: nothing written")
        return 0

    out = Path(args.out) if args.out else DEFAULT_OUT
    if out.exists():
        print(f"  overwriting {_display(out)}")
    out.write_text("\n".join(lines) + "\n")
    print(f"  wrote {_display(out)}")
    print("")
    print(f"  next  python script/whitelist.py {_display(out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Applies the published allowlist selection criteria to a waitlist snapshot.

The criteria are in [ALLOWLIST.md](../ALLOWLIST.md) and this is the code for them.
Read that first — this file is deliberately not the specification, because a
procedure whose only statement is an implementation is a procedure nobody outside
the repo can check.

    npm run waitlist                       # → script/waitlist-snapshot.txt (intake)
    python script/select.py --seed 0x…     # → script/whitelist.txt (selection)
    python script/whitelist.py             # → web/public/whitelist.json (the tree)

The rank is qualified referrals; the tiebreak is one draw per address. Both are a
function of the seed and public chain state at the snapshot block:

  * score(a) = how many addresses `a` referred that were *real* at block S — an
    account that had transacted (nonce > 0), or carried Aave debt, or had traded the
    launchpad. The referral edges come from the snapshot; qualification is read from
    the chain, pinned to S.
  * draw(a) = uint256(keccak256(abi.encode(seed, a))). Lowest first, ties on the
    address.

Order by score descending, then draw ascending. The top SPOTS win. An address that
referred nobody has score 0 and competes in the tail on its draw alone, so every spot
the ranked do not fill is a plain lottery — which is most of them, because most people
refer no one.

Stdlib only, against the vendored `art/keccak.py`, for the same reason
`whitelist.py` is: this decides who gets a discounted plate, and nobody checking it
should have to install anything first. JSON-RPC is hand-rolled over urllib for that
reason too — the calls it needs are a selector plus a padded address, an
`eth_getLogs` topic filter, and `eth_getTransactionCount`.

Every read is pinned to the snapshot block, which is what makes the run
reproducible: the same snapshot and the same seed produce the same list forever,
including after the positions it graded have been closed.

Usage:
    python script/select.py --seed 0x<blockhash> --rpc https://rpc-gel.inkonchain.com
    python script/select.py --seed 0x… --snapshot-block 12345678
    python script/select.py --seed 0x… --launchpad 0x…   # grade the trade signal too
    python script/select.py --seed 0x… --no-referrals     # pure lottery, no ranking
    python script/select.py --seed 0x… --dry-run          # print, write nothing
"""

from __future__ import annotations

import argparse
import json
import re
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
# Both come from ALLOWLIST.md and are duplicated here rather than derived, because a
# run that silently disagreed with the published document would be worse than one
# that failed. The self-check in `main` re-derives SPOTS from the pair the document
# justifies it from, and both are on chain: WL_ALLOCATION is a `constant` on
# UnderwaterPlates and maxPerWallet is what the mint page reads off the collection.

WL_ALLOCATION = 2000  # plates reserved for the allowlist phase (on chain, a constant)
MAX_PER_WALLET = 1  # allowlist plates per address at launch (on chain, settable)
SPOTS = WL_ALLOCATION // MAX_PER_WALLET  # 2000 addresses

TRADE_TOPIC = "0x" + keccak256(
    b"Trade(address,address,bool,uint256,uint256,uint256,uint128,uint128,uint128,uint256)"
).hex()

# Matches a referrer attribution in a snapshot comment: `ref=0x<40 hex>`. Written by
# web/scripts/waitlist.mjs, absent when a registration named no referrer.
REF_RE = re.compile(r"ref=(0x[0-9a-fA-F]{40})")

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
# self-test re-runs the ranking hundreds of times over the same addresses, and
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
    """The JSON-RPC methods this needs, and nothing else."""

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

    def nonce(self, who: str, block: int) -> int:
        """`eth_getTransactionCount` at block S. For an EOA this is the whole
        qualification test — an account cannot have borrowed or traded without first
        sending a transaction. It reads zero for a smart-contract wallet that only
        ever receives calls, which is what the Aave and trade signals are for."""
        return int(self.call("eth_getTransactionCount", [who, hex(block)]), 16)

    def total_debt_base(self, pool: str, who: str, block: int) -> int:
        """Word 1 of `getUserAccountData` — (collateral, DEBT, borrows, threshold,
        ltv, healthFactor). Reverts are fatal rather than treated as no debt: a pool
        that will not answer means the signal cannot be graded, and grading everybody
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
        come back — a range that quietly returned nothing would drop real traders,
        which is the failure mode that looks like success.
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


def read_snapshot(path: Path) -> tuple[list[str], dict[str, str]]:
    """Addresses in registration order, and the referrer of each that named one.

    Order is preserved and reported, because the snapshot's positions are the
    receipts registrants were given — but it is not an input to the score or the draw.
    The referrer *is* an input: it is what the ranking is built from, so a referrer
    that is not itself a registrant fails the read rather than being dropped, the same
    way a duplicate does. The contract makes both impossible, so either means the
    snapshot was edited, and a hand-edited intake file is not intake.
    """
    if not path.exists():
        raise SystemExit(f"{path} not found. Run `npm run waitlist` first.")

    addresses: list[str] = []
    seen: set[str] = set()
    referrer: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        code = line.split("#")[0].strip()
        if not code:
            continue
        if not code.startswith("0x") or len(code) != 42:
            raise SystemExit(f"not an address: {code!r}")
        try:
            int(code, 16)
        except ValueError:
            raise SystemExit(f"not hex: {code!r}") from None
        address = code.lower()
        if address in seen:
            raise SystemExit(f"duplicate in the snapshot: {address}")
        seen.add(address)
        addresses.append(address)

        # The referrer travels in the comment as `ref=0x…`. It is validated against
        # the address set below, once the whole list is known.
        match = REF_RE.search(line)
        if match:
            referrer[address] = match.group(1).lower()

    if not addresses:
        raise SystemExit("no addresses in the snapshot")

    for referee, ref in referrer.items():
        if ref == referee:
            raise SystemExit(f"{referee} is its own referrer — the contract forbids this")
        if ref not in seen:
            raise SystemExit(f"{referee} was referred by {ref}, which is not in the snapshot")

    return addresses, referrer


def read_seed(raw: str) -> bytes:
    if not raw.startswith("0x") or len(raw) != 66:
        raise SystemExit(f"--seed must be a 32-byte hex block hash, got {raw!r}")
    try:
        return bytes.fromhex(raw[2:])
    except ValueError:
        raise SystemExit(f"--seed is not hex: {raw!r}") from None


# ─── The ranking ──────────────────────────────────────────────────────────


def score_of(
    addresses: list[str], referrer: dict[str, str], qualified: set[str]
) -> dict[str, int]:
    """For each address, how many of the wallets it referred were qualified at S.

    Only qualified referees count. A referral from a wallet that was not real at the
    snapshot block adds nothing — which is the whole reason ranking on referrals does
    not simply pay a farm for gas.
    """
    score = {a: 0 for a in addresses}
    for referee, ref in referrer.items():
        if referee in qualified:
            # `ref` is always a registrant: read_snapshot has already checked it is in
            # the list, and the contract requires a referrer to have registered first.
            score[ref] += 1
    return score


def select(
    addresses: list[str], seed: bytes, referrer: dict[str, str], qualified: set[str]
) -> tuple[list[str], dict[str, tuple[int, int, int]]]:
    """Returns the selected addresses and, for every registrant, its
    (draw, score, rank) — where rank is its 1-based place in the full order.

    One total order over everybody: score descending, then draw ascending, then the
    address. The top SPOTS are taken. With SPOTS or fewer registrants the whole list
    is taken and the order only decides the printout — that is Rule 1, and it needs no
    special case here because it is the same slice.
    """
    draws = {a: draw(seed, a) for a in addresses}
    score = score_of(addresses, referrer, qualified)

    order = sorted(addresses, key=lambda a: (-score[a], draws[a], a))
    rank = {a: i + 1 for i, a in enumerate(order)}
    picked = order[:SPOTS]

    workings = {a: (draws[a], score[a], rank[a]) for a in addresses}
    return picked, workings


# ─── Self-test ────────────────────────────────────────────────────────────


def self_test() -> int:
    """The properties ALLOWLIST.md claims, checked rather than asserted in prose.

    Here rather than in a test directory because this file is the only Python in the
    repo that decides anything, and a reader who wants to know whether the ranking
    does what the document says should be able to run the same file.
    """
    import random

    seed = bytes(range(32))
    addresses = [f"0x{i:040x}" for i in range(1, SPOTS + 501)]  # 500 more than fit
    picked_set = lambda p: set(p)  # noqa: E731
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        if not ok:
            failures += 1
        mark = "ok  " if ok else "FAIL"
        print(f"  {mark}  {name}{('  ' + detail) if detail else ''}")

    # The list is exactly SPOTS long, with no repeats, whenever there are more
    # registrants than spots — the property a wrong slice bound would break.
    picked, _ = select(addresses, seed, {}, set())
    check("fills exactly the spots available", len(picked) == SPOTS, f"{len(picked)}")
    check("selects nobody twice", len(set(picked)) == len(picked))

    # Rule 1: fewer registrants than spots means everybody, whatever the referrals.
    short = addresses[: SPOTS - 100]
    ref = {short[1]: short[0], short[2]: short[0]}
    picked, _ = select(short, seed, ref, {short[1], short[2]})
    check("under the cap, everybody is selected", len(picked) == len(short), f"{len(picked)}")

    # The headline fairness property: gaining a qualified referral, with every other
    # input held fixed, is never worse. 200 randomised graphs. Adding a referee to the
    # qualified set raises exactly one referrer's score by one; the referrer must not
    # fall out of the list as a result.
    random.seed(7)
    hurt = 0
    for _ in range(200):
        # A random referral graph: some referees, each pointing at an earlier address.
        referrer: dict[str, str] = {}
        for referee in random.sample(addresses, random.randint(0, 600)):
            ref_of = random.choice(addresses)
            if ref_of != referee:
                referrer[referee] = ref_of
        referees = list(referrer)
        base_qualified = set(random.sample(referees, len(referees) // 2)) if referees else set()

        # Take one referee currently unqualified and qualify it — its referrer's score
        # rises by one. That referrer must not go from selected to unselected.
        candidates = [b for b in referees if b not in base_qualified]
        if not candidates:
            continue
        gained = random.choice(candidates)
        who = referrer[gained]

        before, _ = select(addresses, seed, referrer, base_qualified)
        after, _ = select(addresses, seed, referrer, base_qualified | {gained})
        if who in picked_set(before) and who not in picked_set(after):
            hurt += 1
    check("gaining a qualified referral is never worse", hurt == 0, f"{hurt} cases")

    # An unqualified referral changes nothing: the referrer's score is untouched, so
    # the whole selection is identical. This is the anti-sybil property in miniature.
    referrer = {addresses[10]: addresses[0], addresses[11]: addresses[0]}
    with_unqualified, _ = select(addresses, seed, referrer, set())
    without_any, _ = select(addresses, seed, {}, set())
    check(
        "an unqualified referral does not change the list",
        with_unqualified == without_any,
    )

    # The frontier is monotone in score: no unselected address outscores a selected
    # one. If it did, the sort key would be wrong.
    referrer = {}
    for referee in random.sample(addresses, 800):
        r = random.choice(addresses)
        if r != referee:
            referrer[referee] = r
    qualified = set(random.sample(list(referrer), len(referrer) // 2)) if referrer else set()
    picked, workings = select(addresses, seed, referrer, qualified)
    picked_scores = [workings[a][1] for a in picked]
    missed_scores = [workings[a][1] for a in addresses if workings[a][2] > SPOTS]
    check(
        "no missed address outscores a selected one",
        (min(picked_scores) if picked_scores else 0) >= (max(missed_scores) if missed_scores else 0),
        f"min selected {min(picked_scores) if picked_scores else 0}"
        f" >= max missed {max(missed_scores) if missed_scores else 0}",
    )

    # Determinism, which is the whole basis of "rebuild it yourself".
    first, _ = select(addresses, seed, referrer, qualified)
    again, _ = select(addresses, seed, referrer, qualified)
    check("the same inputs produce the same list", first == again)

    # A different seed must produce a different list, or the tail lottery is not one.
    # The tail is where the seed bites — with no referrals at all it decides the whole
    # list, so that is the regime to check it in.
    other, _ = select(addresses, bytes(31) + b"\x01", {}, set())
    plain, _ = select(addresses, seed, {}, set())
    check("a different seed produces a different list", other != plain)

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
    parser.add_argument("--launchpad", help="UnderwaterLaunchpad, for the trade signal")
    parser.add_argument("--from-block", type=int, default=0, help="launchpad deploy block")
    parser.add_argument("--log-page", type=int, default=50_000, help="blocks per eth_getLogs")
    parser.add_argument("--no-referrals", action="store_true", help="pure lottery, no ranking")
    parser.add_argument("--out", help=f"where to write the list (default {_display(DEFAULT_OUT)})")
    parser.add_argument("--dry-run", action="store_true", help="print the workings, write nothing")
    parser.add_argument("--self-test", action="store_true", help="check ALLOWLIST.md's properties")
    args = parser.parse_args()

    # The published number, re-derived from the two on-chain values it comes from
    # rather than trusted as a literal.
    assert SPOTS == WL_ALLOCATION // MAX_PER_WALLET, "SPOTS must be WL_ALLOCATION / MAX_PER_WALLET"
    assert SPOTS == 2000, "ALLOWLIST.md publishes 2000 spots"

    if args.self_test:
        return self_test()
    if not args.seed:
        raise SystemExit("--seed is required (the hash of the first block at or after closesAt)")

    seed = read_seed(args.seed)
    snapshot = Path(args.input or args.snapshot) if (args.input or args.snapshot) else DEFAULT_SNAPSHOT
    addresses, referrer = read_snapshot(snapshot)

    print("")
    print(f"  snapshot     {_display(snapshot)}")
    print(f"  registrants  {len(addresses)}")
    print(f"  with a ref   {len(referrer)}")
    print(f"  seed         0x{seed.hex()}")
    print(f"  spots        {SPOTS}  ({WL_ALLOCATION} plates / {MAX_PER_WALLET} per address)")

    qualified: set[str] = set()

    # Rule 1. Announced before any chain read, because with the list this short the
    # ranking cannot change the outcome and grading people for nothing would only
    # invite an argument about the grades.
    if len(addresses) <= SPOTS:
        print("")
        print(f"  {len(addresses)} registrants for {SPOTS} spots — rule 1: everybody is on the list.")
        print("  No ranking, no lottery. The seed is recorded and used only to order the file.")
    elif args.no_referrals:
        print("")
        print("  --no-referrals: the whole list drawn on the seed alone, no ranking.")
        print("  This is NOT the published procedure. Use it to rehearse, never to launch.")
    else:
        # Only referees can score anyone a spot, so only they need grading. Grading the
        # whole list would be the same answer at many times the RPC calls.
        referees = sorted({b for b in referrer})
        if not referees:
            print("")
            print("  no referrals in this snapshot — the list is a pure draw, same as --no-referrals")
        else:
            chain_id = args.chain_id
            rpc_url = args.rpc or (RPCS.get(chain_id) if chain_id else None)
            if not rpc_url:
                raise SystemExit("more than 2000 registrants with referrals: pass --rpc (or --chain-id) to grade them")

            rpc = Rpc(rpc_url)
            chain_id = rpc.chain_id()
            block = args.snapshot_block if args.snapshot_block is not None else rpc.block_number()
            pool = (args.pool or POOLS.get(chain_id, "")).lower()
            if not pool:
                raise SystemExit(f"no known Aave pool for chain {chain_id} — pass --pool")

            print(f"  rpc          {rpc_url}  (chain {chain_id})")
            print(f"  block S      {block}")
            print(f"  pool         {pool}")
            print(f"  grading      {len(referees)} referred wallets")
            if args.snapshot_block is None:
                print("  ! block S defaulted to the chain head, not the waitlist's deploy block")

            # Signal 3, one log scan for all of them, before the per-address reads.
            traders: set[str] = set()
            if args.launchpad:
                print(f"  launchpad    {args.launchpad.lower()}")
                traders = rpc.traders(args.launchpad.lower(), args.from_block, block, args.log_page)
            else:
                print("  ! no --launchpad: the trade signal is skipped (nonce and Aave still count)")

            # Signals 1 and 2, per referred wallet.
            for i, b in enumerate(referees, 1):
                if b in traders or rpc.nonce(b, block) > 0 or rpc.total_debt_base(pool, b, block) > 0:
                    qualified.add(b)
                sys.stderr.write(f"\r  grading    {i}/{len(referees)}")
            sys.stderr.write("\n")

    picked, workings = select(addresses, seed, referrer, qualified)

    # ─── The workings ─────────────────────────────────────────────────────
    # Printed in full, always. The point of a published procedure is that a
    # disagreement about the result can be pinned to one line of it.

    scored = sum(1 for a in addresses if workings[a][1] > 0)
    top_score = max((workings[a][1] for a in addresses), default=0)
    by_score = sum(1 for a in picked if workings[a][1] > 0)
    by_draw = len(picked) - by_score

    print("")
    print(f"  referrers        {scored:>5}  (addresses with at least one qualified referral)")
    print(f"  top score        {top_score:>5}  qualified referrals")
    print(f"  selected on rank {by_score:>5}  (score > 0)")
    print(f"  selected on draw {by_draw:>5}  (the tail lottery)")
    print(f"  selected         {len(picked):>5} of {len(addresses)}")
    print("")

    lines = [
        "# The allowlist. Written by script/select.py under the criteria in ALLOWLIST.md.",
        "#",
        f"# {len(picked)} of {len(addresses)} registrants · {SPOTS} spots"
        f" · {WL_ALLOCATION} plates at {MAX_PER_WALLET} per address",
        f"# seed 0x{seed.hex()}",
        f"# {by_score} selected on referral rank, {by_draw} on the tail draw",
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
        d, s, rank = workings[a]
        lines.append(
            f"{a}  # rank {rank} score {s} registered #{order[a]} draw 0x{d:064x}"
        )

    # And the ones who did not make it, as comments in the same file, so the published
    # list carries its own negative space rather than requiring the snapshot alongside
    # it to see who was considered. Ordered by rank, so the near-misses read first.
    missed = [a for a in addresses if workings[a][2] > SPOTS]
    if missed:
        lines.append("")
        lines.append(f"# Not selected ({len(missed)}). Kept here as a record, commented out:")
        for a in sorted(missed, key=lambda x: workings[x][2]):
            d, s, rank = workings[a]
            lines.append(f"# {a}  rank {rank} score {s} registered #{order[a]} draw 0x{d:064x}")

    if args.dry_run:
        print("\n".join(lines))
        print("")
        print("  --dry-run: nothing written")
        return 0

    out = Path(args.out) if args.out else DEFAULT_OUT
    if out.exists():
        print(f"  overwriting {_display(out)}")
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  wrote {_display(out)}")
    print("")
    print(f"  next  python script/whitelist.py {_display(out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

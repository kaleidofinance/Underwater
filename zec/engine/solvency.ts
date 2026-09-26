/**
 * Proof of liabilities: a Merkle-sum tree over everything the protocol owes.
 *
 * Each leaf is one claim on the reserves: a user's balance (including their
 * withdrawals still in flight), plus three aggregates that belong to no single
 * user: ZEC on bonding curves, ZEC in pools, and protocol fees. Every node
 * commits to its children's hashes *and* sums, so the root's sum is the total
 * owed. A user can check their own leaf against the published root without
 * trusting anything, and nobody can shrink the total without breaking a hash.
 *
 * Solvency is then two public numbers: the root sum (this file) and the
 * reserve balance on-chain, viewable with the published viewing key. The
 * first must never exceed the second.
 *
 * The snapshot label (command count and hash-chain head) is hashed into every
 * leaf, so a proof is bound to one exact point in the engine's history.
 */
import { createHash } from "node:crypto";
import { CHAIN, FEES, LOSS, PENDING_WITHDRAWALS, type Engine } from "./engine.ts";
import { fail } from "./errors.ts";
import { QUOTE } from "./ledger.ts";

export interface SumNode {
  readonly hash: string;
  readonly sum: bigint;
}

export interface ProofStep extends SumNode {
  /** Which side the sibling sits on. */
  readonly side: "left" | "right";
}

export interface InclusionProof {
  readonly snapshot: string;
  readonly leaf: { readonly id: string; readonly amount: bigint };
  readonly path: readonly ProofStep[];
  readonly root: SumNode;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export const leafHash = (snapshot: string, id: string, amount: bigint): string =>
  sha(`uwzec:liability:v1|${snapshot}|${id}|${amount}`);

export const nodeHash = (l: SumNode, r: SumNode): string => sha(`uwzec:node:v1|${l.hash}|${l.sum}|${r.hash}|${r.sum}`);

/** Pads odd levels. Its zero sum means padding can never hide or invent a liability. */
export const EMPTY: SumNode = Object.freeze({ hash: sha("uwzec:empty:v1"), sum: 0n });

/** Leaf ids for claims that aren't one user's. `~` never appears in an account id. */
export const AGGREGATE = { curves: "~curves", pools: "~pools", fees: "~protocol-fees" } as const;

export class LiabilityTree {
  readonly snapshot: string;
  readonly root: SumNode;
  readonly #levels: SumNode[][];
  readonly #index = new Map<string, number>();
  readonly #leaves: { id: string; amount: bigint }[];

  constructor(snapshot: string, leaves: readonly { id: string; amount: bigint }[]) {
    if (leaves.length === 0) fail("InvalidArgument", "a liability tree needs at least one leaf");
    this.snapshot = snapshot;
    this.#leaves = [...leaves].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let level: SumNode[] = this.#leaves.map((l, i) => {
      if (l.amount < 0n) fail("InvariantViolation", `negative liability for ${l.id}`);
      if (this.#index.has(l.id)) fail("InvariantViolation", `duplicate leaf ${l.id}`);
      this.#index.set(l.id, i);
      return { hash: leafHash(snapshot, l.id, l.amount), sum: l.amount };
    });
    this.#levels = [level];
    while (level.length > 1) {
      const next: SumNode[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const l = level[i] as SumNode;
        const r = level[i + 1] ?? EMPTY;
        next.push({ hash: nodeHash(l, r), sum: l.sum + r.sum });
      }
      this.#levels.push(next);
      level = next;
    }
    this.root = level[0] as SumNode;
  }

  get size(): number {
    return this.#leaves.length;
  }

  proof(id: string): InclusionProof | null {
    const at = this.#index.get(id);
    if (at === undefined) return null;
    const path: ProofStep[] = [];
    let i = at;
    for (const level of this.#levels.slice(0, -1)) {
      const sibling = i % 2 === 0 ? (level[i + 1] ?? EMPTY) : (level[i - 1] as SumNode);
      path.push({ hash: sibling.hash, sum: sibling.sum, side: i % 2 === 0 ? "right" : "left" });
      i = Math.floor(i / 2);
    }
    const leaf = this.#leaves[at] as { id: string; amount: bigint };
    return { snapshot: this.snapshot, leaf: { ...leaf }, path, root: this.root };
  }

  /** Recompute the root from a proof alone. What a user's browser does. */
  static verify(proof: InclusionProof): boolean {
    let node: SumNode = { hash: leafHash(proof.snapshot, proof.leaf.id, proof.leaf.amount), sum: proof.leaf.amount };
    for (const step of proof.path) {
      if (step.sum < 0n) return false;
      node =
        step.side === "right"
          ? { hash: nodeHash(node, step), sum: node.sum + step.sum }
          : { hash: nodeHash(step, node), sum: step.sum + node.sum };
    }
    return node.hash === proof.root.hash && node.sum === proof.root.sum;
  }
}

/**
 * Snapshot the engine's liabilities. Each user's leaf is their ZEC balance
 * plus their withdrawals not yet settled, because that money hasn't left
 * reserves and is still owed to them. The root sum always equals everything
 * held inside the system, and this function refuses to return a tree
 * where it doesn't.
 */
export function snapshotLiabilities(engine: Engine): LiabilityTree {
  const owed = new Map<string, bigint>();
  const add = (id: string, amount: bigint) => {
    if (amount !== 0n || !owed.has(id)) owed.set(id, (owed.get(id) ?? 0n) + amount);
  };

  let curves = 0n;
  let pools = 0n;
  for (const [account, asset, amount] of engine.ledger.balances()) {
    if (asset !== QUOTE) continue;
    if (account.startsWith("user:")) add(account.slice(5), amount);
    else if (account.startsWith("curve:")) curves += amount;
    else if (account.startsWith("amm:")) pools += amount;
  }
  for (const w of engine.withdrawalRecords()) {
    if (w.state === "requested" || w.state === "submitted") add(w.user, w.amount);
  }
  // Every user with an address or any history gets a leaf, even at zero,
  // so anyone can check they're counted.
  for (const d of engine.depositRecords()) add(d.user, 0n);

  const leaves = [...owed.entries()].map(([id, amount]) => ({ id, amount }));
  leaves.push(
    { id: AGGREGATE.curves, amount: curves },
    { id: AGGREGATE.pools, amount: pools },
    { id: AGGREGATE.fees, amount: engine.ledger.balance(FEES, QUOTE) },
  );

  const tree = new LiabilityTree(`${engine.chain.length}:${engine.chain.head}`, leaves);
  const held = -engine.ledger.balance(CHAIN, QUOTE) - engine.ledger.balance(LOSS, QUOTE);
  if (tree.root.sum !== held) {
    fail("InvariantViolation", `liability root ${tree.root.sum} ≠ ledger ${held}`);
  }
  if (engine.ledger.balance(PENDING_WITHDRAWALS, QUOTE) < 0n) fail("InvariantViolation", "negative pending withdrawals");
  return tree;
}

#!/usr/bin/env node
/**
 * Snapshots the waitlist off chain and writes `script/waitlist-snapshot.txt`.
 *
 * This is the seam between intake and selection. Registration is a contract
 * anybody can read; the allowlist is a Merkle tree we publish; this is the step
 * that turns one into the other, and everything downstream of the file it writes
 * already works:
 *
 *   npm run waitlist                                     # → the snapshot
 *   python script/select.py --seed 0x<blockhash>          # → script/whitelist.txt
 *   python script/whitelist.py script/whitelist.txt       # → the tree + proofs
 *   WL_MAX_PER_WALLET=1 forge script script/SetWhitelist.s.sol --broadcast
 *
 * Its own file rather than `script/whitelist.txt`, which is where the selection
 * lands — intake and outcome are separate files so this one stays checkable against
 * the chain on its own, without the selection folded into it.
 *
 * It deliberately does not filter. Which registrants make the list is decided by the
 * published criteria in ALLOWLIST.md, applied by script/select.py, which prints its
 * full workings; folding either the criteria or a hand-edit into this export would
 * put that decision somewhere nobody can check. What this guarantees is only that
 * the file is the complete list of who registered, exactly as the contract has it.
 *
 * Every read is pinned to one block, so a window that is still open cannot shift
 * the list halfway through the walk.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, isAddress } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REPO = resolve(WEB, "..");
const OUT_PATH = join(REPO, "script", "waitlist-snapshot.txt");

/// Addresses per `registrants` call. Well inside any RPC's response limit, and
/// small enough that a rate-limited public endpoint does not reject the walk.
const PAGE = 200;

const ABI = [
  { type: "function", name: "count", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "opensAt", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "closesAt", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "isOpen", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  {
    type: "function",
    name: "registrants",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "standingOf",
    inputs: [{ type: "address" }],
    outputs: [
      { type: "bool" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "address" },
      { type: "uint256" },
    ],
    stateMutability: "view",
  },
];

main().catch((err) => {
  console.error(`\n${red("failed")} ${err?.shortMessage ?? err?.message ?? err}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpc = args.rpc ?? "http://127.0.0.1:8545";
  const address = args.waitlist ?? fromEnvLocal();

  if (!address) {
    throw new Error(
      "no waitlist address.\n" +
        "  Pass --waitlist 0x…, or set NEXT_PUBLIC_WAITLIST_ANVIL in web/.env.local.",
    );
  }
  if (!isAddress(address)) throw new Error(`not an address: ${address}`);

  const client = createPublicClient({ transport: http(rpc) });
  const chainId = await client.getChainId();

  // Pinned once and used for every read below. Without this a still-open window
  // could grow the list between the `count` and the last page, and the walk would
  // either miss the tail or run past the end.
  const blockNumber = await client.getBlockNumber();
  const read = (functionName, callArgs = []) =>
    client.readContract({ address, abi: ABI, functionName, args: callArgs, blockNumber });

  const [count, opensAt, closesAt, isOpen] = await Promise.all([
    read("count"),
    read("opensAt"),
    read("closesAt"),
    read("isOpen"),
  ]);

  console.log("");
  console.log(`  rpc        ${rpc}  ${dim(`chain ${chainId}`)}`);
  console.log(`  waitlist   ${address}`);
  console.log(`  block      ${blockNumber}`);
  console.log(`  opens at   ${opensAt}  ${dim(stamp(opensAt))}`);
  console.log(`  closes at  ${closesAt}  ${dim(stamp(closesAt))}`);
  console.log(`  registered ${count}`);

  if (count === 0n) throw new Error("nobody has registered — nothing to write");

  if (isOpen) {
    console.log("");
    console.log(
      `  ${gold("!")} registration is still open, so this snapshot will be out of date`,
    );
    console.log(
      `  ${dim("the file is a consistent view of block")} ${blockNumber}${dim(", but more will register after it")}`,
    );
  }

  // ─── Walk ────────────────────────────────────────────────────────────────

  const total = Number(count);
  const registrants = [];
  while (registrants.length < total) {
    const page = await read("registrants", [BigInt(registrants.length), BigInt(PAGE)]);
    // An empty page before the end would mean the walk cannot finish, and
    // silently writing a short list is exactly the failure that leaves somebody
    // who registered off the allowlist.
    if (page.length === 0) {
      throw new Error(
        `registrants(${registrants.length}, ${PAGE}) returned nothing with ${
          total - registrants.length
        } still to read`,
      );
    }
    registrants.push(...page);
    process.stdout.write(`\r  reading    ${registrants.length}/${total}`);
  }
  process.stdout.write("\n");

  if (registrants.length !== total) {
    throw new Error(`read ${registrants.length} addresses but count() says ${total}`);
  }

  const unique = new Set(registrants.map((a) => a.toLowerCase()));
  if (unique.size !== total) {
    throw new Error(
      `${total - unique.size} duplicate addresses in the list — the contract should make that impossible`,
    );
  }

  // ─── Standing ──────────────────────────────────────────────────────────────

  // A second read per address, down a different path than the `registrants` walk.
  // The array and the mapping are written in one transaction, so a `position` that
  // disagrees with the walk's own index catches a bad page boundary — the one bug
  // in this walk that would otherwise look like success. It also carries the two
  // fields the selection needs and the walk cannot give: when each address
  // registered, and who referred it.
  //
  // Referrals are the allowlist rank now (see ALLOWLIST.md), so unlike a pure
  // cross-check this pass is not optional — a snapshot without referrer edges would
  // silently grade every wallet as having referred no one. `--skip-verify` therefore
  // drops only the position assertion; the reads happen either way.
  const ZERO = "0x0000000000000000000000000000000000000000";
  const times = new Array(total);
  const referrers = new Array(total).fill(null);
  for (let start = 0; start < total; start += 20) {
    const slice = registrants.slice(start, start + 20);
    const records = await Promise.all(
      slice.map((who) => read("standingOf", [who])),
    );
    records.forEach(([, position, at, referrer], i) => {
      const index = start + i;
      if (!args.skipVerify && Number(position) !== index + 1) {
        throw new Error(
          `${slice[i]} is at index ${index} but standingOf says position ${position}`,
        );
      }
      times[index] = at;
      referrers[index] =
        referrer && referrer.toLowerCase() !== ZERO ? referrer.toLowerCase() : null;
    });
    process.stdout.write(`\r  reading    ${Math.min(start + 20, total)}/${total}`);
  }
  process.stdout.write("\n");

  const referred = referrers.filter(Boolean).length;

  // ─── Write ───────────────────────────────────────────────────────────────

  const out = args.out ? resolve(args.out) : OUT_PATH;
  if (existsSync(out)) {
    console.log(`  ${dim(`overwriting ${display(out)}`)}`);
  }

  const lines = [
    `# The waitlist, as registered. Written by web/scripts/waitlist.mjs.`,
    `#`,
    `# ${total} addresses · ${referred} with a referrer · ${address}`,
    `# chain ${chainId} · block ${blockNumber}`,
    `# registration ${isOpen ? "STILL OPEN — this list is not final" : "closed " + stamp(closesAt)}`,
    `#`,
    `# Each line: address, 1-based arrival position, the referrer as ref=0x… when one`,
    `# was named, and the registration time. Referrals are the allowlist rank, so the`,
    `# ref= edges are load-bearing — see ALLOWLIST.md.`,
    `#`,
    `# This is intake, not the allowlist. Apply the published criteria in ALLOWLIST.md:`,
    `#   python script/select.py --seed 0x<blockhash> --launchpad <launchpad>`,
    ``,
  ];
  registrants.forEach((who, i) => {
    const ref = referrers[i] ? `  ref=${referrers[i]}` : "";
    const when = times[i] === undefined ? "" : `  ${stamp(times[i])}`;
    lines.push(`${who.toLowerCase()}  # ${i + 1}${ref}${when}`);
  });
  writeFileSync(out, lines.join("\n") + "\n");

  console.log("");
  console.log(`${green("✓")} ${display(out)}  ${total} addresses  ${dim(`${referred} referred`)}`);
  console.log("");
  console.log("Next:");
  console.log(`  1. python script/select.py --seed 0x<blockhash> --launchpad <launchpad> ${display(out)}`);
  console.log(`  2. python script/whitelist.py script/whitelist.txt`);
  console.log("  3. PLATES=… WL_ROOT=… WL_MAX_PER_WALLET=1 \\");
  console.log("       forge script script/SetWhitelist.s.sol --rpc-url <net> --broadcast");
}

// ─── Bits ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { rpc: null, waitlist: null, out: null, skipVerify: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--rpc") args.rpc = argv[++i];
    else if (flag === "--waitlist") args.waitlist = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--skip-verify") args.skipVerify = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

/**
 * The local waitlist address, so the common case needs no flags.
 *
 * Only the anvil line: a real snapshot should name its network out loud on the
 * command line rather than inherit whichever chain a dotfile happened to mention.
 */
function fromEnvLocal() {
  const path = join(WEB, ".env.local");
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(
    /^NEXT_PUBLIC_WAITLIST_ANVIL=(0x[0-9a-fA-F]{40})\s*$/m,
  );
  return match ? match[1] : null;
}

function stamp(unixSeconds) {
  const at = Number(unixSeconds);
  if (!at) return "";
  return new Date(at * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function display(path) {
  return path.startsWith(REPO) ? path.slice(REPO.length + 1).replace(/\\/g, "/") : path;
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const gold = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

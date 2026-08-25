#!/usr/bin/env node
/**
 * One command to get a working underwater.fun on your own machine.
 *
 * Starts an anvil node, deploys WETH9 + the DEX + the launchpad onto it, seeds a
 * handful of launches (including one that graduates so you can see the pool side
 * of the app), deploys and seals the plates collection with its art so /mint has
 * something real to read, opens an allowlist waitlist with a few accounts already
 * registered, writes the anvil addresses into web/.env.local, and then stays in
 * the foreground holding the node open.
 *
 * Deliberately uses viem rather than `forge script`: the whole point is that no
 * private key of yours is involved. The keys below are anvil's published test
 * keys, funded only on a chain that lives in this terminal.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const REPO = resolve(WEB, "..");
const OUT = join(REPO, "out");
const RPC = "http://127.0.0.1:8545";
const CHAIN_ID = 31337;

/** Anvil's default accounts ("test test … junk"). Public, worthless, local. */
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];

const CHAIN = {
  id: CHAIN_ID,
  name: "Anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

// Same defaults as script/Deploy.s.sol, so local behaviour matches a real deploy.
const TRADE_FEE_BPS = 100n;
const CREATION_FEE = 0n;
const GRADUATION_FEE_BPS = 500n;

// Same defaults as script/DeployPlates.s.sol, for the same reason.
const PLATES_PRICE = parseEther("0.0222");
const PLATES_WL_PRICE = parseEther("0.00333");
const PLATES_RESERVE = 222n;
const PLATES_WINDOW = 14n * 24n * 60n * 60n;
/// Words per `commit`. The same batch size SealPlates.s.sol uses.
const TABLE_BATCH = 64;

// Same default as script/DeployWaitlist.s.sol.
const WAITLIST_WINDOW = 7n * 24n * 60n * 60n;

const SEEDS = [
  { name: "Ink Squid", symbol: "SQUID", buy: "0.35", extra: ["0.8", "1.2"] },
  { name: "Abyssal Jelly", symbol: "JELLY", buy: "0.05", extra: ["0.15"] },
  { name: "Lantern Fish", symbol: "LANTERN", buy: "1.5", extra: ["2.1"] },
  { name: "Barnacle", symbol: "BARN", buy: "0", extra: [] },
  // Crosses 4 ETH, so the launchpad trims it, refunds the rest, and graduates
  // the token onto our own DEX — the only way to exercise the pool panel.
  { name: "Sunlit Kelp", symbol: "KELP", buy: "5", extra: [] },
];

main().catch((err) => {
  console.error(`\n${red("failed")} ${err?.shortMessage ?? err?.message ?? err}`);
  process.exit(1);
});

async function main() {
  const artifacts = loadArtifacts();
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC) });

  let anvil = null;
  if (await alive(publicClient)) {
    console.log(`${dim("·")} reusing the node already listening on ${RPC}`);
  } else {
    anvil = await startAnvil();
    if (!(await waitForNode(publicClient))) {
      throw new Error("anvil started but never answered on " + RPC);
    }
    console.log(`${green("✓")} anvil up on ${RPC} (chain ${CHAIN_ID})`);
  }

  const wallets = KEYS.map((key) =>
    createWalletClient({
      account: privateKeyToAccount(key),
      chain: CHAIN,
      transport: http(RPC),
    }),
  );
  const deployer = wallets[0];
  const owner = deployer.account.address;

  const deploy = async (label, artifact, args) => {
    const hash = await deployer.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${label} deploy reverted`);
    console.log(`${green("✓")} ${label.padEnd(18)} ${receipt.contractAddress}`);
    return receipt.contractAddress;
  };

  console.log("");
  const weth = await deploy("WETH9", artifacts.WETH9, []);
  const factory = await deploy("UnderwaterFactory", artifacts.UnderwaterFactory, [owner]);
  const router = await deploy("UnderwaterRouter", artifacts.UnderwaterRouter, [
    factory,
    weth,
  ]);
  const launchpad = await deploy("UnderwaterLaunchpad", artifacts.UnderwaterLaunchpad, [
    owner,
    router,
    owner,
    TRADE_FEE_BPS,
    CREATION_FEE,
    GRADUATION_FEE_BPS,
  ]);

  // Same sanity checks the Solidity scripts make, for the same reason: a router
  // wired to the wrong factory creates pools nothing can find.
  const wiredFactory = await publicClient.readContract({
    address: router,
    abi: artifacts.UnderwaterRouter.abi,
    functionName: "factory",
  });
  if (wiredFactory.toLowerCase() !== factory.toLowerCase()) {
    throw new Error("router/factory mismatch");
  }

  console.log(`\n${dim("seeding launches")}`);
  const launchpadAbi = artifacts.UnderwaterLaunchpad.abi;

  for (const [i, seed] of SEEDS.entries()) {
    const creator = wallets[i % wallets.length];
    const buyWei = parseEther(seed.buy);

    const createHash = await creator.writeContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "create",
      args: [seed.name, seed.symbol, `ipfs://local/${seed.symbol.toLowerCase()}`, 0n],
      value: CREATION_FEE + buyWei,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    if (receipt.status !== "success") throw new Error(`create ${seed.symbol} reverted`);

    const token = await publicClient.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "allTokens",
      args: [BigInt(i)],
    });

    for (const [j, amount] of seed.extra.entries()) {
      const buyer = wallets[(i + j + 1) % wallets.length];
      const hash = await buyer.writeContract({
        address: launchpad,
        abi: launchpadAbi,
        functionName: "buy",
        args: [token, 0n, buyer.account.address],
        value: parseEther(amount),
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }

    const pool = await publicClient.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "pools",
      args: [token],
    });
    const raised = pool[2];
    const graduated = pool[6];
    console.log(
      `  ${seed.symbol.padEnd(8)} ${token}  ${(Number(raised) / 1e18).toFixed(3)} ETH` +
        (graduated ? `  ${gold("graduated")}` : ""),
    );
  }

  const collection = await deployPlates({
    artifacts,
    publicClient,
    deploy,
    wallets,
    owner,
  });

  const waitlist = await deployWaitlist({
    artifacts,
    publicClient,
    deploy,
    wallets,
  });

  writeEnv({
    NEXT_PUBLIC_LAUNCHPAD_ANVIL: launchpad,
    NEXT_PUBLIC_PLATES_ANVIL: collection.plates,
    NEXT_PUBLIC_WAITLIST_ANVIL: waitlist.address,
  });

  console.log(`\n${green("ready")}`);
  console.log(`  launchpad  ${launchpad}`);
  console.log(`  router     ${router}`);
  console.log(`  WETH9      ${weth}`);
  console.log(`  plates     ${collection.plates}`);
  console.log(`  renderer   ${collection.renderer}`);
  console.log(`  waitlist   ${waitlist.address}`);
  console.log(
    `\n  ${dim("wrote the three NEXT_PUBLIC_*_ANVIL addresses to web/.env.local")}`,
  );
  console.log(
    `  ${dim("NEXT_PUBLIC_* is inlined at build time — restart the dev server to pick it up")}`,
  );
  console.log(
    `  ${dim("in your wallet: add a network on")} ${RPC} ${dim("with chain id")} ${CHAIN_ID}`,
  );
  console.log(
    `  ${dim("import anvil account #0 to spend the seeded balances:")}\n  ${dim(KEYS[0])}`,
  );

  if (anvil) {
    console.log(`\n${dim("node is running in the foreground — ctrl-c to stop it")}`);
    await new Promise((keepAlive) => {
      const stop = () => {
        anvil.kill();
        keepAlive();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      anvil.on("exit", keepAlive);
    });
  }
}

/**
 * Foundry writes one JSON per contract; the launchpad and DEX each live in their
 * own file, while the WETH9 we need for a chain with no OP Stack predeploy comes
 * from the DEX test mocks.
 */
function loadArtifacts() {
  const WANTED = {
    WETH9: "DexMocks.sol/WETH9.json",
    UnderwaterFactory: "UnderwaterFactory.sol/UnderwaterFactory.json",
    UnderwaterRouter: "UnderwaterRouter.sol/UnderwaterRouter.json",
    UnderwaterLaunchpad: "UnderwaterLaunchpad.sol/UnderwaterLaunchpad.json",
    // The collection, its art, and a stand-in for Aave — the real pool does not
    // exist on a chain that started thirty seconds ago, and the address is
    // immutable, so local has to supply something that answers like one.
    MockAavePool: "NftMocks.sol/MockAavePool.json",
    UnderwaterPlates: "UnderwaterPlates.sol/UnderwaterPlates.json",
    UnderwaterWaitlist: "UnderwaterWaitlist.sol/UnderwaterWaitlist.json",
    UnderwaterFigures: "UnderwaterFigures.sol/UnderwaterFigures.json",
    UnderwaterMarks: "UnderwaterMarks.sol/UnderwaterMarks.json",
    UnderwaterScenes: "UnderwaterScenes.sol/UnderwaterScenes.json",
    UnderwaterNames: "UnderwaterNames.sol/UnderwaterNames.json",
    UnderwaterRenderer: "UnderwaterRenderer.sol/UnderwaterRenderer.json",
  };
  const out = {};
  for (const [name, rel] of Object.entries(WANTED)) {
    const path = join(OUT, rel);
    if (!existsSync(path)) {
      throw new Error(
        `missing artifact ${rel}\n  Run \`forge build\` in the repo root first.`,
      );
    }
    const json = JSON.parse(readFileSync(path, "utf8"));
    const bytecode = json.bytecode?.object;
    // `forge test` compiles in sparse mode and can overwrite an artifact with an
    // ABI-only version, which then deploys as an empty contract. Say so plainly
    // rather than failing later with "no code at address".
    if (!bytecode || bytecode === "0x") {
      throw new Error(
        `${rel} has an ABI but no bytecode.\n` +
          "  A previous `forge test` left sparse artifacts behind.\n" +
          "  Run `forge build --force` in the repo root, then try again.",
      );
    }
    out[name] = { abi: json.abi, bytecode };
  }
  return out;
}

// ─── The plates collection ──────────────────────────────────────────────────

/**
 * The whole launch sequence, locally: deploy, commit the table, seal, wire the
 * art, publish an allowlist, and sell a few plates.
 *
 * It runs the same steps in the same order as the four `forge script` files, and
 * for the same reasons — the table is verified against `provenance` before a
 * single word is committed, and the art is deployed before minting opens so
 * `tokenURI` never resolves to nothing. What it adds is state: an allowlist that
 * this machine actually holds proofs for, and a couple of plates already diving
 * against a sinking position, because a mint page with nothing minted on it only
 * exercises half of itself.
 */
async function deployPlates({ artifacts, publicClient, deploy, wallets, owner }) {
  const deployer = wallets[0];
  const table = readTable();
  const provenance = readFileSync(join(REPO, "traits", "provenance.txt"), "utf8").trim();

  // The same check SealPlates.s.sol makes before broadcasting: a table that does
  // not hash to the provenance can never be sealed, and finding that out here
  // costs nothing.
  const localHash = keccak256(
    encodeAbiParameters([{ type: "uint256[]" }], [table]),
  );
  if (localHash !== provenance) {
    throw new Error(
      `traits/table.csv hashes to ${localHash}\n  but traits/provenance.txt says ${provenance}\n` +
        "  One of the two is stale — regenerate with art/solidify.py.",
    );
  }

  console.log(`\n${dim("plates collection")}`);
  const aave = await deploy("MockAavePool", artifacts.MockAavePool, []);

  const now = (await publicClient.getBlock()).timestamp;
  const plates = await deploy("UnderwaterPlates", artifacts.UnderwaterPlates, [
    owner,
    aave,
    owner,
    provenance,
    PLATES_PRICE,
    PLATES_WL_PRICE,
    PLATES_RESERVE,
    now + PLATES_WINDOW,
  ]);
  const abi = artifacts.UnderwaterPlates.abi;

  const send = async (client, functionName, args, value) => {
    const hash = await client.writeContract({
      address: plates,
      abi,
      functionName,
      args,
      ...(value === undefined ? {} : { value }),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return receipt;
  };
  const read = (functionName, args = []) =>
    publicClient.readContract({ address: plates, abi, functionName, args });

  for (let start = 0; start < table.length; start += TABLE_BATCH) {
    await send(deployer, "commit", [
      BigInt(start),
      table.slice(start, start + TABLE_BATCH),
    ]);
  }
  // Mints the treasury reserve, which is why the lowest ids exist before anybody
  // has bought anything.
  await send(deployer, "seal", []);
  console.log(
    `${green("✓")} ${"sealed".padEnd(18)} ${table.length} words · ${await read("minted")} reserved`,
  );

  const figures = await deploy("UnderwaterFigures", artifacts.UnderwaterFigures, []);
  const marks = await deploy("UnderwaterMarks", artifacts.UnderwaterMarks, []);
  const scenes = await deploy("UnderwaterScenes", artifacts.UnderwaterScenes, []);
  const names = await deploy("UnderwaterNames", artifacts.UnderwaterNames, []);
  const renderer = await deploy("UnderwaterRenderer", artifacts.UnderwaterRenderer, [
    figures,
    marks,
    scenes,
    names,
  ]);
  await send(deployer, "setRenderer", [renderer]);

  // The allowlist depth the launch is actually configured for. Left at the
  // deployed default of 22, the 1000-plate allocation fits inside 46 addresses and
  // the panel says so — which is true but not what we are launching, and local
  // should match the runbook. SetWhitelist.s.sol does this in the same broadcast
  // as the root on a real network.
  await send(deployer, "setMaxPerWallet", [2n]);

  // Every anvil account, so whichever one is imported into the wallet is on the
  // list. `writeAllowlist` says out loud that it overwrites a published one.
  const members = wallets.map((w) => w.account.address);
  const { root, proofs } = merkleTree(members);
  await send(deployer, "setMerkleRoot", [root]);
  writeAllowlist(root, proofs);
  console.log(`${green("✓")} ${"allowlist".padEnd(18)} ${members.length} members · ${root.slice(0, 10)}…`);

  // One account at its limit and one with a plate left, so the panel has both the
  // "you have taken all of yours" copy and a live allowlist mint to show.
  const wlBuys = [
    [1, 2n],
    [2, 1n],
  ];
  for (const [index, qty] of wlBuys) {
    await send(
      wallets[index],
      "mintWhitelist",
      [qty, proofs[members[index].toLowerCase()]],
      PLATES_WL_PRICE * qty,
    );
  }
  await send(deployer, "openPublicMint", []);
  await send(wallets[3], "mint", [4n], PLATES_PRICE * 4n);

  // One plate diving against a position that is sinking but not liquidatable, one
  // comfortably afloat. Pre-reveal every plate renders as a sealed tube, so this
  // is really for whatever calls `reveal` later — and for `scar`, which is the
  // one irreversible thing a visitor can do to somebody else's art.
  //
  // Ids are assigned in mint order, so the reserve takes 1..222, account #1's two
  // allowlist plates take 223 and 224, and account #2's single one takes 225. Both
  // `dive` calls below are made by the owner of the id, so these two numbers have
  // to move whenever the seeded quantities above do.
  const sinking = PLATES_RESERVE + 1n;
  const afloat = PLATES_RESERVE + 3n;
  await send(wallets[1], "dive", [sinking]);
  await send(wallets[2], "dive", [afloat]);
  const aaveAbi = artifacts.MockAavePool.abi;
  for (const [index, hf] of [
    [1, parseEther("1.15")],
    [2, parseEther("3.4")],
  ]) {
    const hash = await wallets[index].writeContract({
      address: aave,
      abi: aaveAbi,
      functionName: "setHealthFactor",
      args: [wallets[index].account.address, hf],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  // Account #1's position is under SCAR_HF now, so its plate can be engraved —
  // by anyone, which is the point of the function.
  await send(wallets[0], "scar", [sinking]);

  console.log(
    `  ${dim("minted")} ${await read("minted")} ${dim("of 2222 ·")} ${await read("wlMinted")} ${dim("from the allowlist")}`,
  );

  return { plates, renderer, aave, root };
}

// ─── The waitlist ───────────────────────────────────────────────────────────

/**
 * Allowlist intake, with a window that is open right now.
 *
 * Registration and the mint overlap here on purpose. On the real timeline they do
 * not — the window closes, the tree is published, then the mint opens — but that
 * ordering would leave the panel unreachable on a chain where the collection is
 * already selling, and the second-wave case (registration open while wave one
 * mints) is the one worth being able to look at.
 *
 * Two of the five accounts are registered and three are not, so both sides of the
 * panel are on screen depending on which account the wallet is holding: a receipt
 * with an arrival number, and a live Register button.
 */
async function deployWaitlist({ artifacts, publicClient, deploy, wallets }) {
  console.log(`\n${dim("waitlist")}`);

  const now = (await publicClient.getBlock()).timestamp;
  const address = await deploy("UnderwaterWaitlist", artifacts.UnderwaterWaitlist, [
    now,
    now + WAITLIST_WINDOW,
  ]);
  const abi = artifacts.UnderwaterWaitlist.abi;

  // Accounts #1 and #2, matching the two that hold allowlist plates — so the
  // account that has minted is also the one with a registration to show.
  for (const index of [1, 2]) {
    const hash = await wallets[index].writeContract({
      address,
      abi,
      functionName: "register",
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("register reverted");
  }

  const count = await publicClient.readContract({ address, abi, functionName: "count" });
  console.log(
    `  ${dim("registered")} ${count} ${dim(`of ${wallets.length} accounts · closes in 7d`)}`,
  );
  console.log(
    `  ${dim("accounts #0, #3 and #4 are not registered, so the Register button is live for them")}`,
  );

  return { address, count };
}

/** The 371 packed trait words, as `art/solidify.py` wrote them. */
function readTable() {
  const path = join(REPO, "traits", "table.csv");
  const words = readFileSync(path, "utf8")
    .split(/[,\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => BigInt(w));
  if (words.length !== 371) {
    throw new Error(`traits/table.csv has ${words.length} words, expected 371`);
  }
  return words;
}

/**
 * The allowlist tree, exactly as `src/utils/MerkleProof.sol` verifies it.
 *
 * Three rules that are easy to get subtly wrong, which is why this mirrors
 * `script/whitelist.py` line for line rather than reaching for a library: leaves
 * are hashed twice, pairs are sorted so a proof needs no left/right flags, and a
 * lone node at the end of an odd layer is promoted rather than hashed against
 * itself. Every proof is re-verified below before anything is written.
 */
function merkleTree(addresses) {
  const leaves = addresses.map((a) =>
    keccak256(keccak256(encodeAbiParameters([{ type: "address" }], [a]))),
  );

  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const below = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < below.length; i += 2) {
      next.push(i + 1 < below.length ? hashPair(below[i], below[i + 1]) : below[i]);
    }
    layers.push(next);
  }
  const root = layers[layers.length - 1][0];

  const proofs = {};
  for (const [i, address] of addresses.entries()) {
    const proof = [];
    let index = i;
    for (let level = 0; level < layers.length - 1; level++) {
      const sibling = index ^ 1;
      if (sibling < layers[level].length) proof.push(layers[level][sibling]);
      index = Math.floor(index / 2);
    }
    let computed = leaves[i];
    for (const sibling of proof) computed = hashPair(computed, sibling);
    if (computed !== root) throw new Error(`proof does not verify for ${address}`);
    proofs[address.toLowerCase()] = proof;
  }

  return { root, proofs };
}

/// Sorted-pair hashing. viem returns lowercase hex of a fixed width, so comparing
/// the strings compares the bytes.
function hashPair(a, b) {
  return a < b ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/**
 * Publish the proofs where the mint page fetches them.
 *
 * Same file and same shape as `script/whitelist.py --out`, because /mint checks
 * the root in here against the root on chain and refuses to build a transaction
 * from a list that does not match.
 */
function writeAllowlist(root, proofs) {
  const path = join(WEB, "public", "whitelist.json");
  if (existsSync(path)) {
    console.log(
      `  ${dim("overwriting web/public/whitelist.json — a real allowlist here is now gone")}`,
    );
  }
  writeFileSync(
    path,
    JSON.stringify({ root, members: Object.keys(proofs).length, proofs }, null, 2) + "\n",
  );
}

function findAnvil() {
  const candidates = [
    join(homedir(), ".foundry", "bin", "anvil.exe"),
    join(homedir(), ".foundry", "bin", "anvil"),
  ];
  for (const path of candidates) if (existsSync(path)) return path;
  // Fall back to PATH and let spawn report ENOENT with a useful message.
  return process.platform === "win32" ? "anvil.exe" : "anvil";
}

async function startAnvil() {
  const bin = findAnvil();
  const child = spawn(bin, ["--silent", "--chain-id", String(CHAIN_ID)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error(
        `\n${red("anvil not found")}\n  Install Foundry, or add ~/.foundry/bin to PATH.`,
      );
    } else {
      console.error(`\n${red("anvil failed")} ${err.message}`);
    }
    process.exit(1);
  });
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`\n${red("anvil exited")} code ${code}\n${stderr}`);
      process.exit(1);
    }
  });
  return child;
}

async function alive(client) {
  try {
    return (await client.getChainId()) === CHAIN_ID;
  } catch {
    return false;
  }
}

async function waitForNode(client, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (await alive(client)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Set the anvil addresses, leaving every other line of .env.local alone. */
function writeEnv(vars) {
  const path = join(WEB, ".env.local");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = line;
    else {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(line, "");
    }
  }
  writeFileSync(path, lines.join("\n"));
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const gold = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

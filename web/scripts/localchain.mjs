#!/usr/bin/env node
/**
 * One command to get a working underwater.fun on your own machine.
 *
 * Starts an anvil node, deploys WETH9 + the DEX + the launchpad onto it, seeds a
 * handful of launches (including one that graduates so you can see the pool side
 * of the app), writes NEXT_PUBLIC_LAUNCHPAD_ANVIL into web/.env.local, and then
 * stays in the foreground holding the node open.
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
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");
const OUT = resolve(WEB, "..", "out");
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

  writeEnv(launchpad);

  console.log(`\n${green("ready")}`);
  console.log(`  launchpad  ${launchpad}`);
  console.log(`  router     ${router}`);
  console.log(`  WETH9      ${weth}`);
  console.log(`\n  ${dim("wrote NEXT_PUBLIC_LAUNCHPAD_ANVIL to web/.env.local")}`);
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

/** Set the anvil launchpad address, leaving every other line of .env.local alone. */
function writeEnv(launchpad) {
  const path = join(WEB, ".env.local");
  const line = `NEXT_PUBLIC_LAUNCHPAD_ANVIL=${launchpad}`;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith("NEXT_PUBLIC_LAUNCHPAD_ANVIL="));
  if (idx >= 0) lines[idx] = line;
  else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(line, "");
  }
  writeFileSync(path, lines.join("\n"));
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const gold = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

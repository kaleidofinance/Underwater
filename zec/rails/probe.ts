/**
 * Live, read-only check against Zcash testnet through public lightwalletd
 * servers: server info, the tip, a recent block, and a transaction lookup
 * round trip. Sends nothing.
 *
 *   node rails/probe.ts [server-url]
 */
import { Lightwalletd, TESTNET_SERVERS, toHex } from "./lightwalletd.ts";

const servers = process.argv[2] ? [process.argv[2]] : TESTNET_SERVERS;
let failures = 0;

for (const url of servers) {
  const lwd = new Lightwalletd(url);
  try {
    const started = Date.now();
    const info = await lwd.info();
    const tip = await lwd.latestBlock();
    const block = await lwd.block(tip.height - 1);
    const hash = block.txHashes[0];
    const tx = hash ? await lwd.transaction(hash) : null;
    const age = Math.round(Date.now() / 1000 - block.time);

    console.log(`\n${url}`);
    console.log(`  ${info.vendor} ${info.version} · chain "${info.chainName}" · branch ${info.consensusBranchId}`);
    console.log(`  tip ${tip.height} (${tip.hash.slice(0, 16)}…), server reports ${info.blockHeight}`);
    console.log(`  block ${block.height}: ${block.txHashes.length} tx, mined ${age}s ago`);
    if (hash) console.log(`  lookup tx ${toHex(Uint8Array.from(hash).reverse()).slice(0, 16)}… → height ${tx?.height ?? "not found"}, ${tx?.size ?? 0} bytes`);
    console.log(`  round trip ${Date.now() - started} ms`);
    if (info.chainName !== "test") {
      console.error(`  ✗ expected testnet ("test"), got "${info.chainName}"`);
      failures++;
    }
    if (hash && tx?.height !== block.height) {
      console.error("  ✗ transaction lookup didn't return the block it came from");
      failures++;
    }
  } catch (err) {
    console.error(`\n${url}\n  ✗ ${(err as Error).message}`);
    failures++;
  } finally {
    lwd.close();
  }
}

process.exit(failures > 0 ? 1 : 0);

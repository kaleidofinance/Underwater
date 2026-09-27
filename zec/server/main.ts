/**
 * The Underwater ZEC server: one process, one writer. It holds the durable
 * engine, runs the rails tick loop, and serves the HTTP API plus a live
 * event stream.
 *
 *   node server/main.ts                 real: durable log + wallet service (zec/.env.wallet)
 *   node server/main.ts --sim           dev: in-memory engine + simulated chain + faucet
 *
 * Options: --port 8811 (or PORT) · --log data/engine.jsonl (or ZEC_LOG) · --interval 15 (seconds between ticks)
 * Env: ZEC_WEB_ORIGIN (CORS origin; default *).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine, ZEC_LAUNCH_FEES, ZEC_PARAMS, openEngine } from "../engine/index.ts";
import { HttpWallet } from "../rails/http-wallet.ts";
import { DEFAULT_POLICY, Rails } from "../rails/rails.ts";
import { SimChain } from "../rails/sim.ts";
import { readWalletEnv } from "../rails/wallet-env.ts";
import { App, wire } from "./app.ts";
import { Market, toPrice } from "./market.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return (i >= 0 ? process.argv[i + 1] : undefined) ?? fallback;
};

const simMode = process.argv.includes("--sim");
const port = Number(arg("--port", process.env.PORT ?? "8811"));
const intervalMs = Number(arg("--interval", simMode ? "5" : "15")) * 1000;
const origin = process.env.ZEC_WEB_ORIGIN ?? "*";
const MAX_BODY = 64 * 1024;

// ─── Wiring ─────────────────────────────────────────────────────────────────

let engine: Engine;
let close = (): void => {};
let sim: SimChain | undefined;
if (simMode) {
  // Ephemeral on purpose: a simulated chain can't outlive the process, so neither should balances credited from it.
  engine = new Engine({ params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
  sim = new SimChain();
} else {
  const logPath = resolve(root, arg("--log", process.env.ZEC_LOG ?? "data/engine.jsonl"));
  mkdirSync(dirname(logPath), { recursive: true });
  const store = openEngine(logPath, { params: ZEC_PARAMS, fees: ZEC_LAUNCH_FEES });
  engine = store.engine;
  close = () => store.close();
  console.log(`engine: ${logPath} (${store.replayed} commands replayed, head ${engine.chain.head.slice(0, 16)})`);
}
const wallet = sim ?? new HttpWallet(readWalletEnv(root));
const rails = new Rails(engine, wallet, DEFAULT_POLICY);
const market = new Market();
const app = new App({ engine, rails, market, sim });

// ─── Live stream (Server-Sent Events) ───────────────────────────────────────

const streams = new Set<ServerResponse>();
market.subscribe((trades, events) => {
  const frames: string[] = [];
  for (const t of trades) frames.push(`event: trade\ndata: ${JSON.stringify({ ...(wire(t) as object), price: toPrice(t.priceX18) })}\n\n`);
  for (const ev of events) {
    if (ev.type === "TokenCreated" || ev.type === "Graduated") frames.push(`event: token\ndata: ${JSON.stringify(wire(ev))}\n\n`);
  }
  for (const res of streams) for (const f of frames) res.write(f);
});
setInterval(() => {
  for (const res of streams) res.write(": keepalive\n\n");
}, 15_000).unref();

// ─── HTTP ───────────────────────────────────────────────────────────────────

function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-uw-key, x-uw-ts, x-uw-sig");
  res.setHeader("access-control-max-age", "600");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

const server = createServer(async (req, res) => {
  cors(res);
  const path = req.url ?? "/";
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET" && path.split("?")[0] === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  try {
    const body = await readBody(req);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    const out = await app.handle({ method: req.method ?? "GET", path, headers, body });
    market.catchUp(engine); // push anything this request committed to the stream
    res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
  } catch (err) {
    res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
  }
});

server.listen(port, () => {
  console.log(`underwater zec ${simMode ? "(SIM) " : ""}api on http://localhost:${port}/api · ticks every ${intervalMs / 1000}s`);
});

// ─── Rails loop ─────────────────────────────────────────────────────────────

let stopping = false;
const shutdown = (): void => {
  stopping = true;
  server.close();
  for (const res of streams) res.end();
  close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

while (!stopping) {
  try {
    if (sim) sim.mine(); // the simulated chain only moves when told to
    const r = await rails.tick();
    market.catchUp(engine);
    for (const a of r.alerts) console.warn(`ALERT ${a}`);
    const moved = r.credited.length + r.matured.length + r.reversed.length + r.submitted.length + r.settled.length + r.failed.length;
    if (moved > 0) console.log(`tip ${r.tip} · credited ${r.credited.length} · matured ${r.matured.length} · settled ${r.settled.length} · failed ${r.failed.length}`);
  } catch (err) {
    console.error(`tick failed: ${(err as Error).message}`);
  }
  await new Promise((done) => setTimeout(done, intervalMs));
}

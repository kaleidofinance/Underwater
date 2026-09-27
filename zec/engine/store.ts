/**
 * Durable command log.
 *
 * One JSON line per accepted command, fsynced before the command takes
 * effect (see `onCommit` in engine.ts). The log *is* the database: opening it
 * replays every line through a fresh engine and requires each recomputed
 * hash to equal the stored one. So a log that was edited, reordered or cut
 * in the middle refuses to load, and so does any nondeterminism in the
 * engine, which would otherwise surface much later as balances that don't
 * reproduce.
 *
 * The one tolerated defect is a torn final line, which is what a crash in
 * the middle of a write leaves behind. That command was never acknowledged,
 * so the partial line is cut off and the log opens at the last whole command.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import type { CurveParams, FeeParams } from "./config.ts";
import { Engine, type Command } from "./engine.ts";
import { fail } from "./errors.ts";
import { canonical, type ChainRecord } from "./hashchain.ts";

const FORMAT = "underwater-zec-log";
const VERSION = 1;

export interface OpenOptions {
  readonly params: CurveParams;
  /** Starting fees for a new log. An existing log keeps the fees in its header. */
  readonly fees: FeeParams;
  readonly clock?: () => number;
}

export interface OpenedEngine {
  readonly engine: Engine;
  /** Commands replayed from disk. */
  readonly replayed: number;
  /** True if a torn final line from an interrupted write was cut off. */
  readonly truncatedTail: boolean;
  close(): void;
}

/** Which fields of each command are bigints, since JSON carries them as strings. */
const BIGINT_FIELDS = {
  assignAddress: [],
  creditDeposit: ["amount"],
  matureDeposit: [],
  reverseDeposit: [],
  requestWithdrawal: ["amount", "fee"],
  cancelWithdrawal: [],
  submitWithdrawals: ["networkFee"],
  settleWithdrawals: [],
  failWithdrawals: [],
  submitTreasuryTx: ["networkFee"],
  settleTreasuryTx: [],
  failTreasuryTx: [],
  create: ["value", "minTokensOut"],
  buy: ["value", "minTokensOut"],
  sell: ["tokenAmount", "minQuoteOut"],
  graduate: [],
  swapQuoteForTokens: ["amountIn", "minOut"],
  swapTokensForQuote: ["amountIn", "minOut"],
  setTradeFeeBps: ["bps"],
  setGraduationFeeBps: ["bps"],
  setCreationFee: ["fee"],
  setCreatorShareBps: ["bps"],
  setAmmFeeBps: ["bps"],
} as const satisfies Record<Command["kind"], readonly string[]>;

export function decodeCommand(raw: unknown): Command {
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind as Command["kind"];
  const fields: readonly string[] | undefined = BIGINT_FIELDS[kind];
  if (!fields) fail("InvalidArgument", `unknown command kind ${String(kind)}`);
  const out: Record<string, unknown> = { ...obj };
  for (const f of fields) out[f] = BigInt(obj[f] as string);
  return out as unknown as Command;
}

function bigintRecord<T>(raw: Record<string, string>): T {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, BigInt(v)])) as T;
}

export function openEngine(path: string, options: OpenOptions): OpenedEngine {
  let lines: string[] = [];
  let truncatedTail = false;

  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline !== text.length - 1) {
      // A torn final line: cut the file back to the last complete one.
      truncateSync(path, Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8"));
      truncatedTail = true;
    }
    lines = text.slice(0, lastNewline + 1).split("\n").filter((l) => l.length > 0);
  }

  let fees = options.fees;
  const header = lines.shift();
  if (header !== undefined) {
    const h = JSON.parse(header) as { format: string; version: number; params: Record<string, string>; fees: Record<string, string> };
    if (h.format !== FORMAT || h.version !== VERSION) fail("InvalidConfig", `${path} is not a v${VERSION} ${FORMAT}`);
    if (canonical(h.params) !== canonical(options.params)) {
      fail("InvalidConfig", `${path} was written with different curve parameters`);
    }
    fees = bigintRecord<FeeParams>(h.fees);
  }

  // Replay on the recorded clock, without writing anything back.
  let now = 0;
  let replaying = true;
  let fd: number | null = null;
  const liveClock = options.clock ?? Date.now;

  const engine = new Engine({
    params: options.params,
    fees,
    clock: () => (replaying ? now : liveClock()),
    onCommit: (record: ChainRecord) => {
      if (replaying) return;
      if (fd === null) fail("InvalidState", "command log is closed");
      writeSync(fd, `${canonical(record)}\n`);
      fsyncSync(fd);
    },
  });

  for (const [i, line] of lines.entries()) {
    const stored = JSON.parse(line) as { seq: number; hash: string; body: { ts: number; command: unknown } };
    now = stored.body.ts;
    let hash: string;
    try {
      hash = engine.execute(decodeCommand(stored.body.command)).hash;
    } catch (err) {
      fail("InvariantViolation", `${path}: command ${i} no longer applies (${(err as Error).message})`);
    }
    if (stored.seq !== i || hash !== stored.hash) {
      fail("InvariantViolation", `${path}: command ${i} replays to a different hash; the log was altered`);
    }
  }
  replaying = false;

  fd = openSync(path, "a");
  if (header === undefined) {
    writeSync(fd, `${canonical({ format: FORMAT, version: VERSION, params: options.params, fees: options.fees })}\n`);
    fsyncSync(fd);
  }

  return {
    engine,
    replayed: lines.length,
    truncatedTail,
    close() {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

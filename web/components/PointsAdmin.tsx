"use client";

import { useEffect, useState } from "react";
import { isAddress, zeroAddress, type Address } from "viem";
import { useWaitForTransactionReceipt } from "wagmi";
import { shortAddr } from "@/lib/format";
import {
  couponCodeHash,
  fmtPoints,
  newCouponCode,
  pointsFrom,
  type PointCounts,
  type Rates,
} from "@/lib/points";
import { usePointsAdmin, usePointsContract, useRateCard } from "@/lib/points-client";

/**
 * The owner's console for uwPoints: re-price the whole system, mint coupon codes,
 * retire them.
 *
 * Gated the way the Protocol tab is gated — by asking the contract who owns it, not
 * by hiding a route — and for the same reason: every write here reverts for anybody
 * else, so hiding the panel is a courtesy and the contract is the control.
 *
 * Two things about this panel are unusual, and both are properties of the design
 * rather than choices made here:
 *
 * 1. **Changing a rate changes every balance that already exists.** Balances are not
 *    stored; they are `rates × counts` recomputed on read (see lib/points.ts). So
 *    halving the trade rate does not halve future earnings, it halves what everyone
 *    has already earned. That is the point — it is what "editable at any time" has to
 *    mean if there is to be one kind of point rather than two — but it is not what an
 *    admin form usually does, so the panel shows the effect before it is signed.
 *
 * 2. **A coupon code exists only in this browser.** The chain stores
 *    `keccak256(code)` and nothing else, which is what stops the mempool from
 *    spending a code before its recipient does. There is no way to recover a code
 *    from its hash, so codes are generated and shown *before* the transaction is
 *    signed, and the panel will not throw a batch away for you.
 */
export function PointsAdmin() {
  const { address, configured } = usePointsContract();

  if (!configured || !address) {
    return (
      <div className="empty">
        No points contract on this network
        <div
          className="note"
          style={{ marginTop: 14, textTransform: "none", letterSpacing: 0 }}
        >
          Deploy with <code>script/DeployPoints.s.sol</code> and set{" "}
          <code>NEXT_PUBLIC_POINTS_*</code> for this chain. Until then the site scores
          activity against the fallback rates and labels them indicative.
        </div>
      </div>
    );
  }

  return (
    <div className="prot">
      <div className="sec">
        <span>uwPoints</span>
        <span className="prof-addr">{shortAddr(address)}</span>
      </div>

      <p className="note pts-note">
        Balances are <b>derived, not stored</b> — every one is{" "}
        <b>rates × on-chain activity</b>, recomputed when it is read. So a rate change
        re-prices history along with the future, and a coupon adds to a balance
        without any of the counted numbers moving.
      </p>

      <RatesPanel />
      <CouponsPanel />
      <VoidPanel />
    </div>
  );
}

/* ─── Rates ─────────────────────────────────────────────────────────────────── */

const MAX_U64 = (1n << 64n) - 1n;
const MAX_U32 = (1n << 32n) - 1n;

const RATE_FIELDS: { key: keyof Rates; label: string; note: string }[] = [
  { key: "register", label: "Registration", note: "Once, on joining the waterdrop" },
  { key: "referral", label: "Valid referral", note: "Per referral that clears the bar" },
  { key: "create", label: "Token launch", note: "Per token created" },
  { key: "swap", label: "Trade", note: "Per curve buy or sell, per swap" },
];

/**
 * A wallet to price the change against.
 *
 * Not an average and not claimed to be one — it is a yardstick, there so "referral:
 * 1,000 → 1,500" turns into a number somebody actually holds. Every field is
 * exercised so no rate can be edited without its effect appearing.
 */
const YARDSTICK: PointCounts = {
  registered: true,
  referrals: 5,
  validReferrals: 5,
  creates: 1,
  trades: 200,
};

function RatesPanel() {
  const { rates, version, onChain, refetch } = useRateCard();
  const { setRates, hash, isPending, error, reset } = usePointsAdmin();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash });

  /**
   * The edits, or null for "showing the chain".
   *
   * Null rather than a copy seeded in an effect, which is what makes the 30-second
   * refetch in `useRateCard` harmless: an untouched form has nothing to overwrite,
   * and a touched one is never re-seeded until the write lands. A form that syncs
   * from a poll deletes a character you typed a moment ago.
   */
  const [draft, setDraft] = useState<Partial<Record<keyof Rates, string>> | null>(null);

  useEffect(() => {
    if (!isSuccess) return;
    setDraft(null);
    refetch();
  }, [isSuccess, refetch]);

  const shown = (key: keyof Rates) => draft?.[key] ?? rates[key].toString();
  const parsed = (key: keyof Rates) => parseWhole(shown(key), MAX_U64);

  const next: Rates | null = RATE_FIELDS.every((f) => parsed(f.key) !== null)
    ? {
        register: parsed("register")!,
        referral: parsed("referral")!,
        create: parsed("create")!,
        swap: parsed("swap")!,
      }
    : null;

  const dirty =
    !!next && RATE_FIELDS.some((f) => next[f.key] !== rates[f.key]);

  const before = pointsFrom(YARDSTICK, rates, 0n).total;
  const after = next ? pointsFrom(YARDSTICK, next, 0n).total : before;

  return (
    <section className="pts-panel">
      <header className="pts-head">
        <span>Rates</span>
        <span className="pts-head-meta">
          {onChain ? `version ${version.toString()}` : "not read yet"}
        </span>
      </header>

      <div className="pts-grid">
        {RATE_FIELDS.map((f) => {
          const bad = parsed(f.key) === null;
          return (
            <div className="field" key={f.key}>
              <label htmlFor={`rate-${f.key}`}>{f.label}</label>
              <input
                id={`rate-${f.key}`}
                type="text"
                inputMode="numeric"
                value={shown(f.key)}
                onChange={(e) =>
                  setDraft({ ...(draft ?? {}), [f.key]: e.target.value })
                }
                aria-invalid={bad}
              />
              <p className="field-note">{bad ? "Whole number, 0 or more" : f.note}</p>
            </div>
          );
        })}
      </div>

      {/* The retroactivity, priced. Shown always rather than only when dirty, so the
          yardstick is on screen before it starts moving — a number that appears at
          the same moment it changes is a number nobody reads twice. */}
      <p className="pts-preview">
        <span className="k">
          1 registration · 5 valid referrals · 1 launch · 200 trades
        </span>
        <span className="v">
          {fmtPoints(before)}
          {dirty && (
            <>
              {" → "}
              <b>{fmtPoints(after)}</b>
            </>
          )}
        </span>
      </p>

      <div className="pts-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!dirty || isPending || mining}
          onClick={() => {
            reset();
            if (next) setRates(next);
          }}
        >
          {isPending ? "Confirm in wallet…" : mining ? "Re-pricing…" : "Set rates"}
        </button>
        {dirty && (
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            Revert
          </button>
        )}
      </div>

      <TxNote
        error={error}
        hash={hash}
        mining={mining}
        success={isSuccess}
        done="Rates updated. Every balance on the site is now priced at the new card."
      />

      <p className="field-note">
        This applies to points already earned as well as points earned from here on —
        there is one rate card, not one per era.
      </p>
    </section>
  );
}

/* ─── Coupons ───────────────────────────────────────────────────────────────── */

type Batch = {
  codes: string[];
  points: bigint;
  uses: number;
  boundTo: Address;
};

/** Codes per batch. The cap is calldata: one `issue` carries an array of hashes. */
const MAX_BATCH = 100;

function CouponsPanel() {
  const { issue, hash, isPending, error, reset } = usePointsAdmin();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash });

  const [points, setPoints] = useState("5000");
  const [count, setCount] = useState("10");
  const [uses, setUses] = useState("1");
  const [boundTo, setBoundTo] = useState("");
  const [batch, setBatch] = useState<Batch | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * The armed state of "generate again" after a batch has gone on chain.
   *
   * Regenerating before issuing costs nothing — those codes never existed anywhere.
   * Regenerating *after* issuing destroys the only copies of live secrets, and no
   * amount of care recovers them, so that one click asks twice. Only that one: a
   * confirm on the harmless case would train the reflex that skips the real one.
   */
  const [confirmNew, setConfirmNew] = useState(false);

  // Editing a field disarms the confirm. An armed destructive button that stays armed
  // across an unrelated edit is a trap: you come back to the panel, change the point
  // value, press what you think is "generate" and lose a live batch.
  useEffect(() => {
    setConfirmNew(false);
  }, [points, count, uses, boundTo]);

  const pointsN = parseWhole(points, MAX_U64);
  const countN = parseWhole(count, BigInt(MAX_BATCH));
  const usesN = parseWhole(uses, MAX_U32);
  const bound = boundTo.trim();
  const boundOk = bound === "" || isAddress(bound);

  const ready =
    pointsN !== null &&
    pointsN > 0n &&
    countN !== null &&
    countN > 0n &&
    usesN !== null &&
    usesN > 0n &&
    boundOk;

  function generate() {
    if (!ready) return;
    if (isSuccess && !confirmNew) {
      setConfirmNew(true);
      return;
    }
    reset();
    setConfirmNew(false);
    setBatch({
      codes: Array.from({ length: Number(countN) }, () => newCouponCode()),
      points: pointsN!,
      uses: Number(usesN),
      boundTo: bound === "" ? zeroAddress : (bound as Address),
    });
  }

  async function copyCodes() {
    if (!batch) return;
    try {
      await navigator.clipboard.writeText(batch.codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Blocked clipboard (insecure origin, denied permission). The codes are in a
      // textarea and the download works, so this is a shortcut, not the only way out.
    }
  }

  /**
   * The codes as a file, with their terms in the header.
   *
   * A download rather than only a clipboard because this is the sole copy of a
   * secret: a clipboard is one Ctrl-C away from being gone, and the terms matter as
   * much as the codes — a list of strings with no record of what they are worth is
   * an operational puzzle six weeks later. Lines are `#`-commented so the file can
   * be pasted straight back into the void field.
   */
  function download() {
    if (!batch) return;
    const head = [
      `# uwPoint coupons`,
      `# ${batch.points.toString()} points each · ${batch.uses} use${batch.uses === 1 ? "" : "s"} each`,
      `# ${batch.boundTo === zeroAddress ? "any wallet" : `bound to ${batch.boundTo}`}`,
      `# The chain stores only keccak256 of each code. This file cannot be regenerated.`,
      "",
    ];
    const blob = new Blob([[...head, ...batch.codes, ""].join("\n")], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uwpoints-coupons-${batch.points}x${batch.codes.length}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="pts-panel">
      <header className="pts-head">
        <span>Coupons</span>
        <span className="pts-head-meta">
          {batch ? `${batch.codes.length} generated` : "none generated"}
        </span>
      </header>

      <div className="pts-grid">
        <div className="field">
          <label htmlFor="cp-points">Points each</label>
          <input
            id="cp-points"
            type="text"
            inputMode="numeric"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            aria-invalid={pointsN === null || pointsN === 0n}
          />
          <p className="field-note">Added on redemption. Must be above zero.</p>
        </div>

        <div className="field">
          <label htmlFor="cp-count">How many codes</label>
          <input
            id="cp-count"
            type="text"
            inputMode="numeric"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            aria-invalid={countN === null || countN === 0n}
          />
          <p className="field-note">Up to {MAX_BATCH} per transaction.</p>
        </div>

        <div className="field">
          <label htmlFor="cp-uses">Uses per code</label>
          <input
            id="cp-uses"
            type="text"
            inputMode="numeric"
            value={uses}
            onChange={(e) => setUses(e.target.value)}
            aria-invalid={usesN === null || usesN === 0n}
          />
          <p className="field-note">
            One wallet per use, and no wallet twice on the same code.
          </p>
        </div>

        <div className="field">
          <label htmlFor="cp-bound">Bound to (optional)</label>
          <input
            id="cp-bound"
            type="text"
            value={boundTo}
            onChange={(e) => setBoundTo(e.target.value)}
            placeholder="0x… — blank for anyone"
            spellCheck={false}
            aria-invalid={!boundOk}
          />
          <p className="field-note">
            {boundOk ? "Only this wallet can redeem it." : "Not an address."}
          </p>
        </div>
      </div>

      {/* Front-running is not fixable inside the transaction — `issue` calldata is
          public, and a one-use unbound code can be spent by whoever reads the mempool
          first. It is fixable in the *shape* of the coupon, so the panel says which
          shape is safe rather than pretending the exposure is not there. */}
      <p className="field-note">
        {bound !== "" && boundOk
          ? "Bound: safe to publish — nobody else can spend it."
          : usesN !== null && usesN > 1n
            ? `Unbound with ${usesN} uses: a mempool watcher can take one. Fine for a crowd.`
            : "Unbound and single-use: a mempool watcher can take it before your recipient does. Bind it, or give it more uses."}
      </p>

      <div className="pts-actions">
        <button
          type="button"
          className={batch ? "btn" : "btn primary"}
          disabled={!ready || isPending || mining}
          onClick={generate}
        >
          {confirmNew
            ? "Discard those codes?"
            : batch
              ? "Generate again"
              : "Generate codes"}
        </button>
        {batch && (
          <button
            type="button"
            className="btn primary"
            disabled={isPending || mining || isSuccess}
            onClick={() => issue(batch.codes.map(couponCodeHash), batch.points, batch.uses, batch.boundTo)}
          >
            {isPending
              ? "Confirm in wallet…"
              : mining
                ? "Issuing…"
                : isSuccess
                  ? "Issued"
                  : `Issue ${batch.codes.length} code${batch.codes.length === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {batch && (
        <>
          <div className={`alert ${isSuccess ? "ok" : "info"}`}>
            <b>{isSuccess ? "Live on chain." : "Not on chain yet."}</b> These{" "}
            {batch.codes.length} code{batch.codes.length === 1 ? "" : "s"} exist only
            in this browser — the contract keeps their hashes and nothing else. Save
            them before you leave this page, because nothing here can print them
            again.
          </div>

          <textarea
            className="pts-codes"
            readOnly
            rows={Math.min(12, batch.codes.length + 1)}
            value={batch.codes.join("\n")}
            onFocus={(e) => e.currentTarget.select()}
          />

          <div className="pts-actions">
            <button type="button" className="btn" onClick={copyCodes}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="btn" onClick={download}>
              Download .txt
            </button>
            <span className="pts-terms">
              {fmtPoints(batch.points)} each · {batch.uses} use
              {batch.uses === 1 ? "" : "s"} ·{" "}
              {batch.boundTo === zeroAddress ? "any wallet" : shortAddr(batch.boundTo)}
            </span>
          </div>
        </>
      )}

      <TxNote
        error={error}
        hash={hash}
        mining={mining}
        success={isSuccess}
        done="Issued. The codes above are redeemable now."
      />
    </section>
  );
}

/* ─── Void ──────────────────────────────────────────────────────────────────── */

function VoidPanel() {
  const { voidCodes, hash, isPending, error, reset } = usePointsAdmin();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash });
  const [raw, setRaw] = useState("");

  const hashes = parseCodeList(raw);

  useEffect(() => {
    if (isSuccess) setRaw("");
  }, [isSuccess]);

  return (
    <section className="pts-panel">
      <header className="pts-head">
        <span>Retire codes</span>
        <span className="pts-head-meta">
          {hashes.length
            ? `${hashes.length} code${hashes.length === 1 ? "" : "s"}`
            : "paste below"}
        </span>
      </header>

      <textarea
        className="pts-codes"
        rows={5}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={"UW-7QK4-9ZTD-1M3X\n0x… (a hash, if the code is lost)"}
        spellCheck={false}
      />
      <p className="field-note">
        One per line. A <code>0x…</code> 32-byte value is taken as a hash and anything
        else is hashed here, so a code whose plaintext was lost can still be retired
        from the <code>CouponIssued</code> log. <code>#</code> lines are ignored, which
        is what makes a downloaded batch file paste in as-is.
      </p>

      <div className="pts-actions">
        <button
          type="button"
          className="btn"
          disabled={hashes.length === 0 || isPending || mining}
          onClick={() => {
            reset();
            voidCodes(hashes);
          }}
        >
          {isPending ? "Confirm in wallet…" : mining ? "Retiring…" : "Retire"}
        </button>
      </div>

      <TxNote
        error={error}
        hash={hash}
        mining={mining}
        success={isSuccess}
        done="Retired. Those codes cannot be redeemed, and cannot be issued again."
      />

      <p className="field-note">
        Retiring sets a code&apos;s remaining uses to zero and is not reversible: the
        contract refuses to re-issue any hash it has seen, because reviving a retired
        code would silently lock out every wallet that already redeemed it.
      </p>
    </section>
  );
}

/* ─── Shared bits ───────────────────────────────────────────────────────────── */

/**
 * The one line under every button: what the chain said, in words.
 *
 * The contract's five owner-side refusals each mean something specific, and a raw
 * `execution reverted: CouponExists()` in front of somebody halfway through a
 * campaign is not a message. Success is worth stating too — a transaction that
 * quietly succeeds leaves the owner wondering whether to sign it again.
 */
function TxNote({
  error,
  hash,
  mining,
  success,
  done,
}: {
  error: Error | null;
  hash: `0x${string}` | undefined;
  mining: boolean;
  success: boolean;
  done: string;
}) {
  if (error) return <p className="field-note red">{explainOwnerRevert(error.message)}</p>;
  if (success) return <p className="field-note gold">{done}</p>;
  if (mining && hash) return <p className="field-note">Waiting for confirmation…</p>;
  return null;
}

function explainOwnerRevert(raw: string): string {
  if (/CouponExists/.test(raw))
    return "One of those hashes has been issued before. The contract will not re-point a code that already means something — generate a fresh batch.";
  if (/ZeroPoints/.test(raw)) return "A coupon has to be worth more than zero points.";
  if (/ZeroUses/.test(raw)) return "A coupon has to have at least one use.";
  if (/NoCodes/.test(raw)) return "Nothing to send — the list was empty.";
  if (/NotOwner/.test(raw))
    return "This wallet does not own the points contract. Only the owner can write here.";
  if (/User rejected|denied/i.test(raw)) return "Cancelled in the wallet.";
  return raw.split("\n")[0];
}

/** A whole number, `0` allowed, thousands separators tolerated, capped. */
function parseWhole(s: string, max: bigint): bigint | null {
  const t = s.trim().replace(/[,\s_]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = BigInt(t);
  return n > max ? null : n;
}

/** Codes or hashes, one per line, to the hashes the contract keys on. */
function parseCodeList(raw: string): `0x${string}`[] {
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const h = /^0x[0-9a-fA-F]{64}$/.test(t)
      ? (t.toLowerCase() as `0x${string}`)
      : couponCodeHash(t);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out;
}

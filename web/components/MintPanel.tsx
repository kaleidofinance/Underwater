"use client";

import { useEffect, useMemo, useState } from "react";
import { decodeEventLog, type Address, type Hex } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { platesAbi } from "@/lib/abis";
import { PlateArt } from "@/components/PlateArt";
import { fmtEth } from "@/lib/format";
import { PLATES, type Membership, type Phase, type PlatesState } from "@/lib/plates";

/// Which entry point a mint goes through. Not a user setting — it is decided by
/// what the contract will accept from this address right now, and shown so the
/// price on the button is explainable.
type Route = "whitelist" | "public" | null;

/**
 * The mint itself.
 *
 * Everything here is derived from the contract's live state rather than
 * configured: the price, the per-transaction cap, the per-wallet cap, which of
 * the two entry points is open to this address, and how many plates are left in
 * each. That is not thoroughness for its own sake — the collection's prices and
 * limits are settable, and `_takePayment` demands *exact* payment, so a page
 * holding a stale price sends a transaction that reverts with `WrongPayment` and
 * no explanation.
 *
 * The button is therefore never a guess. If the contract would reject the mint,
 * the reason is on screen before it is signed.
 */
export function MintPanel({
  plates,
  state,
  phase,
  membership,
  onDone,
}: {
  plates: Address;
  state: PlatesState;
  phase: Phase;
  membership: Membership;
  onDone: () => void;
}) {
  const { address: account, isConnected } = useAccount();
  const [qty, setQty] = useState(1);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const {
    isLoading: mining,
    isSuccess,
    data: receipt,
  } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (isSuccess) onDone();
  }, [isSuccess, onDone]);

  const onList = membership.proof !== null && membership.rootMatches;

  // The allowlist is preferred when it is available, because it is the cheaper
  // of the two and it stays open after the public phase starts — an allowlist
  // spot is a right to the discounted price, not a race.
  const route: Route = useMemo(() => {
    const wlHeadroom = state.maxPerWallet > state.claimed;
    if (phase.wlOpen && onList && wlHeadroom) return "whitelist";
    if (phase.publicOpen) return "public";
    return null;
  }, [onList, phase.publicOpen, phase.wlOpen, state.claimed, state.maxPerWallet]);

  const unit = route === "whitelist" ? state.wlPrice : state.price;

  /**
   * The largest quantity this transaction could carry.
   *
   * Every term is a real revert in `UnderwaterPlates`, and taking the minimum is
   * what turns four separate failure modes into one number: `TooManyAtOnce`
   * (maxPerTx), `SoldOut` (supply), `WhitelistSoldOut` (the phase allocation) and
   * `WalletLimit` (per-wallet, allowlist only).
   */
  const ceiling = useMemo(() => {
    const caps = [state.maxPerTx, phase.remaining];
    if (route === "whitelist") {
      caps.push(phase.wlRemaining, state.maxPerWallet - state.claimed);
    }
    const smallest = caps.reduce((a, b) => (b < a ? b : a));
    // Clamped into a Number: every term above is bounded by the 2222 supply.
    return Math.max(0, Number(smallest < 0n ? 0n : smallest));
  }, [
    phase.remaining,
    phase.wlRemaining,
    route,
    state.claimed,
    state.maxPerTx,
    state.maxPerWallet,
  ]);

  // Clamped on read rather than corrected in an effect: `maxPerTx` can be lowered
  // by the owner and the allocation drains under whoever is sitting on the page,
  // so the ceiling moves without anyone touching the stepper.
  const want = Math.max(1, Math.min(qty, Math.max(1, ceiling)));
  const total = unit * BigInt(want);

  const busy = isPending || mining;
  const canMint = isConnected && route !== null && ceiling > 0 && !busy;

  function mint() {
    if (!account || route === null) return;
    reset();
    if (route === "whitelist") {
      writeContract({
        address: plates,
        abi: platesAbi,
        functionName: "mintWhitelist",
        args: [BigInt(want), (membership.proof ?? []) as Hex[]],
        value: total,
      });
    } else {
      writeContract({
        address: plates,
        abi: platesAbi,
        functionName: "mint",
        args: [BigInt(want)],
        value: total,
      });
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span>{route === "whitelist" ? "Allowlist mint" : "Mint"}</span>
        <span className="dim">
          {route === "whitelist" ? "your price" : "public"}
        </span>
      </div>

      <div className="field">
        <label htmlFor="qty">Plates</label>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            aria-label="One fewer"
            disabled={want <= 1 || busy}
            onClick={() => setQty(want - 1)}
            style={{ padding: "11px 14px" }}
          >
            −
          </button>
          <input
            id="qty"
            type="text"
            inputMode="numeric"
            value={String(want)}
            disabled={busy}
            style={{ textAlign: "center" }}
            onChange={(e) => {
              const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
              setQty(Number.isFinite(n) && n > 0 ? n : 1);
            }}
          />
          <button
            type="button"
            aria-label="One more"
            disabled={want >= ceiling || busy}
            onClick={() => setQty(want + 1)}
            style={{ padding: "11px 14px" }}
          >
            +
          </button>
          <button
            type="button"
            disabled={ceiling === 0 || want === ceiling || busy}
            onClick={() => setQty(ceiling)}
          >
            Max
          </button>
        </div>
        <div className="field-note">
          {ceiling === 0
            ? "Nothing available to this address right now."
            : route === "whitelist"
              ? `Up to ${ceiling} now — ${state.maxPerWallet} per address on the allowlist, ${state.claimed} already taken.`
              : `Up to ${ceiling} in one transaction.`}
        </div>
      </div>

      <dl style={{ marginBottom: 16 }}>
        <div className="r-row">
          <dt>Price each</dt>
          <dd>{unit === 0n ? "free" : `${fmtEth(unit, 6)} ETH`}</dd>
        </div>
        <div className="r-row">
          <dt>You pay</dt>
          <dd className="gold">{total === 0n ? "free" : `${fmtEth(total, 6)} ETH`}</dd>
        </div>
        {route === "whitelist" && state.price > state.wlPrice && (
          <div className="r-row">
            <dt>Public price</dt>
            <dd className="dim">{fmtEth(state.price, 6)} ETH</dd>
          </div>
        )}
      </dl>

      <Eligibility phase={phase} membership={membership} route={route} state={state} />

      {error && (
        <div className="alert" style={{ marginBottom: 14 }}>
          {explain((error as Error).message)}
        </div>
      )}

      <button
        className="primary"
        disabled={!canMint}
        onClick={mint}
        style={{ width: "100%" }}
      >
        {isPending
          ? "Confirm in wallet…"
          : mining
            ? "Minting…"
            : route === null
              ? "Not open to you yet"
              : `Mint ${want}`}
      </button>

      {!isConnected && (
        <div className="field-note" style={{ textAlign: "center", marginTop: 10 }}>
          Connect a wallet to mint
        </div>
      )}

      {receipt && <Minted plates={plates} receipt={receipt} account={account} />}

      {/* Exact payment is the reason a settable price is safe rather than
          alarming, so it is stated here — where the price is — and not only in
          the README. */}
      <p className="field-note" style={{ marginTop: 14 }}>
        Payment must be exact. If the price is re-pegged while your transaction is
        in flight it reverts and you keep your ETH — it cannot overcharge you.
      </p>
    </div>
  );
}

/**
 * Why the button says what it says.
 *
 * Each case here is a specific revert the contract would produce, named in the
 * language of the launch rather than the language of the error. The one that
 * matters most is the last: a published allowlist whose root is not the root on
 * chain is the silent failure the deploy notes warn about, and it is invisible
 * from the contract alone.
 */
function Eligibility({
  phase,
  membership,
  route,
  state,
}: {
  phase: Phase;
  membership: Membership;
  route: Route;
  state: PlatesState;
}) {
  const { isConnected } = useAccount();

  if (membership.published && !membership.rootMatches && phase.kind !== "unsealed") {
    return (
      <div className="alert" style={{ marginBottom: 14 }}>
        The published allowlist does not match the root on chain, so no proof from
        it will verify. Regenerate it with <b>script/whitelist.py</b> and call{" "}
        <b>setMerkleRoot</b> with the root it prints.
      </div>
    );
  }

  if (route === "whitelist") {
    return (
      <div className="alert ok" style={{ marginBottom: 14 }}>
        You are on the allowlist. {String(phase.wlRemaining)} of{" "}
        {String(PLATES.wlAllocation)} allowlist plates are still available.
      </div>
    );
  }

  if (route === "public") {
    // Only worth saying to someone who could have used the cheaper route and
    // cannot — either they are not on the list, or they have taken their share.
    if (membership.proof && state.claimed >= state.maxPerWallet) {
      return (
        <div className="alert" style={{ marginBottom: 14 }}>
          You have taken all {String(state.maxPerWallet)} of your allowlist plates.
          This mints at the public price.
        </div>
      );
    }
    if (membership.proof && phase.wlRemaining === 0n) {
      return (
        <div className="alert" style={{ marginBottom: 14 }}>
          The allowlist allocation is finished. The rest of the collection mints at
          the public price.
        </div>
      );
    }
    return null;
  }

  // route === null: nothing is open to this address. Say which of the reasons it
  // is, because "not open to you yet" covers four quite different situations.
  const message =
    phase.kind === "unsealed"
      ? "The trait table has not been sealed yet, so minting cannot open. Nothing is for sale."
      : phase.kind === "soldout"
        ? "Every plate is minted."
        : phase.kind === "over"
          ? "The mint window has closed."
          : !isConnected
            ? "Connect a wallet to see whether you are on the allowlist."
            : !membership.published
              ? "The allowlist phase is open, but no list has been published for this deployment yet."
              : membership.proof === null
                ? "The allowlist phase is open and this address is not on it. The public phase opens afterwards, and whatever the allowlist does not use rolls into it."
                : "The allowlist is open but this address has no plates left to take from it.";

  return (
    <div className="alert" style={{ marginBottom: 14 }}>
      {message}
    </div>
  );
}

/**
 * The plate numbers a confirmed mint produced, read out of its own receipt.
 *
 * Worth doing rather than telling someone to go and look: ids are assigned in
 * mint order inside the loop, so the only way to know which ones you got is the
 * `Transfer` logs — and before the reveal the number is all there is to know,
 * since no plate has traits until the offset is drawn.
 */
function Minted({
  plates,
  receipt,
  account,
}: {
  plates: Address;
  receipt: { logs: readonly { data: Hex; topics: readonly Hex[] }[] };
  account: Address | undefined;
}) {
  const ids = useMemo(() => {
    const out: bigint[] = [];
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: platesAbi,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
        });
        if (decoded.eventName !== "Transfer") continue;
        const args = decoded.args as unknown as { to: Address; id: bigint };
        if (!account || args.to.toLowerCase() === account.toLowerCase()) {
          out.push(args.id);
        }
      } catch {
        // Not one of ours.
      }
    }
    return out;
  }, [account, receipt.logs]);

  if (ids.length === 0) return null;

  return (
    <>
      <div className="alert ok" style={{ marginTop: 14 }}>
        Minted {ids.length === 1 ? "plate" : "plates"}{" "}
        {ids.map((id) => `#${id}`).join(", ")}. Which plate each one <i>is</i> gets
        decided at the reveal, not now.
      </div>
      {/* Capped at four. Somebody minting twenty-two does not need twenty-two
          identical sealed tubes rendered one contract call at a time. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          marginTop: 14,
          justifyContent: "center",
        }}
      >
        {ids.slice(0, 4).map((id) => (
          <PlateArt key={String(id)} plates={plates} id={id} size={88} />
        ))}
      </div>
    </>
  );
}

/**
 * A wallet error, in the launch's own words where we can recognise it.
 *
 * Only the custom errors a buyer can actually hit are translated. Anything else
 * falls through to the wallet's first line, which is more useful than a guess.
 */
function explain(message: string): string {
  const known: [string, string][] = [
    ["WrongPayment", "The price changed while this was being prepared. Reload and try again — nothing was charged."],
    ["SoldOut", "Not enough plates left for that quantity."],
    ["WhitelistSoldOut", "That would go past the allowlist allocation."],
    ["WalletLimit", "That would go past your allowlist limit."],
    ["TooManyAtOnce", "Too many plates in one transaction."],
    ["NotWhitelisted", "The proof for this address did not verify against the root on chain."],
    ["NoWhitelist", "No allowlist is configured on the collection."],
    ["PublicMintClosed", "The public phase is not open yet."],
    ["MintClosed", "The mint window has closed."],
    ["NotSealed", "The trait table has not been sealed yet."],
  ];
  for (const [error, prose] of known) {
    if (message.includes(error)) return prose;
  }
  return message.split("\n")[0];
}

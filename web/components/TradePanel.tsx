"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { maxUint256 } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { launchpadAbi, memeTokenAbi } from "@/lib/abis";
import { DEFAULT_SLIPPAGE_BPS, SlippageField } from "@/components/SlippageField";
import { fmtEth, fmtTokens, parseEthInput, withSlippage } from "@/lib/format";
import { useLaunchpad, useGraduationGas, useQuote, type Pool } from "@/lib/hooks";

/**
 * Buy and sell against the bonding curve.
 *
 * Quotes come from the contract's own `quoteBuy` / `quoteSell`, which mirror the
 * execution path exactly — including the final-buy size-down and refund — so the
 * fill shown here is the fill that happens. Selling needs an ERC20 approval to
 * the launchpad, so the panel walks that step explicitly rather than silently
 * failing.
 */
export function TradePanel({
  token,
  symbol,
  pool,
  balance,
  allowance,
  onDone,
}: {
  token: Address;
  symbol: string;
  pool: Pool;
  balance: bigint;
  allowance: bigint;
  onDone: () => void;
}) {
  const { address: launchpad } = useLaunchpad();
  const graduationGas = useGraduationGas();
  const { address: account, isConnected } = useAccount();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [raw, setRaw] = useState("");
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE_BPS);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (isSuccess) {
      setRaw("");
      onDone();
    }
  }, [isSuccess, onDone]);

  const amount = useMemo(() => {
    const parsed = parseEthInput(raw);
    if (parsed === null) return null;
    // Sell amounts are token-denominated but share the 18-decimal parser.
    return parsed;
  }, [raw]);

  const invalid = raw.trim() !== "" && amount === null;
  const overBalance = side === "sell" && amount !== null && amount > balance;
  const { quote } = useQuote(token, side, amount, !invalid && !overBalance);

  const needsApproval =
    side === "sell" && amount !== null && allowance < amount;

  const busy = isPending || mining;
  const canTrade =
    isConnected &&
    !!launchpad &&
    amount !== null &&
    amount > 0n &&
    !invalid &&
    !overBalance &&
    !!quote &&
    !busy;

  function approve() {
    if (!launchpad) return;
    reset();
    writeContract({
      address: token,
      abi: memeTokenAbi,
      functionName: "approve",
      args: [launchpad, maxUint256],
    });
  }

  function trade() {
    if (!launchpad || amount === null || !quote || !account) return;
    reset();
    if (side === "buy") {
      // A refund means this buy was trimmed to land on the threshold, which is
      // to say it is the one that seeds the pool. Send it with headroom rather
      // than the bare estimate — see useGraduationGas.
      const graduating = quote.refund > 0n;
      writeContract({
        address: launchpad,
        abi: launchpadAbi,
        functionName: "buy",
        args: [token, withSlippage(quote.out, slippage), account],
        value: amount,
        ...(graduating && graduationGas ? { gas: graduationGas } : {}),
      });
    } else {
      writeContract({
        address: launchpad,
        abi: launchpadAbi,
        functionName: "sell",
        args: [token, amount, withSlippage(quote.out, slippage), account],
      });
    }
  }

  const unit = side === "buy" ? "ETH" : symbol || "tokens";

  return (
    <div className="panel">
      <div className="tabs">
        <button data-active={side === "buy"} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button data-active={side === "sell"} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>

      <div className="field">
        <label htmlFor="amt">Amount ({unit})</label>
        <input
          id="amt"
          type="text"
          inputMode="decimal"
          value={raw}
          placeholder="0.0"
          onChange={(e) => setRaw(e.target.value)}
        />
        {side === "sell" && (
          <div
            className="field-note"
            style={{ display: "flex", justifyContent: "space-between" }}
          >
            <span>Holding {fmtTokens(balance)}</span>
            <button
              onClick={() => setRaw(fullPrecision(balance))}
              style={{
                padding: 0,
                border: "none",
                fontSize: 9,
                letterSpacing: "0.14em",
              }}
            >
              Max
            </button>
          </div>
        )}
      </div>

      <SlippageField value={slippage} onChange={setSlippage} />

      {invalid && <div className="alert">Not a valid amount.</div>}
      {overBalance && (
        <div className="alert">
          You hold {fmtTokens(balance)} {symbol}.
        </div>
      )}

      {quote && amount !== null && (
        <dl style={{ marginBottom: 16 }}>
          <div className="r-row">
            <dt>You receive</dt>
            <dd className="gold">
              {side === "buy"
                ? `${fmtTokens(quote.out)} ${symbol}`
                : `${fmtEth(quote.out, 6)} ETH`}
            </dd>
          </div>
          <div className="r-row">
            <dt>Minimum after slippage</dt>
            <dd>
              {side === "buy"
                ? fmtTokens(withSlippage(quote.out, slippage))
                : `${fmtEth(withSlippage(quote.out, slippage), 6)} ETH`}
            </dd>
          </div>
          <div className="r-row">
            <dt>Trade fee</dt>
            <dd>{fmtEth(quote.fee, 6)} ETH</dd>
          </div>
          {quote.refund > 0n && (
            <div className="r-row">
              <dt>Refunded</dt>
              <dd className="gold">{fmtEth(quote.refund, 6)} ETH</dd>
            </div>
          )}
        </dl>
      )}

      {/* The size-down is the one behaviour worth calling out before signing:
          the buy that crosses 4 ETH is trimmed to land exactly on it. */}
      {quote && quote.refund > 0n && (
        <div className="alert ok" style={{ marginBottom: 14 }}>
          This buy graduates the token. It has been trimmed to land exactly on 4
          ETH and the remainder is refunded to you in the same transaction.
        </div>
      )}

      {error && (
        <div className="alert" style={{ marginBottom: 14 }}>
          {(error as Error).message.split("\n")[0]}
        </div>
      )}

      {needsApproval ? (
        <button
          className="primary"
          disabled={!isConnected || busy}
          onClick={approve}
          style={{ width: "100%" }}
        >
          {busy ? "Approving…" : `Approve ${symbol}`}
        </button>
      ) : (
        <button
          className={side === "sell" ? "sell primary" : "primary"}
          disabled={!canTrade}
          onClick={trade}
          style={{ width: "100%" }}
        >
          {isPending
            ? "Confirm in wallet…"
            : mining
              ? "Settling…"
              : side === "buy"
                ? "Buy"
                : "Sell"}
        </button>
      )}

      {!isConnected && (
        <div className="field-note" style={{ textAlign: "center", marginTop: 10 }}>
          Connect a wallet to trade
        </div>
      )}

      {pool.graduated && (
        <div className="alert" style={{ marginTop: 14 }}>
          This curve has closed. Trading happens on the pool now.
        </div>
      )}
    </div>
  );
}

/** Exact wei → decimal string, so "Max" sells the whole balance to the wei. */
function fullPrecision(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { maxUint256 } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { DEFAULT_SLIPPAGE_BPS, SlippageField } from "@/components/SlippageField";
import { memeTokenAbi, routerAbi } from "@/lib/abis";
import { usePoolQuote } from "@/lib/dex";
import { fmtEth, fmtTokens, parseEthInput, shortAddr, withSlippage } from "@/lib/format";

/**
 * Post-graduation trading, straight through our own router.
 *
 * A graduated token no longer has a curve — the launchpad's `buy`/`sell` revert
 * with `AlreadyGraduated`. This panel is the successor: it reads the pool's
 * reserves, quotes with the router's own `getAmountsOut`, and swaps native ETH
 * against the pair the launchpad seeded.
 *
 * Router, WETH and the pair all come from `usePoolQuote`, which resolves them
 * from the launchpad's own `router()` — so this panel can never point at a
 * different DEX than the one holding the liquidity.
 */
export function PoolPanel({ token, symbol }: { token: Address; symbol: string }) {
  const { address: account, isConnected } = useAccount();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [raw, setRaw] = useState("");
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE_BPS);

  const {
    quote: pool,
    router,
    weth,
    resolving,
    refetch: refetchPool,
  } = usePoolQuote(token);
  const pair = pool?.pair;

  const { data: holdings, refetch: refetchHoldings } = useReadContracts({
    contracts: [
      {
        address: token,
        abi: memeTokenAbi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
      } as const,
      {
        address: token,
        abi: memeTokenAbi,
        functionName: "allowance",
        args: account && router ? [account, router] : undefined,
      } as const,
    ],
    query: { enabled: !!account && !!router, refetchInterval: 8_000 },
  });

  const balance = (holdings?.[0]?.result as bigint | undefined) ?? 0n;
  const allowance = (holdings?.[1]?.result as bigint | undefined) ?? 0n;

  const amount = parseEthInput(raw);
  const invalid = raw.trim() !== "" && amount === null;
  const overBalance = side === "sell" && amount !== null && amount > balance;

  const path = useMemo(() => {
    if (!weth) return undefined;
    return side === "buy" ? [weth, token] : [token, weth];
  }, [side, token, weth]);

  const { data: quoted } = useReadContract({
    address: router,
    abi: routerAbi,
    functionName: "getAmountsOut",
    args: amount !== null && amount > 0n && path ? [amount, path] : undefined,
    query: {
      enabled: !!router && !!path && amount !== null && amount > 0n && !invalid && !overBalance,
    },
  });
  const amountOut = (quoted as readonly bigint[] | undefined)?.[1];

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (isSuccess) {
      setRaw("");
      refetchPool();
      refetchHoldings();
    }
  }, [isSuccess, refetchHoldings, refetchPool]);

  const needsApproval = side === "sell" && amount !== null && allowance < amount;
  const busy = isPending || mining;
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  function approve() {
    if (!router) return;
    reset();
    writeContract({
      address: token,
      abi: memeTokenAbi,
      functionName: "approve",
      args: [router, maxUint256],
    });
  }

  function swap() {
    if (!router || !path || amount === null || amountOut === undefined || !account) return;
    reset();
    const min = withSlippage(amountOut, slippage);
    if (side === "buy") {
      writeContract({
        address: router,
        abi: routerAbi,
        functionName: "swapExactETHForTokens",
        args: [min, path, account, deadline()],
        value: amount,
      });
    } else {
      writeContract({
        address: router,
        abi: routerAbi,
        functionName: "swapExactTokensForETH",
        args: [amount, min, path, account, deadline()],
      });
    }
  }

  if (!pair) {
    return (
      <div className="panel">
        <div className="panel-head">
          <span>Pool</span>
        </div>
        {resolving ? (
          <div className="empty" style={{ padding: "24px 0" }}>
            Sounding…
          </div>
        ) : (
          <p className="note" style={{ fontSize: 12.5 }}>
            No pool found for this token on the configured router.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span>Pool — liquidity burned</span>
        <span className="dim">{shortAddr(pair)}</span>
      </div>

      <div className="tabs">
        <button data-active={side === "buy"} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button data-active={side === "sell"} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>

      <div className="field">
        <label htmlFor="pamt">Amount ({side === "buy" ? "ETH" : symbol})</label>
        <input
          id="pamt"
          type="text"
          inputMode="decimal"
          value={raw}
          placeholder="0.0"
          onChange={(e) => setRaw(e.target.value)}
        />
        {side === "sell" && (
          <div className="field-note">Holding {fmtTokens(balance)}</div>
        )}
      </div>

      <SlippageField value={slippage} onChange={setSlippage} />

      {invalid && <div className="alert">Not a valid amount.</div>}
      {overBalance && <div className="alert">More than you hold.</div>}

      {/* No reserves row here: the token's own readout panel states the pool's
          liquidity, and printing the same two numbers twice on one page is noise. */}
      {amountOut !== undefined && (
        <dl style={{ marginBottom: 16 }}>
          <div className="r-row">
            <dt>You receive</dt>
            <dd className="gold">
              {side === "buy"
                ? `${fmtTokens(amountOut)} ${symbol}`
                : `${fmtEth(amountOut, 6)} ETH`}
            </dd>
          </div>
          <div className="r-row">
            <dt>Minimum after slippage</dt>
            <dd>
              {side === "buy"
                ? `${fmtTokens(withSlippage(amountOut, slippage))} ${symbol}`
                : `${fmtEth(withSlippage(amountOut, slippage), 6)} ETH`}
            </dd>
          </div>
          <div className="r-row">
            <dt>Pool fee</dt>
            <dd>0.30% to liquidity</dd>
          </div>
        </dl>
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
          disabled={!isConnected || busy || amountOut === undefined}
          onClick={swap}
          style={{ width: "100%" }}
        >
          {isPending
            ? "Confirm in wallet…"
            : mining
              ? "Swapping…"
              : side === "buy"
                ? "Buy"
                : "Sell"}
        </button>
      )}
    </div>
  );
}

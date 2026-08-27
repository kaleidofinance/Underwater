"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { maxUint256 } from "viem";
import {
  useAccount,
  useBalance,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { DEFAULT_SLIPPAGE_BPS, spendableBasis } from "@/components/SlippageField";
import { launchpadAbi, memeTokenAbi, routerAbi } from "@/lib/abis";
import { usePoolQuote } from "@/lib/dex";
import { fullPrecision, parseEthInput, withSlippage } from "@/lib/format";
import { useGraduationGas, useLaunchpad, useQuote } from "@/lib/hooks";

/**
 * Buying and selling, as headless hooks.
 *
 * The launchpad has two venues — a live bonding curve and, once graduated, a
 * Uniswap-V2 pool — and the app shows each through two different faces: the token
 * page's compact Buy/Sell tabs and the swap page's From → To console. That is two
 * presentations over the *same* trade, so the state machine (side, amount,
 * slippage, quote, approval, write, success) lives here once and both faces read
 * it. A fix to how a fill is quoted or a graduating buy is gassed lands in one
 * place and both surfaces move together.
 *
 * These own no markup and no venue opinion beyond the contract calls — what a
 * "50%" means, which tolerances exist, how the amount is formatted are all the
 * caller's, so the two faces stay free to look nothing alike.
 */

export type Side = "buy" | "sell";

/** Selling flips buy → sell, and the amount's unit flips with it (ETH ↔ token),
 *  so a half-typed number would be reinterpreted rather than converted. Clearing
 *  is the honest reset; a pending write is abandoned with it. */
function useDirection(reset: () => void) {
  const [side, setSide] = useState<Side>("buy");
  const [raw, setRaw] = useState("");
  const flip = () => {
    setSide((s) => (s === "buy" ? "sell" : "buy"));
    setRaw("");
    reset();
  };
  return { side, setSide, raw, setRaw, flip };
}

/**
 * Trade against a live bonding curve, through the launchpad.
 *
 * Quotes are the contract's own `quoteBuy` / `quoteSell`, which mirror execution
 * including the pre-graduation size-down and refund, so the fill shown is the
 * fill that happens. The buy that crosses the threshold is sent with gas headroom
 * (see `useGraduationGas`) because its deposit takes a pricier path.
 */
export function useCurveTrade({
  token,
  balance,
  allowance,
  onDone,
}: {
  token: Address;
  balance: bigint;
  allowance: bigint;
  onDone: () => void;
}) {
  const { address: launchpad } = useLaunchpad();
  const graduationGas = useGraduationGas();
  const { address: account, isConnected } = useAccount();
  const { data: ethBal } = useBalance({ address: account });
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE_BPS);

  const { writeContract, data: hash, isPending, error, reset } =
    useWriteContract();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });
  const { side, setSide, raw, setRaw, flip } = useDirection(reset);

  useEffect(() => {
    if (isSuccess) {
      setRaw("");
      onDone();
    }
  }, [isSuccess, onDone]);

  const amount = parseEthInput(raw);
  const invalid = raw.trim() !== "" && amount === null;
  const overBalance = side === "sell" && amount !== null && amount > balance;
  const ethBalance = ethBal?.value ?? 0n;
  const pctBasis = spendableBasis(side, ethBalance, balance);
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
      // A refund means the buy was trimmed to land on the threshold — the one
      // that seeds the pool — so send it with headroom, not the bare estimate.
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

  return {
    side,
    setSide,
    flip,
    raw,
    setRaw,
    setRawExact: (wei: bigint) => setRaw(fullPrecision(wei)),
    slippage,
    setSlippage,
    amount,
    invalid,
    overBalance,
    ethBalance,
    balance,
    pctBasis,
    quote,
    estOut: quote?.out,
    minOut: quote ? withSlippage(quote.out, slippage) : undefined,
    needsApproval,
    busy,
    canTrade,
    isConnected,
    isPending,
    mining,
    error: error ? (error as Error).message.split("\n")[0] : undefined,
    approve,
    trade,
  };
}

/**
 * Trade against a graduated pool, through our router.
 *
 * The pair, router and WETH all resolve from `usePoolQuote` (which reads them off
 * the launchpad's own `router()`), the quote is the router's `getAmountsOut`, and
 * a sell needs an ERC20 approval to the router first. `pair` / `resolving` are
 * returned so a caller can render its own "no pool yet" state.
 */
export function usePoolTrade({ token }: { token: Address }) {
  const { address: account, isConnected } = useAccount();
  const { data: ethBal } = useBalance({ address: account });
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

  const { writeContract, data: hash, isPending, error, reset } =
    useWriteContract();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });
  const { side, setSide, raw, setRaw, flip } = useDirection(reset);

  const amount = parseEthInput(raw);
  const invalid = raw.trim() !== "" && amount === null;
  const overBalance = side === "sell" && amount !== null && amount > balance;
  const ethBalance = ethBal?.value ?? 0n;
  const pctBasis = spendableBasis(side, ethBalance, balance);

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
      enabled:
        !!router &&
        !!path &&
        amount !== null &&
        amount > 0n &&
        !invalid &&
        !overBalance,
    },
  });
  const amountOut = (quoted as readonly bigint[] | undefined)?.[1];

  useEffect(() => {
    if (isSuccess) {
      setRaw("");
      refetchPool();
      refetchHoldings();
    }
  }, [isSuccess, refetchHoldings, refetchPool]);

  const needsApproval =
    side === "sell" && amount !== null && allowance < amount;
  const busy = isPending || mining;
  const canSwap = isConnected && !busy && amountOut !== undefined;
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
    if (
      !router ||
      !path ||
      amount === null ||
      amountOut === undefined ||
      !account
    )
      return;
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

  return {
    side,
    setSide,
    flip,
    raw,
    setRaw,
    setRawExact: (wei: bigint) => setRaw(fullPrecision(wei)),
    slippage,
    setSlippage,
    amount,
    invalid,
    overBalance,
    ethBalance,
    balance,
    allowance,
    pctBasis,
    pair,
    resolving,
    amountOut,
    estOut: amountOut,
    minOut: amountOut !== undefined ? withSlippage(amountOut, slippage) : undefined,
    needsApproval,
    busy,
    canSwap,
    isConnected,
    isPending,
    mining,
    error: error ? (error as Error).message.split("\n")[0] : undefined,
    approve,
    swap,
  };
}

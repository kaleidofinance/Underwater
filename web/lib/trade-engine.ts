"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { usePoolQuotes } from "@/lib/dex";
import { fullPrecision, parseEthInput, withSlippage } from "@/lib/format";
import { useGraduationGas, useLaunchpad, useQuote } from "@/lib/hooks";
import { useChainRefresh } from "@/lib/refresh";

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

/**
 * Which way the trade points, and the amount that only means something alongside
 * it.
 *
 * Changing side changes the amount's *unit* (ETH ↔ token), so a half-typed number
 * would be reinterpreted rather than converted — `0.5` typed as ETH silently
 * becomes 0.5 tokens. Clearing is the honest reset, and a pending write is
 * abandoned with it, because it was priced for the other direction.
 *
 * That rule is why this hook hands back `selectSide` and *not* the raw setter.
 * It used to return `setSide`, and the token page's Buy/Sell tabs took it and
 * changed side without clearing anything, so on that page — the only place those
 * tabs are the sole way to switch — the rule was never applied at all. A bare
 * setter beside a comment describing what must happen with it is an invitation;
 * the two are now the same function, so the next tab cannot get it wrong either.
 *
 * No-ops when the side is unchanged: clicking the tab you are already on is not a
 * direction change, and wiping a typed amount for it would be its own small bug.
 *
 * `unit` is the same rule for the other way the amount's unit can move: a pool swap
 * whose counter-asset changes from ETH to a token is reinterpreting the number too,
 * and that change arrives from the page's picker rather than from a call to
 * `selectSide`, so there is nothing to hang it off and it needs an effect. A caller
 * whose counter-asset is fixed — the curve, which only trades against ETH — passes
 * nothing and it never fires.
 */
function useDirection(reset: () => void, unit?: string) {
  const [side, setSide] = useState<Side>("buy");
  const [raw, setRaw] = useState("");
  const selectSide = (next: Side) => {
    if (next === side) return;
    setSide(next);
    setRaw("");
    reset();
  };
  const flip = () => selectSide(side === "buy" ? "sell" : "buy");

  // A ref so this is a *change* rather than a mount: on the first render there is
  // nothing typed to lose, and clearing then would eat an amount deep-linked in.
  const held = useRef(unit);
  useEffect(() => {
    if (held.current === unit) return;
    held.current = unit;
    setRaw("");
    reset();
  }, [reset, unit]);

  return { side, selectSide, raw, setRaw, flip };
}

/**
 * Whether the amount is more than the wallet can pay.
 *
 * The amount is always in the unit of whatever the trade *spends*, so the balance it
 * has to fit inside is that asset's. This was `side === "sell"` against the token
 * balance alone, which left a buy for more ETH than the wallet holds with nothing to
 * say so — and because the quote is gated on this, it also meant a quote and a live
 * button for a trade that cannot pay for itself.
 *
 * `spendable` is the whole balance, deliberately *not* `spendableBasis`'s
 * gas-reserved figure. An amount above that cushion but at or below the balance is
 * money the wallet does hold, and telling somebody they have less than they do is
 * worse than letting a buy that leaves nothing for gas reach the wallet, which will
 * price it and say so itself.
 *
 * It takes the balance rather than the side because the two stopped agreeing: a pool
 * swap with a token counter spends an ERC20 on the buy side too. Deciding *which*
 * asset that is belongs to the hook that knows the route; deciding whether the
 * amount fits belongs here, once, so the curve and the pool cannot disagree about it.
 */
function overSpendable(amount: bigint | null, spendable: bigint): boolean {
  if (amount === null) return false;
  return amount > spendable;
}

/**
 * Which write is in flight, so a settled *approval* is not reported as a settled trade.
 *
 * Both engines send their approval and their trade through one `useWriteContract`, which
 * means `isSuccess` is true for either — and an approval that confirms would otherwise
 * light up a receipt saying points had been earned for a trade that has not happened yet.
 * Set at the call, read beside `isSuccess`.
 */
type Intent = "approve" | "trade" | null;

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
  const refreshChain = useChainRefresh();
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE_BPS);

  const { writeContract, data: hash, isPending, error, reset } =
    useWriteContract();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });
  const [intent, setIntent] = useState<Intent>(null);
  const { side, selectSide, raw, setRaw, flip } = useDirection(reset);

  useEffect(() => {
    if (isSuccess) {
      setRaw("");
      // The caller's own reads, plus everything else the trade moved: the ETH
      // balance in the masthead, the market list and totals, and the log scans
      // behind the feed, the chart and market volume. HeadSync covers the reads
      // on the next block anyway, but the scans are on a 15–20s timer and the
      // trade is certainly not in the last one's results.
      refreshChain();
      onDone();
    }
  }, [isSuccess, onDone, refreshChain]);

  const amount = parseEthInput(raw);
  const invalid = raw.trim() !== "" && amount === null;
  const ethBalance = ethBal?.value ?? 0n;
  // A curve has one counter-asset and it is ETH: a buy pays ETH for the token, a
  // sell pays the token for ETH. There is no third case here, unlike the pool.
  const paysWithEth = side === "buy";
  const spending = paysWithEth ? ethBalance : balance;
  const overBalance = overSpendable(amount, spending);
  const pctBasis = spendableBasis(paysWithEth, spending);
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
    setIntent("approve");
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
    setIntent("trade");
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
    selectSide,
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
    /// True once a *trade* has confirmed, for the receipt a caller renders. Stays true
    /// until the next write resets the hash, which is what makes it a receipt rather
    /// than a flash — and excludes approvals, which settle through the same hook.
    settled: isSuccess && intent === "trade",
    error: error ? (error as Error).message.split("\n")[0] : undefined,
    approve,
    trade,
  };
}

/**
 * Trade against a graduated pool, through our router.
 *
 * The pair, router and WETH all resolve from `usePoolQuotes` (which reads them off
 * the launchpad's own `router()`), the quote is the router's `getAmountsOut`, and
 * spending an ERC20 needs an approval to the router first. `pair` / `resolving` are
 * returned so a caller can render its own "no pool yet" state.
 *
 * `counter` is the other leg. Undefined means ETH, which is what this hook could
 * trade against and nothing else until now. Passing a token address routes the swap
 * through WETH instead — see `path` — and `buy` / `sell` keep meaning what they mean
 * everywhere else in the app: acquiring or disposing of `token`. That is what lets
 * the flip button and the token page's Buy/Sell tabs go on working unchanged; what
 * moves between the legs is the counter, not the subject.
 */
export function usePoolTrade({
  token,
  counter,
}: {
  token: Address;
  counter?: Address;
}) {
  const { address: account, isConnected } = useAccount();
  const { data: ethBal } = useBalance({ address: account });
  const refreshChain = useChainRefresh();
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE_BPS);

  // A token cannot be swapped for itself: there is no such pair and no path through
  // one. Read as "no counter" rather than as an error somebody has to back out of, so
  // the ETH legs stay live if a picker or a pasted address lands on the subject.
  const other =
    counter && counter.toLowerCase() !== token.toLowerCase()
      ? counter
      : undefined;

  /** Every asset either leg could hold, which is also every asset we read a balance for. */
  const legs = useMemo(
    () => (other ? [token, other] : [token]),
    [other, token],
  );

  const {
    quotes,
    router,
    weth,
    resolving,
    refetch: refetchPool,
  } = usePoolQuotes(legs);
  const pool = quotes[token.toLowerCase()];
  const pair = pool?.pair;
  // The counter's own pair, which is the second hop. A token still on its bonding
  // curve has none at all, and the router reverts on the path rather than answering
  // it — see `noRoute`.
  const counterPair = other ? quotes[other.toLowerCase()] : undefined;

  // Balances and allowances for both legs, not only the one the current side spends.
  // The side flips with no round trip behind it, and a spend gated on a balance that
  // has not been read yet reads as "you hold nothing".
  const { data: holdings, refetch: refetchHoldings } = useReadContracts({
    contracts: legs.flatMap((asset) => [
      {
        address: asset,
        abi: memeTokenAbi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
      } as const,
      {
        address: asset,
        abi: memeTokenAbi,
        functionName: "allowance",
        args: account && router ? [account, router] : undefined,
      } as const,
    ]),
    query: { enabled: !!account && !!router, refetchInterval: 8_000 },
  });

  const held = useMemo(() => {
    const out = new Map<string, { balance: bigint; allowance: bigint }>();
    legs.forEach((asset, i) => {
      out.set(asset.toLowerCase(), {
        balance: (holdings?.[i * 2]?.result as bigint | undefined) ?? 0n,
        allowance: (holdings?.[i * 2 + 1]?.result as bigint | undefined) ?? 0n,
      });
    });
    return out;
  }, [holdings, legs]);

  // The subject's, which is what the token page's "Holding" line means by it.
  const balance = held.get(token.toLowerCase())?.balance ?? 0n;
  const allowance = held.get(token.toLowerCase())?.allowance ?? 0n;

  const { writeContract, data: hash, isPending, error, reset } =
    useWriteContract();
  const { isLoading: mining, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });
  const [intent, setIntent] = useState<Intent>(null);
  const { side, selectSide, raw, setRaw, flip } = useDirection(reset, other);

  const amount = parseEthInput(raw);
  const invalid = raw.trim() !== "" && amount === null;
  const ethBalance = ethBal?.value ?? 0n;

  // What each leg actually is, once the direction is known. `undefined` is ETH on
  // both, which is the case every caller had before a counter existed.
  const inToken = side === "buy" ? other : token;
  const outToken = side === "buy" ? token : other;

  const inBalance = inToken
    ? held.get(inToken.toLowerCase())?.balance ?? 0n
    : ethBalance;
  const inAllowance = inToken
    ? held.get(inToken.toLowerCase())?.allowance ?? 0n
    : 0n;
  const overBalance = overSpendable(amount, inBalance);
  const pctBasis = spendableBasis(!inToken, inBalance);

  /**
   * The route, and why it is never longer than two hops.
   *
   * Graduation seeds a TOKEN/WETH pair and nothing in this app creates any other
   * kind, so token for token goes through WETH by construction rather than by
   * preference — there is no direct pair to look for, and `createPair` being
   * unpermissioned does not change that nothing has called it. The router has always
   * priced and executed an arbitrary path; the only thing that made this ETH-only was
   * the two addresses handed to it.
   *
   * The extra hop is not free and it compounds. 0.3% is taken *per pair*, so about
   * 0.6% over the route, and the slippage tolerance covers the whole path rather than
   * each pool — a token-for-token quote is exposed to two independent reserves moving
   * under it, not one.
   */
  const path = useMemo(() => {
    if (!weth) return undefined;
    if (!other) return side === "buy" ? [weth, token] : [token, weth];
    return side === "buy" ? [other, weth, token] : [token, weth, other];
  }, [other, side, token, weth]);

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
  // The last hop's output, read off the end of what came back rather than at a fixed
  // index. `getAmountsOut` returns one amount per address in the path, so `[1]` was
  // the answer only while every path was two long — on a two-hop route it is the
  // intermediate WETH amount, and quoting that as the fill would have shown a wildly
  // wrong number and then enforced it as `amountOutMin`.
  const amounts = quoted as readonly bigint[] | undefined;
  const amountOut = amounts?.[amounts.length - 1];

  useEffect(() => {
    if (isSuccess) {
      setRaw("");
      // See the note in useCurveTrade. This form has no `onDone` at all — the
      // swap page and the token page's pool panel both pass nothing — so before
      // this the token page's own balance never noticed a pool swap.
      refreshChain();
      refetchPool();
      refetchHoldings();
    }
  }, [isSuccess, refetchHoldings, refetchPool, refreshChain]);

  // Both hops need a pair. The subject's is what `pair` reports; the counter's is the
  // new way this can fail, and it fails silently in the router — an unpriceable path
  // just leaves `amountOut` undefined, which looks identical to a quote still in
  // flight. So it is named here and the caller can say which token has no pool.
  const noRoute = !!other && !resolving && !counterPair;

  // An ERC20 going in means an approval to the router, which now includes a *buy*:
  // with a token counter, buying the subject spends the counter. This was
  // `side === "sell"`, which is the same rule only while ETH was the one thing a buy
  // could pay with.
  const needsApproval =
    !!inToken && amount !== null && amount > 0n && inAllowance < amount;
  const busy = isPending || mining;
  // Spelled out rather than leaning on `amountOut` going undefined. The quote is
  // gated on the same two conditions, so this was already false in practice — but
  // only as a side effect of a *different* rule, and it read as if an unpayable
  // amount were fine so long as the router still answered. `canTrade` on the curve
  // states them; so does this.
  const canSwap =
    isConnected &&
    !busy &&
    !invalid &&
    !overBalance &&
    !noRoute &&
    amount !== null &&
    amount > 0n &&
    amountOut !== undefined;
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

  function approve() {
    if (!router || !inToken) return;
    reset();
    setIntent("approve");
    writeContract({
      address: inToken,
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
    setIntent("trade");
    const min = withSlippage(amountOut, slippage);
    if (!inToken) {
      writeContract({
        address: router,
        abi: routerAbi,
        functionName: "swapExactETHForTokens",
        args: [min, path, account, deadline()],
        value: amount,
      });
    } else if (!outToken) {
      writeContract({
        address: router,
        abi: routerAbi,
        functionName: "swapExactTokensForETH",
        args: [amount, min, path, account, deadline()],
      });
    } else {
      // Token for token. Not a new capability of the router — this entry point has
      // been in the shipped ABI all along and `_swap` has always walked the path —
      // only the first caller to hand it three addresses. The plain variant rather
      // than the fee-on-transfer one: these are the launchpad's own ERC20s, which
      // transfer exactly what they are told to, and this one checks `amountOutMin`
      // against the balance actually delivered.
      writeContract({
        address: router,
        abi: routerAbi,
        functionName: "swapExactTokensForTokens",
        args: [amount, min, path, account, deadline()],
      });
    }
  }

  return {
    side,
    selectSide,
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
    /** The counter as the route sees it — `undefined` once a self-pair is dropped. */
    counter: other,
    /** The balance the amount is measured against: ETH's, or the input token's. */
    inBalance,
    noRoute,
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
    /// See {@link useCurveTrade}: a settled trade, not a settled approval.
    settled: isSuccess && intent === "trade",
    error: error ? (error as Error).message.split("\n")[0] : undefined,
    approve,
    swap,
  };
}

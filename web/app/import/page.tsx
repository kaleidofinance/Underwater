"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { getAddress, isAddress, maxUint256, type Address } from "viem";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { PercentPicks, spendableBasis } from "@/components/SlippageField";
import { TokenArt } from "@/components/TokenArt";
import { memeTokenAbi, routerAbi } from "@/lib/abis";
import { chainById } from "@/lib/chains";
import { spotPriceE18 } from "@/lib/curve";
import { usePoolQuote } from "@/lib/dex";
import {
  fmtEth,
  fmtPriceGwei,
  fmtTokens,
  fullPrecision,
  parseEthInput,
  shortAddr,
} from "@/lib/format";
import { useLaunchpad } from "@/lib/hooks";
import { importOf } from "@/lib/imported";
import { useChainRefresh } from "@/lib/refresh";
import { deadline, useSend } from "@/lib/trade-engine";
import { fmtUsdPrice, useEthUsd, usdFromWei } from "@/lib/usd";
import { useWalletReady } from "@/lib/wallet-persist";

/**
 * Open a market for a token the launchpad never minted.
 *
 * Every other page here is about a launch: a curve the launchpad opened, and the pool
 * it graduates into. This one is the way in for a token that already exists somewhere
 * else on the same chain — something bridged in, deployed by hand, or launched on
 * another venue that has no depth. There is nothing to route it through until a pair
 * holds liquidity, and on our factory `createPair` takes no owner check, so anybody
 * willing to put up both sides can be the one to open it.
 *
 * The whole page is one transaction. `addLiquidityETH` creates the pair itself if it
 * does not exist (`UnderwaterRouter._addLiquidity`), so there is no separate
 * `createPair` step to get wrong, and past the approval this is a single signature.
 * What the seeder gets for it is the LP position: 0.30% of every swap through that
 * pair, and the right to withdraw. What they take on is that they *set the opening
 * price* — the first deposit's ratio is the price, with no curve and nothing to
 * arbitrage against, so a ratio typed wrong is money handed to the first buyer.
 *
 * Three things this page refuses, all of them because saying yes would produce a pool
 * that lies rather than a pool that is merely thin:
 *
 * - **Anything but 18 decimals.** Amounts here are parsed, formatted and quoted at
 *   18 throughout the app (`parseEthInput`, `fmtTokens`, the reserve arithmetic in
 *   lib/curve.ts). A 6-decimal token would trade correctly on chain and be displayed
 *   wrong by a factor of a trillion everywhere, which is worse than not listing it.
 * - **Launchpad tokens.** They graduate into a pool on their own, at a price the
 *   curve discovered. Seeding one by hand mid-curve would put a second, unrelated
 *   price beside it.
 * - **Pairs that already hold liquidity.** Then the market is open and the thing to
 *   do is trade it. Depositing into an existing pool has to match its ratio, which is
 *   a different form with different failure modes, and nothing needs it yet.
 *
 * Listing is a separate question from trading, and deliberately not asked here: see
 * lib/imported.ts. A pool opened from this page trades immediately and appears on the
 * token page of whoever pastes the address; it does not appear in the market until
 * somebody vouches for it in a commit.
 */

/**
 * What the reads say about the pasted address, and therefore which form to show.
 *
 * Only the states that need a *contract* read to reach. Whether the box holds an
 * address at all is decided from the string, before any of this, so `token` is a real
 * `Address` everywhere below rather than something every branch has to re-narrow.
 */
type Check =
  | { kind: "reading" }
  /** Nothing at this address answers the ERC-20 reads. */
  | { kind: "unreadable" }
  | { kind: "decimals"; decimals: number }
  /** One of ours. It has a curve, or a pool it graduated into. */
  | { kind: "launch" }
  /** Already paired and already holding reserves. */
  | { kind: "trading"; pair: Address }
  | {
      kind: "ok";
      name: string;
      symbol: string;
      totalSupply: bigint;
      /** An empty pair somebody created and never seeded, if there is one. */
      pair: Address | undefined;
    };

export default function ImportPage() {
  return (
    <Suspense fallback={<ImportShell />}>
      <ImportInner />
    </Suspense>
  );
}

function ImportShell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="shell">
      <Masthead />
      {children}
    </div>
  );
}

function ImportInner() {
  const { chainId, configured } = useLaunchpad();
  const params = useSearchParams();
  const linked = params.get("token");

  // Prefilled from the link, and editable after: the two entry points (the swap
  // console's "no launch at this address" and the token page's) both already know the
  // address, so arriving from either should not ask for it again.
  const [raw, setRaw] = useState(linked ?? "");

  if (!configured) {
    return (
      <ImportShell>
        <NotDeployed>
          Opening a pool needs our DEX, which arrives with the launchpad. Switch
          networks in the masthead.
        </NotDeployed>
      </ImportShell>
    );
  }

  return (
    <ImportShell>
      <div className="stack import-wrap" style={{ paddingTop: 8 }}>
        <h1 className="title">Open a pool.</h1>
        <p className="note">
          Pairs a token that already exists on{" "}
          {chainById(chainId)?.name ?? "this network"} against ETH on our DEX and
          puts the first liquidity behind it. You set the opening price, you hold
          the LP tokens, and you earn <b>0.30%</b> of every swap through the pair.
        </p>

        <div className="field">
          <label htmlFor="imp-token">Token address</label>
          <input
            id="imp-token"
            type="text"
            value={raw}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setRaw(e.target.value)}
          />
        </div>

        <Subject raw={raw} />
      </div>
    </ImportShell>
  );
}

/**
 * The pasted address, checked and then either refused or seeded.
 *
 * Split from the page so the reads are keyed on a parsed address rather than on
 * whatever is in the box: remounting on every keystroke of a half-typed address would
 * fire — and cancel — a batch per character.
 */
function Subject({ raw }: { raw: string }) {
  const trimmed = raw.trim();
  const token = isAddress(trimmed) ? getAddress(trimmed) : undefined;
  const { address: launchpad, chainId } = useLaunchpad();
  const { address: account } = useAccount();
  const ready = useWalletReady();

  const { quote, router, weth, resolving } = usePoolQuote(token, !!token);

  const { data: meta, isLoading: reading } = useReadContracts({
    contracts: [
      { address: token, abi: memeTokenAbi, functionName: "name" } as const,
      { address: token, abi: memeTokenAbi, functionName: "symbol" } as const,
      { address: token, abi: memeTokenAbi, functionName: "decimals" } as const,
      { address: token, abi: memeTokenAbi, functionName: "totalSupply" } as const,
      // Not part of the ERC-20 — this is the read that identifies one of ours, and
      // it reverts on anything else. `allowFailure` (the default) is what makes that
      // a "no" rather than a failed batch.
      { address: token, abi: memeTokenAbi, functionName: "launchpad" } as const,
    ],
    query: { enabled: !!token, staleTime: 60_000 },
  });

  const { data: mine, refetch: refetchMine } = useReadContracts({
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
    query: { enabled: !!token && !!account && !!router, refetchInterval: 8_000 },
  });

  // Both of these are about the *string*, so neither needs a read and both come
  // before one. They also narrow `token`, which is why nothing below asserts it.
  if (trimmed === "") {
    return (
      <p className="field-note">
        Paste the contract address of a token on this network. Nothing is signed
        until you have looked at what came back.
      </p>
    );
  }
  if (!token) {
    return <div className="alert">That is not a contract address.</div>;
  }

  const check = classify({ token, launchpad, meta, quote, reading, resolving, weth });

  if (check.kind === "reading") {
    return <div className="empty">Sounding…</div>;
  }

  if (check.kind === "unreadable") {
    return (
      <div className="alert">
        Nothing at {shortAddr(token)} answers as an ERC-20 on{" "}
        {chainById(chainId)?.name ?? "this network"}. Check the address, and check
        you are on the network the token lives on.
      </div>
    );
  }

  if (check.kind === "decimals") {
    return (
      <div className="alert">
        This token has {check.decimals} decimals. Every amount here — parsed,
        quoted and printed — is handled at 18, so it would trade correctly on
        chain and read wrong by a factor of 10
        <sup>{Math.abs(18 - check.decimals)}</sup> everywhere on the site. Not
        listing it is better than mispricing it.
      </div>
    );
  }

  if (check.kind === "launch") {
    return (
      <div className="alert info">
        This is a launch on underwater.fun — it has a curve, and it opens its own
        pool when that curve completes.{" "}
        <Link href={`/token/${token}`} className="link">
          Open its page →
        </Link>
      </div>
    );
  }

  if (check.kind === "trading") {
    return (
      <div className="alert ok">
        This token already has a pool with liquidity in it, at{" "}
        {shortAddr(check.pair)} — the market is open.{" "}
        <Link href={`/token/${token}`} className="link">
          Trade it →
        </Link>
      </div>
    );
  }

  return (
    <Seed
      token={token}
      chainId={chainId}
      name={check.name}
      symbol={check.symbol}
      totalSupply={check.totalSupply}
      emptyPair={check.pair}
      router={router}
      account={account}
      ready={ready}
      balance={(mine?.[0]?.result as bigint | undefined) ?? 0n}
      allowance={(mine?.[1]?.result as bigint | undefined) ?? 0n}
      onApproved={refetchMine}
    />
  );
}

/**
 * Which of the states above the reads add up to, as one pure function.
 *
 * Kept out of the component because the order matters and is easy to get wrong when
 * it is spread over six early returns: "still reading" has to beat "unreadable", or
 * the page accuses every address of not existing for the length of a round trip, and
 * "is a launch" has to beat "has an empty pair", because a launch mid-curve has no
 * pair at all and would otherwise fall through to the form.
 */
function classify({
  token,
  launchpad,
  meta,
  quote,
  reading,
  resolving,
  weth,
}: {
  token: Address;
  launchpad: Address | null;
  meta: readonly { status: "success" | "failure"; result?: unknown }[] | undefined;
  quote: { pair: Address; ethReserve: bigint; tokenReserve: bigint } | undefined;
  reading: boolean;
  resolving: boolean;
  weth: Address | undefined;
}): Check {
  // `weth` gates the pair lookup inside `usePoolQuote`, so a missing one means the
  // DEX is still resolving rather than that there is no pair.
  if (reading || resolving || !meta || !weth) return { kind: "reading" };

  const name = meta[0]?.result as string | undefined;
  const symbol = meta[1]?.result as string | undefined;
  const decimals = meta[2]?.result as number | undefined;
  const totalSupply = meta[3]?.result as bigint | undefined;
  const mintedBy = meta[4]?.result as Address | undefined;

  // Decimals and supply are the two the arithmetic needs; a token with no `name` is
  // odd but tradable, and refusing over a missing string would be pedantry.
  if (decimals === undefined || totalSupply === undefined) {
    return { kind: "unreadable" };
  }
  if (decimals !== 18) return { kind: "decimals", decimals };
  // Compared against our own launchpad, not merely non-empty: a foreign contract is
  // free to have a function called `launchpad` that answers something.
  if (
    launchpad &&
    mintedBy &&
    mintedBy.toLowerCase() === launchpad.toLowerCase()
  ) {
    return { kind: "launch" };
  }
  if (quote && quote.ethReserve > 0n && quote.tokenReserve > 0n) {
    return { kind: "trading", pair: quote.pair };
  }

  return {
    kind: "ok",
    name: name || shortAddr(token),
    symbol: symbol || "tokens",
    totalSupply,
    pair: quote?.pair,
  };
}

/**
 * The deposit: two amounts, the price they imply, and one signature.
 *
 * Both minimums are the desired amounts exactly, where every other call in the app
 * applies a slippage tolerance — and that is not an oversight, it is the point. A
 * first deposit has no ratio to match, so the router takes both amounts as given and
 * there is nothing to slip; the only way the numbers change under this transaction is
 * if somebody seeds the same pair first, in which case the router would silently
 * scale one side down to *their* price. Minimums equal to the desired amounts turn
 * that into a revert, which is the right answer: the price is the thing being set
 * here, and being talked out of it by a stranger is not a partial fill.
 */
function Seed({
  token,
  chainId,
  name,
  symbol,
  totalSupply,
  emptyPair,
  router,
  account,
  ready,
  balance,
  allowance,
  onApproved,
}: {
  token: Address;
  chainId: number;
  name: string;
  symbol: string;
  totalSupply: bigint;
  emptyPair: Address | undefined;
  router: Address | undefined;
  account: Address | undefined;
  ready: boolean;
  balance: bigint;
  allowance: bigint;
  onApproved: () => void;
}) {
  const nav = useRouter();
  const refreshChain = useChainRefresh();
  const ethUsd = useEthUsd();
  const { data: ethBal } = useBalance({ address: account });
  const ethBalance = ethBal?.value ?? 0n;
  const listing = importOf(chainId, token);

  const [tokenRaw, setTokenRaw] = useState("");
  const [ethRaw, setEthRaw] = useState("");
  const tokenWei = parseEthInput(tokenRaw);
  const ethWei = parseEthInput(ethRaw);
  const invalid =
    (tokenRaw.trim() !== "" && tokenWei === null) ||
    (ethRaw.trim() !== "" && ethWei === null);

  const tx = useSend();

  // An approval refreshes the allowance and nothing else; the deposit moved the
  // market, so it refreshes the chain and hands the reader their new pool.
  useEffect(() => {
    if (tx.settled) {
      refreshChain();
      nav.push(`/token/${token}`);
    } else if (tx.mined) {
      onApproved();
    }
  }, [tx.mined, tx.settled, nav, onApproved, refreshChain, token]);

  const overToken = tokenWei !== null && tokenWei > balance;
  const overEth = ethWei !== null && ethWei > ethBalance;
  const sized = tokenWei !== null && tokenWei > 0n && ethWei !== null && ethWei > 0n;
  const price = sized ? spotPriceE18(ethWei, tokenWei) : 0n;
  const cap = sized ? (price * totalSupply) / 10n ** 18n : 0n;

  const needsApproval = tokenWei !== null && allowance < tokenWei;
  const busy = tx.isPending || tx.mining;
  const canSeed =
    ready && !!router && !!account && sized && !invalid && !overToken && !overEth && !busy;

  function approve() {
    if (!router) return;
    tx.send("approve", {
      address: token,
      abi: memeTokenAbi,
      functionName: "approve",
      args: [router, maxUint256],
    });
  }

  function seed() {
    if (!router || !account || tokenWei === null || ethWei === null) return;
    tx.send("trade", {
      address: router,
      abi: routerAbi,
      functionName: "addLiquidityETH",
      // Minimums are the desired amounts — see the note on this component.
      args: [token, tokenWei, tokenWei, ethWei, account, deadline()],
      value: ethWei,
    });
  }

  const rate = (wei: bigint) =>
    ethUsd ? fmtUsdPrice(usdFromWei(wei, ethUsd)) : `${fmtPriceGwei(wei)} gwei`;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <span>Subject</span>
          <span className="dim">{shortAddr(token)}</span>
        </div>
        <div className="imp-subject">
          <TokenArt token={token} symbol={symbol} uri="" size={40} />
          <div style={{ minWidth: 0 }}>
            <div className="row-name">{name}</div>
            <div className="row-sub">
              {symbol} · {fmtTokens(totalSupply)} total supply
            </div>
          </div>
        </div>
        {/* What we know about this contract, which on an unlisted token is nothing.
            Not a reason to stop — but somebody about to put their own ETH behind an
            address they pasted should read it before they do, not after. */}
        <p className="field-note">
          {listing
            ? `Listed here: ${listing.note}`
            : "We have not looked at this token. Nothing about it has been checked beyond the reads above — its name and ticker are whatever the contract says, and either can be a copy of something else."}
        </p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <span>Opening liquidity</span>
          {emptyPair && <span className="dim">pair exists, empty</span>}
        </div>

        <div className="field">
          <label htmlFor="imp-tok">Amount ({symbol})</label>
          <input
            id="imp-tok"
            type="text"
            inputMode="decimal"
            value={tokenRaw}
            placeholder="0.0"
            onChange={(e) => setTokenRaw(e.target.value)}
          />
          <PercentPicks
            basis={balance}
            amount={tokenWei}
            disabled={!account || balance <= 0n}
            onPick={(wei) => setTokenRaw(fullPrecision(wei))}
            noteLabel="Holding"
            noteValue={`${fmtTokens(balance)} ${symbol}`}
          />
        </div>

        <div className="field">
          <label htmlFor="imp-eth">Amount (ETH)</label>
          <input
            id="imp-eth"
            type="text"
            inputMode="decimal"
            value={ethRaw}
            placeholder="0.0"
            onChange={(e) => setEthRaw(e.target.value)}
          />
          <PercentPicks
            // `paysWithEth`, so "100%" holds a gas cushion back — the same rule the
            // trade panels use, because "all of it" has to leave enough to sign with.
            basis={spendableBasis(true, ethBalance)}
            amount={ethWei}
            disabled={!account || ethBalance <= 0n}
            onPick={(wei) => setEthRaw(fullPrecision(wei))}
            noteLabel="Balance"
            noteValue={`${fmtEth(ethBalance, 4)} ETH`}
          />
        </div>

        {invalid && <div className="alert">Not a valid amount.</div>}
        {overToken && (
          <div className="alert">
            More {symbol} than you hold — you have {fmtTokens(balance)}.
          </div>
        )}
        {overEth && (
          <div className="alert">
            More ETH than you hold — you have {fmtEth(ethBalance, 4)}.
          </div>
        )}

        {sized && (
          <dl style={{ marginBottom: 16 }}>
            <div className="r-row">
              <dt>Opening price</dt>
              <dd className="gold">{rate(price)}</dd>
            </div>
            <div className="r-row">
              <dt>Implied market cap</dt>
              <dd>
                {fmtEth(cap, 4)} ETH
                {ethUsd && ` · ${fmtUsdPrice(usdFromWei(cap, ethUsd))}`}
              </dd>
            </div>
            <div className="r-row">
              <dt>Your share of the pool</dt>
              <dd>100% — you are the only depositor</dd>
            </div>
            <div className="r-row">
              <dt>Pool fee</dt>
              <dd>0.30% to liquidity</dd>
            </div>
          </dl>
        )}

        {tx.error && (
          <div className="alert" style={{ marginBottom: 14 }}>
            {tx.error}
          </div>
        )}

        {needsApproval ? (
          <button
            className="primary"
            disabled={!ready || busy}
            onClick={approve}
            style={{ width: "100%" }}
          >
            {busy ? "Approving…" : `Approve ${symbol}`}
          </button>
        ) : (
          <button
            className="primary"
            disabled={!canSeed}
            onClick={seed}
            style={{ width: "100%" }}
          >
            {tx.isPending
              ? "Confirm in wallet…"
              : tx.mining
                ? "Opening the pool…"
                : "Open the pool"}
          </button>
        )}

        {/* Three states, not two — see `useWalletReady`. */}
        {!ready && (
          <div
            className="field-note"
            style={{ textAlign: "center", marginTop: 10 }}
          >
            {account ? "Reconnecting your wallet…" : "Connect a wallet to continue"}
          </div>
        )}
      </div>

      <div className="panel imp-notes">
        <div className="panel-head">
          <span>What this does</span>
        </div>
        <p className="note">
          The two amounts above <b>are</b> the price: a first deposit has no ratio to
          match, so whatever you put in sets what the token is worth here, and the
          first buyer trades against it. Both minimums are sent equal to the amounts
          you entered, so if somebody opens the same pool while this is in flight the
          transaction reverts rather than depositing at their price.
        </p>
        <p className="note">
          You receive LP tokens and keep them — unlike a graduated launch, where the
          launchpad burns its own. That means the liquidity is yours to withdraw, the
          0.30% fee on every swap accrues to it, and anyone reading the token&apos;s
          page will be told both of those things about your pool.
        </p>
        <p className="note">
          It will not appear in the market. Anyone can open a pool for any address,
          including one that impersonates a token you have heard of, so a pool is
          reachable by its address from the moment it exists and listed only once we
          have looked at it.{" "}
          <Link href="/" className="link">
            Back to the market →
          </Link>
        </p>
      </div>
    </>
  );
}

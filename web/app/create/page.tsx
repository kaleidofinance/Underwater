"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { decodeEventLog } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { DEFAULT_SLIPPAGE_BPS } from "@/components/SlippageField";
import { launchpadAbi } from "@/lib/abis";
import { CURVE } from "@/lib/contracts";
import { previewBuy } from "@/lib/curve";
import { fmtEth, fmtTokens, parseEthInput, withSlippage } from "@/lib/format";
import { useLaunchpad, useLaunchpadConfig } from "@/lib/hooks";

export default function CreatePage() {
  const router = useRouter();
  const { address: launchpad, configured } = useLaunchpad();
  const { creationFee, tradeFeeBps } = useLaunchpadConfig();
  const { isConnected } = useAccount();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [metadataURI, setMetadataURI] = useState("");
  const [firstBuy, setFirstBuy] = useState("");

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: mining, data: receipt } = useWaitForTransactionReceipt({ hash });

  // Jump straight to the new token's page once the launch confirms.
  useEffect(() => {
    if (!receipt) return;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: launchpadAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "TokenCreated") {
          const args = decoded.args as unknown as { token: string };
          router.push(`/token/${args.token}`);
          return;
        }
      } catch {
        // Not one of ours — the receipt also carries ERC20 Transfer logs.
      }
    }
  }, [receipt, router]);

  const buyWei = parseEthInput(firstBuy);
  const invalidBuy = firstBuy.trim() !== "" && buyWei === null;

  // The creator's first buy runs inside `create`, against a pristine curve — so
  // it is fully predictable and we can show the exact fill before signing.
  const preview =
    buyWei && buyWei > 0n
      ? previewBuy(
          {
            ethReserve: CURVE.virtualEth,
            tokenReserve: CURVE.totalSupply,
            realEthRaised: 0n,
          },
          buyWei,
          tradeFeeBps,
          CURVE.graduationEth,
          CURVE.curveSupply,
          0n,
        )
      : null;

  const total = creationFee + (buyWei ?? 0n);
  const canSubmit =
    isConnected &&
    !!launchpad &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    !invalidBuy &&
    !isPending &&
    !mining;

  function submit() {
    if (!launchpad) return;
    reset();
    writeContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "create",
      args: [
        name.trim(),
        symbol.trim().toUpperCase(),
        metadataURI.trim(),
        // No picker here, unlike the trade panels: the token does not exist
        // until this transaction runs, so nobody can move the curve ahead of
        // the first buy and the fill shown above is the fill. The tolerance is
        // only a floor against a fee change between quoting and signing.
        preview ? withSlippage(preview.tokensOut, DEFAULT_SLIPPAGE_BPS) : 0n,
      ],
      value: total,
    });
  }

  return (
    <div className="shell" style={{ ["--t" as string]: "0.06" }}>
      <Masthead />

      {!configured ? (
        <NotDeployed />
      ) : (
        <div className="stage">
          <div className="stack">
            <h1 className="title">Launch a specimen.</h1>
            <p className="note">
              Deploys a fixed-supply token and opens its bonding curve. You
              provide <b>no liquidity</b> — the curve prices itself against a
              virtual 1 ETH reserve, so the first buyer pays a real price instead
              of dividing by zero.
            </p>

            <div className="panel">
              <div className="panel-head">
                <span>Identity</span>
                <span className="dim">permanent</span>
              </div>

              <div className="field">
                <label htmlFor="name">Name</label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  maxLength={64}
                  placeholder="Ink Squid"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="symbol">Symbol</label>
                <input
                  id="symbol"
                  type="text"
                  value={symbol}
                  maxLength={12}
                  placeholder="SQUID"
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                />
              </div>

              <div className="field">
                <label htmlFor="uri">Metadata URI</label>
                <input
                  id="uri"
                  type="text"
                  value={metadataURI}
                  placeholder="ipfs://…"
                  onChange={(e) => setMetadataURI(e.target.value)}
                />
                <div className="field-note">
                  Image and socials. Stored on the token itself and immutable
                  after launch — there is no setter.
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span>Your first buy</span>
                <span className="dim">optional</span>
              </div>
              <div className="field">
                <label htmlFor="buy">ETH</label>
                <input
                  id="buy"
                  type="text"
                  inputMode="decimal"
                  value={firstBuy}
                  placeholder="0.0"
                  onChange={(e) => setFirstBuy(e.target.value)}
                />
                <div className="field-note">
                  Executed inside the same transaction as the launch, which is
                  the only way to be first into your own token. That removes any
                  reason to snipe yourself from a second address.
                </div>
              </div>

              {invalidBuy && <div className="alert">Not a valid amount.</div>}

              {preview && (
                <dl>
                  <div className="r-row">
                    <dt>You receive</dt>
                    <dd className="gold">
                      {fmtTokens(preview.tokensOut)}{" "}
                      {symbol.trim() || "tokens"}
                    </dd>
                  </div>
                  <div className="r-row">
                    <dt>Share of supply</dt>
                    <dd>
                      {(
                        (Number(preview.tokensOut) /
                          Number(CURVE.totalSupply)) *
                        100
                      ).toFixed(2)}
                      %
                    </dd>
                  </div>
                  <div className="r-row">
                    <dt>Trade fee</dt>
                    <dd>{fmtEth(preview.fee, 6)} ETH</dd>
                  </div>
                </dl>
              )}
            </div>

            {error && (
              <div className="alert">
                {(error as Error).message.split("\n")[0]}
              </div>
            )}

            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button className="primary" disabled={!canSubmit} onClick={submit}>
                {isPending
                  ? "Confirm in wallet…"
                  : mining
                    ? "Launching…"
                    : "Launch"}
              </button>
              {!isConnected && (
                <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
                  Connect a wallet first
                </span>
              )}
            </div>
          </div>

          <aside className="stack">
            <div className="panel">
              <div className="panel-head">
                <span>Every launch, identically</span>
              </div>
              <dl>
                <div className="r-row">
                  <dt>Total supply</dt>
                  <dd>1.00B</dd>
                </div>
                <div className="r-row">
                  <dt>On the curve</dt>
                  <dd>800M</dd>
                </div>
                <div className="r-row">
                  <dt>Held for the pool</dt>
                  <dd>200M</dd>
                </div>
                <div className="r-row">
                  <dt>Opening price</dt>
                  <dd>1 gwei</dd>
                </div>
                <div className="r-row">
                  <dt>Graduation price</dt>
                  <dd className="gold">25 gwei</dd>
                </div>
                <div className="r-row">
                  <dt>Graduates at</dt>
                  <dd>4 ETH raised</dd>
                </div>
                <div className="r-row">
                  <dt>Creation fee</dt>
                  <dd>
                    {creationFee === 0n ? "free" : `${fmtEth(creationFee, 6)} ETH`}
                  </dd>
                </div>
                <div className="r-row">
                  <dt>Total to send</dt>
                  <dd className="gold">{fmtEth(total, 6)} ETH</dd>
                </div>
              </dl>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span>What you cannot do</span>
              </div>
              <p className="note" style={{ fontSize: 12.5 }}>
                The token has no owner and no mint function. You cannot pause it,
                blacklist holders, tax transfers, or mint more — supply is fixed
                at construction, and only <b>burn</b> (which spends the caller&apos;s
                own balance) can change it.
              </p>
              <p className="note" style={{ fontSize: 12.5 }}>
                At graduation the LP tokens go to a burn address. Neither you nor
                the protocol can ever withdraw that liquidity.
              </p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

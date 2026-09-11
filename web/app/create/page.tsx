"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { decodeEventLog } from "viem";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { PointsRow, usePointsFor } from "@/components/PointsCue";
import { DEFAULT_SLIPPAGE_BPS } from "@/components/SlippageField";
import { launchpadAbi, memeTokenAbi, pairLaunchpadAbi } from "@/lib/abis";
import { CURVE } from "@/lib/contracts";
import { previewBuy } from "@/lib/curve";
import { fmtEth, fmtTokens, parseEthInput, withSlippage } from "@/lib/format";
import { useLaunchpad, useLaunchpadConfig } from "@/lib/hooks";
import { fmtBytes } from "@/lib/image-fit";
import {
  type QuoteAsset,
  usePairEconomics,
  usePairLaunchpad,
  usePairLaunchpadConfig,
  useQuoteAssets,
} from "@/lib/pairs";
import { fmtPoints } from "@/lib/points";
import { fitBanner, fitLogo, uploadTokenMetadata } from "@/lib/upload";

/**
 * The largest file worth handing a canvas.
 *
 * Not the upload limit — `fitLogo` and `fitBanner` cut whatever is picked down to
 * that, and lib/upload.ts is where those numbers live and why. This is a floor
 * under the browser's patience instead: decoding a 40 megapixel export costs
 * hundreds of megabytes of bitmap and can take the tab with it, and nobody drops
 * one of those on a token logo on purpose.
 *
 * Decimal megabytes, like every other byte count on this form, so the number the
 * reader is told is the number in the source.
 */
const MAX_PICK = 40_000_000;

export default function CreatePage() {
  const router = useRouter();
  const { address: launchpad, configured } = useLaunchpad();
  const { creationFee, tradeFeeBps } = useLaunchpadConfig();
  const { address: account, isConnected } = useAccount();
  // What the launch is worth in uwPoints, straight off the points contract. Zero-valued
  // or unreadable and the whole mention disappears — see components/PointsCue.tsx.
  const earns = usePointsFor("create");

  // The paired-asset offer. ETH (quote === null) is the classic launchpad; an
  // equity routes the launch to the pair launchpad, quoted in that token. The
  // dropdown only appears where a pair launchpad is deployed with assets listed.
  const assets = useQuoteAssets();
  const { address: pairLaunchpad } = usePairLaunchpad();
  const pairCfg = usePairLaunchpadConfig();
  const [quote, setQuote] = useState<QuoteAsset | null>(null);
  const pairEcon = usePairEconomics(quote?.address);

  const isPair = quote !== null;
  const activeLaunchpad = isPair ? pairLaunchpad : launchpad;
  const activeCreationFee = isPair ? pairCfg.creationFee : creationFee;
  const activeTradeFeeBps = isPair ? pairCfg.tradeFeeBps : tradeFeeBps;
  // The unit the curve raises in: ETH, or the quote token's symbol. Quote tokens
  // are 18 decimals by contract guard, so the same parser and formatter the ETH
  // path uses are exact here — only the label changes.
  const unit = quote?.symbol ?? "ETH";

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [discord, setDiscord] = useState("");
  const [firstBuy, setFirstBuy] = useState("");

  const [logo, setLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [banner, setBanner] = useState<File | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: mining, data: receipt } = useWaitForTransactionReceipt({ hash });

  // A paired first buy is spent in the quote token, so it needs an ERC20
  // approval to the pair launchpad first — the one extra step the ETH path,
  // which sends value, never has. The allowance read and the approve write are
  // inert on the ETH path (no quote selected).
  const {
    writeContract: writeApprove,
    data: approveHash,
    isPending: approvePending,
  } = useWriteContract();
  const { isLoading: approveMining, isSuccess: approved } =
    useWaitForTransactionReceipt({ hash: approveHash });
  const { data: allowanceData, refetch: refetchAllowance } = useReadContract({
    address: quote?.address,
    abi: memeTokenAbi,
    functionName: "allowance",
    args: account && pairLaunchpad ? [account, pairLaunchpad] : undefined,
    query: { enabled: isPair && !!account && !!pairLaunchpad },
  });
  const allowance = (allowanceData as bigint | undefined) ?? 0n;
  useEffect(() => {
    if (approved) refetchAllowance();
  }, [approved, refetchAllowance]);

  // Object URLs leak until revoked. Each effect revokes the *previous* preview
  // when it changes and on unmount, so switching images never strands a blob.
  useEffect(() => () => void (logoPreview && URL.revokeObjectURL(logoPreview)), [logoPreview]);
  useEffect(() => () => void (bannerPreview && URL.revokeObjectURL(bannerPreview)), [bannerPreview]);

  /**
   * Take a picked file, resize it, and hold the *result* — not the pick.
   *
   * Resizing here rather than at submit time is what makes the tile honest: the
   * image shown, the size named under it and the bytes pinned are one file. It
   * also moves the one failure the reader can do something about to the moment
   * they are still looking at the field, instead of after the launch button.
   */
  async function pick(
    file: File | undefined,
    fit: (f: File) => Promise<File>,
    label: string,
    setFile: (f: File | null) => void,
    setPreview: (u: string | null) => void,
    setBusy: (b: boolean) => void,
  ) {
    setMediaError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMediaError(`${label} must be an image.`);
      return;
    }
    if (file.size > MAX_PICK) {
      setMediaError(`${label} must be under ${fmtBytes(MAX_PICK)}.`);
      return;
    }
    setBusy(true);
    try {
      const fitted = await fit(file);
      setFile(fitted);
      setPreview(URL.createObjectURL(fitted));
    } catch (e) {
      setMediaError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Jump straight to the new token's page once the launch confirms. The ETH
  // launchpad emits `TokenCreated`, the pair launchpad `PairTokenCreated`; both
  // carry the new token first, so either is decoded the same way.
  useEffect(() => {
    if (!receipt) return;
    for (const log of receipt.logs) {
      for (const abi of [launchpadAbi, pairLaunchpadAbi] as const) {
        try {
          const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
          if (decoded.eventName === "TokenCreated" || decoded.eventName === "PairTokenCreated") {
            const args = decoded.args as unknown as { token: string };
            router.push(`/token/${args.token}`);
            return;
          }
        } catch {
          // Not this abi's event — the receipt also carries ERC20 Transfer logs.
        }
      }
    }
  }, [receipt, router]);

  const buyWei = parseEthInput(firstBuy);
  const invalidBuy = firstBuy.trim() !== "" && buyWei === null;

  // The creator's first buy runs inside `create`, against a pristine curve — so
  // it is fully predictable and we can show the exact fill before signing. The
  // reserves it opens against are 1 ETH virtual on the ETH path, or the quote
  // asset's own virtual reserve (graduationQuote / 4) for a paired launch.
  const econReady = !isPair || pairEcon.graduationQuote > 0n;
  const preview =
    buyWei && buyWei > 0n && econReady
      ? previewBuy(
          {
            ethReserve: isPair ? pairEcon.virtualQuote : CURVE.virtualEth,
            tokenReserve: CURVE.totalSupply,
            realEthRaised: 0n,
          },
          buyWei,
          activeTradeFeeBps,
          isPair ? pairEcon.graduationQuote : CURVE.graduationEth,
          CURVE.curveSupply,
          0n,
        )
      : null;

  // A paired first buy is spent in the quote token, so it must be approved to
  // the pair launchpad before the launch can pull it.
  const needsApproval =
    isPair && buyWei !== null && buyWei > 0n && allowance < buyWei;

  // ETH sent with the transaction: the creation fee always, plus the first buy
  // only on the ETH path (a paired buy moves in the quote token, not as value).
  const total = isPair ? activeCreationFee : activeCreationFee + (buyWei ?? 0n);
  // Resizing counts as busy: it is sub-second, but a launch signed in the middle
  // of it would carry whichever file the form was still holding.
  const busy =
    logoBusy ||
    bannerBusy ||
    uploading ||
    isPending ||
    mining ||
    approvePending ||
    approveMining;
  const canSubmit =
    isConnected &&
    !!activeLaunchpad &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    !!logo &&
    !invalidBuy &&
    !busy;

  // Named under the tiles, because the file in state is the resized one — so this
  // is the weight of what will be pinned, not of what was picked.
  const pinned = [
    logo && `logo ${fmtBytes(logo.size)}`,
    banner && `banner ${fmtBytes(banner.size)}`,
  ]
    .filter((s): s is string => !!s)
    .join(" · ");

  // Approve the quote token for the paired first buy. No metadata to pin — this
  // is only the ERC20 allowance the launch will pull against.
  function approve() {
    if (!quote || !pairLaunchpad || buyWei === null || buyWei <= 0n) return;
    writeApprove({
      address: quote.address,
      abi: memeTokenAbi,
      functionName: "approve",
      args: [pairLaunchpad, buyWei],
    });
  }

  async function submit() {
    if (!activeLaunchpad || !logo) return;
    reset();
    setUploadError(null);
    setUploading(true);
    try {
      // Pin the art + metadata first; the URI it returns is what the token
      // carries forever, so the launch cannot run until this lands.
      const uri = await uploadTokenMetadata({
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: description.trim() || undefined,
        website: website.trim() || undefined,
        twitter: twitter.trim() || undefined,
        telegram: telegram.trim() || undefined,
        discord: discord.trim() || undefined,
        logo,
        banner,
      });
      // No slippage picker here, unlike the trade panels: the token does not
      // exist until this transaction runs, so nobody can move the curve ahead of
      // the first buy and the fill shown above is the fill. The tolerance is only
      // a floor against a fee change between quoting and signing.
      const minOut = preview ? withSlippage(preview.tokensOut, DEFAULT_SLIPPAGE_BPS) : 0n;
      if (isPair && quote) {
        writeContract({
          address: activeLaunchpad,
          abi: pairLaunchpadAbi,
          functionName: "create",
          args: [
            name.trim(),
            symbol.trim().toUpperCase(),
            uri,
            quote.address,
            buyWei ?? 0n,
            minOut,
          ],
          value: activeCreationFee,
        });
      } else {
        writeContract({
          address: activeLaunchpad,
          abi: launchpadAbi,
          functionName: "create",
          args: [name.trim(), symbol.trim().toUpperCase(), uri, minOut],
          value: total,
        });
      }
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="shell create-shell" style={{ ["--t" as string]: "0.06" }}>
      <Masthead />

      {!configured ? (
        <NotDeployed />
      ) : (
        <div className="stage create-stage">
          <h1 className="title">Launch a specimen.</h1>
          <p className="note create-intro">
            Deploys a fixed-supply token and opens its bonding curve. You
            provide <b>no liquidity</b> — the curve prices itself against a
            virtual 1 ETH reserve, so the first buyer pays a real price instead
            of dividing by zero.
          </p>

          <div className="stack">
            <div className="panel">
              <div className="panel-head">
                <span>Identity</span>
                <span className="dim">permanent</span>
              </div>

              <div className="up-media">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Token logo</label>
                  <Drop
                    className="up-logo"
                    preview={logoPreview}
                    busy={logoBusy}
                    accept="image/*"
                    prompt={<>Logo<br />1:1</>}
                    onFile={(f) =>
                      pick(f, fitLogo, "Logo", setLogo, setLogoPreview, setLogoBusy)
                    }
                    onClear={() => {
                      setLogo(null);
                      setLogoPreview(null);
                    }}
                  />
                </div>
                <div className="field" style={{ marginBottom: 0, flex: 1 }}>
                  <label>
                    Banner <span className="dim">optional</span>
                  </label>
                  <Drop
                    className="up-banner"
                    preview={bannerPreview}
                    busy={bannerBusy}
                    accept="image/*"
                    prompt={<>Banner · 3:1</>}
                    onFile={(f) =>
                      pick(f, fitBanner, "Banner", setBanner, setBannerPreview, setBannerBusy)
                    }
                    onClear={() => {
                      setBanner(null);
                      setBannerPreview(null);
                    }}
                  />
                </div>
              </div>
              {mediaError && <div className="alert" style={{ marginTop: 10 }}>{mediaError}</div>}
              <div className="field-note" style={{ marginTop: 8, marginBottom: 15 }}>
                PNG, JPG, GIF, or SVG. Anything large is resized in your browser
                first — drop the full-size original. Pinned to IPFS and fixed once
                the token launches.
                {pinned && (
                  <>
                    {" "}
                    <span className="dim">Pinning {pinned}.</span>
                  </>
                )}
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

              {assets.length > 0 && (
                <div className="field">
                  <label htmlFor="quote">Paired asset</label>
                  <select
                    id="quote"
                    value={quote?.address ?? "ETH"}
                    onChange={(e) =>
                      setQuote(
                        assets.find((a) => a.address === e.target.value) ?? null,
                      )
                    }
                  >
                    <option value="ETH">ETH — the classic curve</option>
                    {assets.map((a) => (
                      <option key={a.address} value={a.address}>
                        {a.symbol} — {a.name}
                      </option>
                    ))}
                  </select>
                  <div className="field-note">
                    What the curve is priced and raised in. ETH is the classic
                    launchpad; a tokenized stock pairs the curve against it — the
                    raise, graduation and pool are all denominated in that asset.
                  </div>
                </div>
              )}

              <div className="field">
                <label htmlFor="desc">
                  Description <span className="dim">optional</span>
                </label>
                <textarea
                  id="desc"
                  value={description}
                  maxLength={500}
                  rows={3}
                  placeholder="What is this token about?"
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="website">
                  Website <span className="dim">optional</span>
                </label>
                <input
                  id="website"
                  type="text"
                  value={website}
                  placeholder="underwater.fun"
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <label>
                  Socials <span className="dim">optional</span>
                </label>
                <div className="up-socials">
                  <input
                    type="text"
                    value={twitter}
                    placeholder="X / @handle"
                    aria-label="X (Twitter)"
                    onChange={(e) => setTwitter(e.target.value)}
                  />
                  <input
                    type="text"
                    value={telegram}
                    placeholder="Telegram"
                    aria-label="Telegram"
                    onChange={(e) => setTelegram(e.target.value)}
                  />
                  <input
                    type="text"
                    value={discord}
                    placeholder="Discord invite"
                    aria-label="Discord"
                    onChange={(e) => setDiscord(e.target.value)}
                  />
                </div>
                <div className="field-note">
                  A handle or a full link — both work.
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-head">
                <span>Your first buy</span>
                <span className="dim">optional</span>
              </div>
              <div className="field">
                <label htmlFor="buy">{unit}</label>
                <input
                  id="buy"
                  type="text"
                  inputMode="decimal"
                  value={firstBuy}
                  placeholder="0.0"
                  onChange={(e) => setFirstBuy(e.target.value)}
                />
                <div className="field-note">
                  Bought in the same transaction as the launch, so you are first
                  into your own token.
                  {isPair && (
                    <> Paid in {unit}, which the launch approves and pulls.</>
                  )}
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
                    <dd>
                      {fmtEth(preview.fee, 6)} {unit}
                    </dd>
                  </div>
                </dl>
              )}
            </div>

            {uploadError && <div className="alert">{uploadError}</div>}
            {error && (
              <div className="alert">
                {(error as Error).message.split("\n")[0]}
              </div>
            )}

            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              {needsApproval ? (
                // A paired first buy can't be pulled until the quote token is
                // approved, so that is the one button until it is.
                <button className="primary" disabled={!canSubmit} onClick={approve}>
                  {approvePending
                    ? "Confirm in wallet…"
                    : approveMining
                      ? `Approving ${unit}…`
                      : `Approve ${unit}`}
                </button>
              ) : (
                <button className="primary" disabled={!canSubmit} onClick={submit}>
                  {uploading
                    ? "Pinning to IPFS…"
                    : isPending
                      ? "Confirm in wallet…"
                      : mining
                        ? "Launching…"
                        : "Launch"}
                </button>
              )}
              {!isConnected && (
                <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
                  Connect a wallet first
                </span>
              )}
              {isConnected && !logo && (
                <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
                  A logo is required
                </span>
              )}
              {/* The launch page has no after-state to put a receipt in — the receipt
                  effect above pushes straight to the new token's page. So the earning is
                  named while the transaction is in flight instead, which is also the one
                  moment the reader is waiting with nothing else to read. */}
              {mining && earns.quotable && (
                <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
                  <b className="gold">+{fmtPoints(earns.points)} uwPoints</b> when it
                  confirms
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
                {/* The gwei prices are ETH-denominated micro-prices; a paired
                    curve opens at a quote-token price that does not read as a
                    round gwei, so those two rows are the ETH path's. */}
                {!isPair && (
                  <>
                    <div className="r-row">
                      <dt>Opening price</dt>
                      <dd>1 gwei</dd>
                    </div>
                    <div className="r-row">
                      <dt>Graduation price</dt>
                      <dd className="gold">25 gwei</dd>
                    </div>
                  </>
                )}
                <div className="r-row">
                  <dt>Graduates at</dt>
                  <dd>
                    {isPair
                      ? `${fmtTokens(pairEcon.graduationQuote)} ${unit} raised`
                      : "4 ETH raised"}
                  </dd>
                </div>
                <div className="r-row">
                  <dt>Creation fee</dt>
                  <dd>
                    {activeCreationFee === 0n
                      ? "free"
                      : `${fmtEth(activeCreationFee, 6)} ETH`}
                  </dd>
                </div>
                {isPair && buyWei && buyWei > 0n && (
                  <div className="r-row">
                    <dt>First buy</dt>
                    <dd>
                      {fmtEth(buyWei, 6)} {unit}
                    </dd>
                  </div>
                )}
                <div className="r-row">
                  <dt>Total to send</dt>
                  <dd className="gold">{fmtEth(total, 6)} ETH</dd>
                </div>
                {/* Sits under the cost, because it is the other side of it: what the
                    launch takes, then what it pays back. */}
                <PointsRow action="create" />
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

/**
 * A click-to-upload tile that shows the chosen image, with a corner button to
 * clear it. Kept local — it is only ever the logo or banner on this form.
 */
function Drop({
  className,
  preview,
  busy,
  accept,
  prompt,
  onFile,
  onClear,
}: {
  className: string;
  preview: string | null;
  /** Resizing the pick. The tile says so, and refuses a second one meanwhile. */
  busy: boolean;
  accept: string;
  prompt: ReactNode;
  onFile: (file: File | undefined) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`up-drop ${className}`}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={busy}
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          // Let the same file be re-picked after a clear.
          e.target.value = "";
        }}
      />
      {preview && !busy ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" />
      ) : (
        // The previous image is dropped for the moment rather than left showing,
        // since what is on screen during a resize is the file being replaced.
        <span className="up-prompt">{busy ? "Resizing…" : prompt}</span>
      )}
      {preview && !busy && (
        <button
          type="button"
          className="up-clear"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
            if (inputRef.current) inputRef.current.value = "";
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

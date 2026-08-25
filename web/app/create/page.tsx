"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { decodeEventLog } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { Masthead, NotDeployed } from "@/components/Chrome";
import { DEFAULT_SLIPPAGE_BPS } from "@/components/SlippageField";
import { launchpadAbi } from "@/lib/abis";
import { CURVE } from "@/lib/contracts";
import { previewBuy } from "@/lib/curve";
import { fmtEth, fmtTokens, parseEthInput, withSlippage } from "@/lib/format";
import { useLaunchpad, useLaunchpadConfig } from "@/lib/hooks";
import { uploadTokenMetadata } from "@/lib/upload";

const MAX_LOGO = 5 * 1024 * 1024;
const MAX_BANNER = 10 * 1024 * 1024;

export default function CreatePage() {
  const router = useRouter();
  const { address: launchpad, configured } = useLaunchpad();
  const { creationFee, tradeFeeBps } = useLaunchpadConfig();
  const { isConnected } = useAccount();

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
  const [banner, setBanner] = useState<File | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: mining, data: receipt } = useWaitForTransactionReceipt({ hash });

  // Object URLs leak until revoked. Each effect revokes the *previous* preview
  // when it changes and on unmount, so switching images never strands a blob.
  useEffect(() => () => void (logoPreview && URL.revokeObjectURL(logoPreview)), [logoPreview]);
  useEffect(() => () => void (bannerPreview && URL.revokeObjectURL(bannerPreview)), [bannerPreview]);

  function pick(
    file: File | undefined,
    max: number,
    label: string,
    setFile: (f: File | null) => void,
    setPreview: (u: string | null) => void,
  ) {
    setMediaError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMediaError(`${label} must be an image.`);
      return;
    }
    if (file.size > max) {
      setMediaError(`${label} must be under ${Math.round(max / 1024 / 1024)} MB.`);
      return;
    }
    setFile(file);
    setPreview(URL.createObjectURL(file));
  }

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
  const busy = uploading || isPending || mining;
  const canSubmit =
    isConnected &&
    !!launchpad &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    !!logo &&
    !invalidBuy &&
    !busy;

  async function submit() {
    if (!launchpad || !logo) return;
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
      writeContract({
        address: launchpad,
        abi: launchpadAbi,
        functionName: "create",
        args: [
          name.trim(),
          symbol.trim().toUpperCase(),
          uri,
          // No picker here, unlike the trade panels: the token does not exist
          // until this transaction runs, so nobody can move the curve ahead of
          // the first buy and the fill shown above is the fill. The tolerance is
          // only a floor against a fee change between quoting and signing.
          preview ? withSlippage(preview.tokensOut, DEFAULT_SLIPPAGE_BPS) : 0n,
        ],
        value: total,
      });
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
                    accept="image/*"
                    prompt={<>Logo<br />1:1</>}
                    onFile={(f) => pick(f, MAX_LOGO, "Logo", setLogo, setLogoPreview)}
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
                    accept="image/*"
                    prompt={<>Banner · 3:1</>}
                    onFile={(f) => pick(f, MAX_BANNER, "Banner", setBanner, setBannerPreview)}
                    onClear={() => {
                      setBanner(null);
                      setBannerPreview(null);
                    }}
                  />
                </div>
              </div>
              {mediaError && <div className="alert" style={{ marginTop: 10 }}>{mediaError}</div>}
              <div className="field-note" style={{ marginTop: 8, marginBottom: 15 }}>
                PNG, JPG, GIF, or SVG. Pinned to IPFS and fixed once the token
                launches.
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
                  Bought in the same transaction as the launch, so you are first
                  into your own token.
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

            {uploadError && <div className="alert">{uploadError}</div>}
            {error && (
              <div className="alert">
                {(error as Error).message.split("\n")[0]}
              </div>
            )}

            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button className="primary" disabled={!canSubmit} onClick={submit}>
                {uploading
                  ? "Pinning to IPFS…"
                  : isPending
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
              {isConnected && !logo && (
                <span className="dim" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>
                  A logo is required
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

/**
 * A click-to-upload tile that shows the chosen image, with a corner button to
 * clear it. Kept local — it is only ever the logo or banner on this form.
 */
function Drop({
  className,
  preview,
  accept,
  prompt,
  onFile,
  onClear,
}: {
  className: string;
  preview: string | null;
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
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          // Let the same file be re-picked after a clear.
          e.target.value = "";
        }}
      />
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" />
      ) : (
        <span className="up-prompt">{prompt}</span>
      )}
      {preview && (
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

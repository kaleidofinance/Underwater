"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ZecAvatar } from "@/components/zec/ZecBits";
import { zecSigned } from "@/lib/zec/api";
import { IMAGE_ACCEPT, fitImage, uploadImage } from "@/lib/zec/image";
import { creatorCut, fmtZec, parseZec } from "@/lib/zec/format";
import { useZecKey, useZecMe, useZecStats, zecKeys } from "@/lib/zec/hooks";

/** The engine's creation fee, mirrored for display; the server enforces the real one. */
const CREATION_FEE = 100_000n;

export default function ZecCreate() {
  const router = useRouter();
  const qc = useQueryClient();
  const key = useZecKey();
  const me = useZecMe(key);
  const cut = creatorCut(useZecStats().data?.fees);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  /** The uploaded image's metadataURI, once the upload has landed. */
  const [image, setImage] = useState("");
  /** A local object URL for the preview, so it shows before the upload finishes. */
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [firstBuy, setFirstBuy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buy = firstBuy.trim() === "" ? 0n : parseZec(firstBuy);
  const total = buy === null ? null : CREATION_FEE + buy;
  const balance = BigInt(me.data?.balance ?? "0");
  const ready = name.trim() !== "" && symbol.trim() !== "" && total !== null && !uploading && total <= balance;

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  async function pick(file: File | undefined) {
    setImage("");
    setImageError(null);
    setPreview(null);
    if (!file) return;
    setUploading(true);
    try {
      const fitted = await fitImage(file);
      setPreview(URL.createObjectURL(fitted));
      setImage(await uploadImage(fitted));
    } catch (err) {
      setPreview(null);
      setImageError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function launch() {
    if (!ready || total === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await zecSigned<{ token: string }>("POST", "/api/tokens", {
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        metadataURI: image,
        value: total.toString(),
      });
      void qc.invalidateQueries({ queryKey: zecKeys.all });
      router.push(`/token/${r.token}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="panel zec-narrow">
      <div className="panel-head">Launch a token on Zcash</div>
      <p className="note">
        Instant and gas-free: it's live the moment you press launch. 1B supply, 800M on the bonding curve. At 6 ZEC raised it
        graduates to a locked pool.
      </p>
      {cut && (
        <p className="note">
          <b>You earn {cut} of every trade</b> on your token while it&apos;s on the curve, paid straight into your balance.
          It&apos;s yours to trade or withdraw like any other ZEC.
        </p>
      )}

      <div className="zec-create-preview">
        <ZecAvatar token={{ id: name + symbol, symbol: symbol || "?", metadataURI: image }} src={preview} size={56} />
        <div>
          <div className="row-name">{name || "Token name"}</div>
          <div className="row-sub">{(symbol || "TICKER").toUpperCase()}</div>
        </div>
      </div>

      <label className="field">
        <span>Name</span>
        <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Pepe on Zcash" />
      </label>
      <label className="field">
        <span>Ticker</span>
        <input value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value)} placeholder="ZPEPE" />
      </label>
      <label className="field">
        <span>Image (optional)</span>
        <input
          type="file"
          accept={IMAGE_ACCEPT}
          disabled={uploading || !key}
          onChange={(e) => void pick(e.target.files?.[0])}
          aria-invalid={imageError !== null}
        />
      </label>
      <div className="field-note">
        {uploading
          ? "Uploading…"
          : imageError ?? "PNG, JPG, WebP or GIF. Stills are resized to 512 px, and photo location data is stripped."}
      </div>
      <label className="field">
        <span>Your first buy, in ZEC (optional)</span>
        <input inputMode="decimal" value={firstBuy} onChange={(e) => setFirstBuy(e.target.value)} placeholder="0.0" aria-invalid={buy === null} />
      </label>
      <div className="field-note">
        Buying at launch is the only way to be first in; nobody can snipe your own token ahead of you.
      </div>

      <div className="zec-quote">
        <div>
          Creation fee <b>{fmtZec(CREATION_FEE)} ZEC</b>
          {buy !== null && buy > 0n && (
            <>
              {" "}
              + first buy <b>{fmtZec(buy)} ZEC</b>
            </>
          )}
        </div>
        <div className="dim">Balance {fmtZec(balance)} ZEC</div>
      </div>

      {!me.data || balance < CREATION_FEE ? (
        <div className="note">
          <Link href="/account" className="link">
            Deposit ZEC
          </Link>{" "}
          to launch.
        </div>
      ) : total !== null && total > balance ? (
        <div className="alert">That's more than your balance.</div>
      ) : null}
      {error && <div className="alert">{error}</div>}

      <button type="button" className="btn primary" disabled={!ready || busy} onClick={launch}>
        {busy ? "Launching…" : "Launch"}
      </button>
    </div>
  );
}

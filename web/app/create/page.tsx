"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ZecAvatar } from "@/components/zec/ZecBits";
import { zecSigned } from "@/lib/zec/api";
import { fmtZec, parseZec } from "@/lib/zec/format";
import { useZecKey, useZecMe, zecKeys } from "@/lib/zec/hooks";

/** The engine's creation fee, mirrored for display; the server enforces the real one. */
const CREATION_FEE = 100_000n;

export default function ZecCreate() {
  const router = useRouter();
  const qc = useQueryClient();
  const key = useZecKey();
  const me = useZecMe(key);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [firstBuy, setFirstBuy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buy = firstBuy.trim() === "" ? 0n : parseZec(firstBuy);
  const total = buy === null ? null : CREATION_FEE + buy;
  const balance = BigInt(me.data?.balance ?? "0");
  const imageOk = image.trim() === "" || /^https?:\/\/\S+$/.test(image.trim());
  const ready = name.trim() !== "" && symbol.trim() !== "" && total !== null && imageOk && total <= balance;

  async function launch() {
    if (!ready || total === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await zecSigned<{ token: string }>("POST", "/api/tokens", {
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        metadataURI: image.trim(),
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

      <div className="zec-create-preview">
        <ZecAvatar token={{ id: name + symbol, symbol: symbol || "?", metadataURI: imageOk ? image.trim() : "" }} size={56} />
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
        <span>Image URL (optional)</span>
        <input value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…" aria-invalid={!imageOk} />
      </label>
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

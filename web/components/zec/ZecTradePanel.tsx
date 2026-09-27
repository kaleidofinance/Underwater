"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Seg } from "@/components/Seg";
import { zecGet, zecSigned, type ZecMe, type ZecQuote, type ZecTokenDetail } from "@/lib/zec/api";
import { fmtTokenAmount, fmtZec, parseTokenAmount, parseZec, tokenAmountExact, withSlippage } from "@/lib/zec/format";
import { zecKeys } from "@/lib/zec/hooks";

type Side = "buy" | "sell";
const SLIPPAGE: readonly (readonly [string, string])[] = [
  ["50", "0.5%"],
  ["100", "1%"],
  ["300", "3%"],
  ["1000", "10%"],
];

/** Buy with ZEC or sell for ZEC, instantly: the curve before graduation, the pool after. */
export function ZecTradePanel({ token, me }: { token: ZecTokenDetail; me: ZecMe | undefined }) {
  const qc = useQueryClient();
  const [side, setSide] = useState<Side>("buy");
  const [raw, setRaw] = useState("");
  const [slip, setSlip] = useState("100");
  const [quote, setQuote] = useState<ZecQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const amount = side === "buy" ? parseZec(raw) : parseTokenAmount(raw);
  const held = BigInt(me?.holdings.find((h) => h.token === token.id)?.amount ?? "0");
  const balance = BigInt(me?.balance ?? "0");
  const over = amount !== null && (side === "buy" ? amount > balance : amount > held);

  // Quote as you type, a quarter-second after you stop.
  useEffect(() => {
    setQuote(null);
    if (amount === null || amount === 0n) return;
    let live = true;
    const t = setTimeout(() => {
      zecGet<ZecQuote>(`/api/quote?token=${token.id}&side=${side}&amount=${amount}`)
        .then((q) => live && setQuote(q))
        .catch(() => live && setQuote(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [amount, side, token.id, token.priceX18]);

  async function submit() {
    if (amount === null || amount === 0n || !quote) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const minOut = withSlippage(BigInt(quote.out), Number(slip));
      const r = await zecSigned<{ out: string; venue: string; graduated: boolean }>("POST", "/api/trade", {
        token: token.id,
        side,
        amount: amount.toString(),
        minOut: minOut.toString(),
      });
      setDone(
        side === "buy"
          ? `Bought ${fmtTokenAmount(r.out)} ${token.symbol}${r.graduated && !token.graduated ? " — and it graduated!" : ""}`
          : `Sold for ${fmtZec(r.out)} ZEC`,
      );
      setRaw("");
      void qc.invalidateQueries({ queryKey: zecKeys.all });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!me) {
    return (
      <div className="panel">
        <div className="panel-head">Trade</div>
        <div className="note">
          <Link href="/account" className="link">
            Deposit ZEC
          </Link>{" "}
          to start trading. Your account is made in this browser automatically.
        </div>
      </div>
    );
  }

  return (
    <div className="panel zec-trade-panel">
      <div className="panel-head">
        <Seg<Side>
          value={side}
          onChange={(s) => {
            setSide(s);
            setRaw("");
          }}
          label="Side"
          options={[
            ["buy", "Buy"],
            ["sell", "Sell"],
          ]}
        />
        <span className="dim">{token.graduated ? "on the pool" : "on the curve"}</span>
      </div>

      <label className="field">
        <span>{side === "buy" ? "You pay (ZEC)" : `You sell (${token.symbol})`}</span>
        <input
          inputMode="decimal"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="0.0"
          aria-invalid={over || (raw !== "" && amount === null)}
        />
      </label>
      <div className="field-note">
        {side === "buy" ? `Balance ${fmtZec(balance)} ZEC` : `Holding ${fmtTokenAmount(held)} ${token.symbol}`}
        {side === "sell" && held > 0n && (
          <button type="button" className="link" onClick={() => setRaw(tokenAmountExact(held))}>
            {" "}
            max
          </button>
        )}
      </div>

      <div className="zec-quote">
        {quote ? (
          <>
            <div>
              You get ≈{" "}
              <b>{side === "buy" ? `${fmtTokenAmount(quote.out)} ${token.symbol}` : `${fmtZec(quote.out)} ZEC`}</b>
            </div>
            {quote.fee !== "0" && <div className="dim">fee {fmtZec(quote.fee)} ZEC</div>}
            {quote.refund !== "0" && <div className="dim">this buy graduates the token; {fmtZec(quote.refund)} ZEC comes back</div>}
          </>
        ) : (
          <span className="dim">Enter an amount for a quote</span>
        )}
      </div>

      <div className="field-note">
        Slippage <Seg value={slip} onChange={setSlip} label="Slippage" options={SLIPPAGE} />
      </div>

      {over && <div className="alert">That's more than you have.</div>}
      {error && <div className="alert">{error}</div>}
      {done && <div className="note ok">{done}</div>}

      <button type="button" className="btn primary" disabled={busy || !quote || over} onClick={submit}>
        {busy ? "Trading…" : side === "buy" ? `Buy ${token.symbol}` : `Sell ${token.symbol}`}
      </button>
    </div>
  );
}

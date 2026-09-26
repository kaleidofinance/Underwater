"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { zecSigned } from "@/lib/zec/api";
import { fmtTokenAmount, fmtZec, parseZec, shortId } from "@/lib/zec/format";
import { useZecKey, useZecMe, zecKeys } from "@/lib/zec/hooks";
import { exportBackup, importBackup } from "@/lib/zec/key";
import { ZecSolvency } from "@/components/zec/ZecSolvency";

/** Local dev against `node zec/server/main.ts --sim` only: the server refuses the faucet otherwise. */
const SIM = process.env.NEXT_PUBLIC_ZEC_SIM === "1";

export default function ZecAccount() {
  const qc = useQueryClient();
  const key = useZecKey();
  const me = useZecMe(key);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [backup, setBackup] = useState<string | null>(null);
  const [restore, setRestore] = useState("");

  const refresh = () => void qc.invalidateQueries({ queryKey: zecKeys.all });
  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const m = me.data;
  const withdrawAmount = parseZec(amount);
  const withdrawable = BigInt(m?.withdrawable ?? "0");
  const fee = BigInt(m?.withdrawalFee ?? "0");

  if (!key) return <div className="empty">Making your account key…</div>;
  if (me.error) return <div className="empty">Can't reach the ZEC engine: {(me.error as Error).message}</div>;
  if (!m) return <div className="empty">Sounding…</div>;

  return (
    <div className="zec-account">
      <div className="stats">
        <div className="stat">
          <div className="k">Balance</div>
          <div className="v">{fmtZec(m.balance)} ZEC</div>
        </div>
        <div className="stat">
          <div className="k">Withdrawable</div>
          <div className="v">{fmtZec(m.withdrawable)} ZEC</div>
          {BigInt(m.immature) > 0n && <div className="stat-sub">{fmtZec(m.immature)} ZEC confirming (10 needed)</div>}
        </div>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="panel">
        <div className="panel-head">Deposit</div>
        {m.depositAddress ? (
          <>
            <p className="note">
              Send ZEC to your own address below from any wallet or exchange. It's tradable after 3 confirmations (~4 min)
              and withdrawable after 10.
            </p>
            <div className="zec-mono">{m.depositAddress}</div>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(m.depositAddress ?? "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy address"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null}
            onClick={() => act("address", async () => void (await zecSigned("POST", "/api/me/address")))}
          >
            {busy === "address" ? "Making your address…" : "Get my deposit address"}
          </button>
        )}
        {SIM && (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => act("faucet", async () => void (await zecSigned("POST", "/api/dev/faucet", { amount: "500000000" })))}
          >
            {busy === "faucet" ? "Minting…" : "Get 5 test ZEC (sim)"}
          </button>
        )}
      </div>

      <ZecSolvency hasBalance={BigInt(m.balance) > 0n || m.withdrawals.some((w) => w.state === "requested" || w.state === "submitted")} />

      <div className="panel">
        <div className="panel-head">Holdings</div>
        {m.holdings.length === 0 ? (
          <div className="empty">
            Nothing yet. <Link href="/zec" className="link">Find something to buy</Link>
          </div>
        ) : (
          m.holdings.map((h) => (
            <Link key={h.token} href={`/zec/token/${h.token}`} className="r-row zec-holding">
              <span className="row-name">{h.symbol}</span>
              <span className="num">{fmtTokenAmount(h.amount)}</span>
            </Link>
          ))
        )}
      </div>

      <div className="panel">
        <div className="panel-head">Withdraw</div>
        <label className="field">
          <span>To (Zcash address)</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="u1… / zs1… / t1…" spellCheck={false} />
        </label>
        <label className="field">
          <span>Amount (ZEC)</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
        </label>
        <div className="field-note">
          Fee {fmtZec(fee)} ZEC · up to {fmtZec(withdrawable > fee ? withdrawable - fee : 0n)} ZEC available ·{" "}
          {fmtZec(m.withdrawalLimit.remaining)} of {fmtZec(m.withdrawalLimit.limit)} ZEC daily limit left · sent in the next
          batch, final after 10 confirmations
        </div>
        {sent && <div className="note ok">{sent}</div>}
        <button
          type="button"
          className="btn primary"
          disabled={busy !== null || !to.trim() || withdrawAmount === null || withdrawAmount === 0n}
          onClick={() =>
            act("withdraw", async () => {
              const r = await zecSigned<{ withdrawalId: string }>("POST", "/api/withdrawals", {
                address: to.trim(),
                amount: (withdrawAmount ?? 0n).toString(),
              });
              setSent(`Withdrawal ${shortId(r.withdrawalId, 4)} queued`);
              setAmount("");
            })
          }
        >
          {busy === "withdraw" ? "Queuing…" : "Withdraw"}
        </button>
      </div>

      <div className="panel">
        <div className="panel-head">History</div>
        {m.deposits.length + m.withdrawals.length === 0 ? (
          <div className="empty">No deposits or withdrawals yet.</div>
        ) : (
          <>
            {m.deposits.map((d) => (
              <div key={d.id} className="r-row">
                <span className="ok">deposit</span>
                <span className="num">{fmtZec(d.amount)} ZEC</span>
                <span className="dim">{d.reversed ? "reversed (reorg)" : d.mature ? "final" : "confirming"}</span>
              </div>
            ))}
            {m.withdrawals.map((w) => (
              <div key={w.id} className="r-row">
                <span className="sell-text">withdrawal</span>
                <span className="num">{fmtZec(w.amount)} ZEC</span>
                <span className="dim">
                  {w.state}
                  {w.txid ? ` · ${shortId(w.txid, 6)}` : ""}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">Your key</div>
        <p className="note">
          Your account is a key kept in this browser, and there's no password. <b>Save the backup</b>: it's the only way to
          get this account back on another device, or after clearing this browser.
        </p>
        <div className="dim">Account {m.account}</div>
        {backup ? (
          <div className="zec-mono">{backup}</div>
        ) : (
          <button type="button" className="btn" onClick={() => void exportBackup().then(setBackup)}>
            Show backup
          </button>
        )}
        <label className="field">
          <span>Restore from a backup</span>
          <input value={restore} onChange={(e) => setRestore(e.target.value)} placeholder="uwzec1:…" spellCheck={false} />
        </label>
        <button
          type="button"
          className="btn"
          disabled={!restore.trim() || busy !== null}
          onClick={() =>
            act("restore", async () => {
              await importBackup(restore);
              window.location.reload();
            })
          }
        >
          Restore
        </button>
      </div>
    </div>
  );
}

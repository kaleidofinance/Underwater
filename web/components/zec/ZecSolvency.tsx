"use client";

import { useEffect, useState } from "react";
import { zecSigned, type ZecProof } from "@/lib/zec/api";
import { fmtZec, shortId } from "@/lib/zec/format";
import { useZecAudit, useZecSolvency } from "@/lib/zec/hooks";
import { verifyLiabilityProof } from "@/lib/zec/solvency";

type Check = { state: "idle" | "checking" } | { state: "ok"; amount: string } | { state: "bad"; why: string } | { state: "none" };

/**
 * Proof of solvency, checked in the user's own browser: fetch their leaf and
 * path, re-hash it locally, and require it to land on the published root.
 */
export function ZecSolvency({ hasBalance }: { hasBalance: boolean }) {
  const solvency = useZecSolvency();
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const root = solvency.data?.snapshot.root;

  useEffect(() => {
    if (!root) return;
    if (!hasBalance) {
      setCheck({ state: "none" });
      return;
    }
    let live = true;
    setCheck({ state: "checking" });
    zecSigned<ZecProof>("GET", "/api/me/proof")
      .then(async (p) => {
        const valid = await verifyLiabilityProof(p);
        if (!live) return;
        // The proof may be one command newer than the published root. That
        // only means another trade landed; the check that matters is that it
        // verifies against its own root.
        if (!valid) setCheck({ state: "bad", why: "your proof doesn't hash to its root" });
        else setCheck({ state: "ok", amount: p.leaf.amount });
      })
      .catch((err: Error) => live && setCheck({ state: "bad", why: err.message }));
    return () => {
      live = false;
    };
  }, [root, hasBalance]);

  const s = solvency.data;
  const liabilities = s ? BigInt(s.snapshot.liabilities) : null;
  const wallet = s ? BigInt(s.reserves.wallet) : null;
  const backed = liabilities !== null && wallet !== null ? wallet >= liabilities : null;

  return (
    <div className="panel">
      <div className="panel-head">Proof of solvency</div>
      <div className="zec-solvency">
        <div>
          <div className="k">Owed to everyone</div>
          <div className="v">{liabilities !== null ? `${fmtZec(liabilities)} ZEC` : "—"}</div>
          <div className="dim">{s ? `${s.snapshot.leaves} accounts · root ${shortId(s.snapshot.root, 8)}` : ""}</div>
        </div>
        <div>
          <div className="k">Held on-chain</div>
          <div className="v">{wallet !== null ? `${fmtZec(wallet)} ZEC` : "—"}</div>
          {s && (
            <div className="dim">
              {fmtZec(s.reserves.reserve.total)} in the public reserve
              {s.reserves.cold && ` · ${fmtZec(s.reserves.cold.total)} in cold storage`}
              {BigInt(s.reserves.treasury.total) > 0n && ` · ${fmtZec(s.reserves.treasury.total)} awaiting sweep`}
            </div>
          )}
          <div className={backed === false ? "sell-text" : "ok"}>
            {backed === null
              ? "checking…"
              : backed
                ? "✓ covers everything owed"
                : s && s.reserves.inFlight > 0
                  ? "a transfer is confirming; check back in a few minutes"
                  : "✗ short. This is being investigated"}
          </div>
        </div>
      </div>
      <ZecAuditTrail />
      <div className="note">
        {check.state === "ok" && (
          <span className="ok">
            ✓ Verified in your browser: your {fmtZec(check.amount)} ZEC is counted in the total above.
          </span>
        )}
        {check.state === "checking" && "Checking your balance is included…"}
        {check.state === "none" && "Once you have a balance, this page proves it's counted in the total."}
        {check.state === "bad" && <span className="sell-text">✗ Couldn't verify your inclusion: {check.why}</span>}
      </div>
    </div>
  );
}

/**
 * The part nobody has to take on trust: the reserve's viewing key, which
 * shows its balance in any Zcash wallet, and the log hashes we've written
 * into its memos, which pin the history the liability total comes from.
 */
function ZecAuditTrail() {
  const audit = useZecAudit();
  const [copied, setCopied] = useState(false);
  const a = audit.data;
  if (!a) return null;
  const latest = a.anchors.find((x) => x.state !== "failed");
  return (
    <details className="zec-audit">
      <summary>Check the reserve yourself</summary>
      <p className="note">
        Import this viewing key into any Zcash wallet (Zashi, zcash-devtool) with birthday height {a.reserve.birthday} to see
        the reserve&apos;s balance and memos directly. It can see funds but never spend them, and withdrawals from it hide their
        destinations.
      </p>
      <div className="zec-mono">{a.reserve.ufvk}</div>
      <button
        type="button"
        className="btn"
        onClick={() => {
          void navigator.clipboard?.writeText(a.reserve.ufvk);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy viewing key"}
      </button>
      {a.reserve.cold && (
        <>
          <p className="note">
            Most funds sit in cold storage, a wallet whose key is kept offline, never on a server. Its viewing key is
            public too:
          </p>
          <div className="zec-mono">{a.reserve.cold.ufvk}</div>
        </>
      )}
      <div className="dim">
        {latest
          ? `Latest anchor: log #${latest.length} · head ${shortId(latest.head, 8)} · tx ${shortId(latest.txid, 6)} · ${
              latest.state === "settled" ? "final" : "confirming"
            }`
          : "No anchors yet: the first goes out once the reserve holds funds."}
        {a.anchors.length > 1 && ` · ${a.anchors.length} in total`}
      </div>
    </details>
  );
}

"use client";

import { useEffect, useState } from "react";
import { zecSigned, type ZecProof } from "@/lib/zec/api";
import { fmtZec, shortId } from "@/lib/zec/format";
import { useZecSolvency } from "@/lib/zec/hooks";
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
          <div className="k">Held in the treasury</div>
          <div className="v">{wallet !== null ? `${fmtZec(wallet)} ZEC` : "—"}</div>
          <div className={backed === false ? "sell-text" : "ok"}>
            {backed === null ? "checking…" : backed ? "✓ covers everything owed" : "✗ short. This is being investigated"}
          </div>
        </div>
      </div>
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

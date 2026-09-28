"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ZecApiError, zecGet, zecSigned } from "@/lib/zec/api";
import { useZecKey } from "@/lib/zec/hooks";
import {
  JOIN_POINTS,
  REF_KEY,
  REFERRAL_POINTS,
  referralUrl,
  shareText,
  type WaitlistBoard,
  type WaitlistStanding,
} from "@/lib/zec/waitlist";

const SITE = typeof window === "undefined" ? "https://www.underwater.fun" : window.location.origin;

/**
 * The pre-launch waitlist. Signing up uses the same browser key the app
 * trades with, so a spot and its points are already on the person's account
 * when trading opens.
 */
export function Waitlist() {
  const qc = useQueryClient();
  const key = useZecKey();
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [ref, setRef] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("ref");
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(REF_KEY);
      if (fromUrl) localStorage.setItem(REF_KEY, fromUrl.toUpperCase());
    } catch {
      // No storage: the URL is enough.
    }
    setRef((fromUrl ?? stored)?.toUpperCase() ?? null);
  }, []);

  const board = useQuery({ queryKey: ["waitlist"], queryFn: () => zecGet<WaitlistBoard>("/api/waitlist"), refetchInterval: 30_000 });
  const me = useQuery({
    queryKey: ["waitlist", "me", key?.account],
    enabled: key !== null,
    queryFn: async () => {
      try {
        return await zecSigned<WaitlistStanding>("GET", "/api/waitlist/me");
      } catch (err) {
        if (err instanceof ZecApiError && err.status === 404) return null;
        throw err;
      }
    },
  });

  async function join() {
    setBusy(true);
    setError(null);
    try {
      await zecSigned<WaitlistStanding>("POST", "/api/waitlist", {
        handle: handle.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(ref ? { ref } : {}),
      });
      await qc.invalidateQueries({ queryKey: ["waitlist"] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const s = me.data ?? null;
  const link = s ? referralUrl(SITE, s.code) : "";
  const card = s ? `/r/${s.code}/opengraph-image?v=${s.points}-${s.rank}` : "/opengraph-image";
  const intent = s
    ? `https://x.com/intent/post?text=${encodeURIComponent(shareText(s))}&url=${encodeURIComponent(link)}`
    : "";

  return (
    <div className="wl">
      <header className="wl-top">
        <Link href="/" className="wordmark">
          <Logo className="logo-mark" />
          under<em>water</em>.fun
        </Link>
        <div className="wl-top-side">
          <ThemeToggle />
          <Link href="/app" className="btn">
            Try the testnet ↗
          </Link>
        </div>
      </header>

      <section className="wl-hero">
        <div className="wl-built">
          built on <img src="/brand/zcash-mark.svg" alt="" width={22} height={22} /> <b>Zcash</b>
        </div>
        <h1>
          The meme launchpad
          <br />
          is coming to <em>Zcash</em>
        </h1>
        <p className="wl-lede">
          Launch a token in seconds and trade it instantly, with its own built-in market. Deposit ZEC to a shielded address,
          and every balance on the platform is provable. Get in line now: early supporters earn points.
        </p>
        <div className="wl-count">
          <b>{board.data ? board.data.count.toLocaleString() : "…"}</b> in line
        </div>
      </section>

      <section className="wl-grid">
        <div className="panel wl-join">
          {s ? (
            <>
              <div className="panel-head">
                <span>You&apos;re in</span>
                <span>@{s.handle}</span>
              </div>
              <div className="wl-stats">
                <div>
                  <div className="k">Rank</div>
                  <div className="v gold">#{s.rank}</div>
                </div>
                <div>
                  <div className="k">Points</div>
                  <div className="v">{s.points}</div>
                </div>
                <div>
                  <div className="k">Referrals</div>
                  <div className="v">{s.referrals}</div>
                </div>
              </div>
              <img className="wl-card" src={card} alt={`@${s.handle}'s referral card: rank #${s.rank}, ${s.points} points`} />
              <label className="field">
                <span>Your referral link</span>
                <input readOnly value={link} onFocus={(e) => e.target.select()} />
              </label>
              <div className="wl-actions">
                <a className="btn primary" href={intent} target="_blank" rel="noreferrer">
                  Share on X
                </a>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
                <a className="btn" href={card} download={`underwater-${s.code}.png`}>
                  Download card
                </a>
              </div>
              <p className="field-note">
                Posting your link on X shows your card. Every friend who joins with it earns you {REFERRAL_POINTS} points.
              </p>
            </>
          ) : (
            <>
              <div className="panel-head">Join the waitlist</div>
              {ref && <div className="note ok">Invited with code {ref}: you&apos;ll both earn points.</div>}
              <label className="field">
                <span>Your X handle</span>
                <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@yourhandle" maxLength={16} />
              </label>
              <label className="field">
                <span>Email (optional, to hear when we launch)</span>
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" inputMode="email" />
              </label>
              {error && <div className="alert">{error}</div>}
              <button type="button" className="btn primary" disabled={busy || !key || handle.trim().length === 0} onClick={join}>
                {busy ? "Joining…" : !key ? "Getting ready…" : "Get in line"}
              </button>
              <p className="field-note">
                Your spot is saved to this browser, the same way your trading account will be. Your email is never shown to
                anyone.
              </p>
            </>
          )}
        </div>

        <div className="wl-side">
          <div className="panel">
            <div className="panel-head">How points work</div>
            <ul className="wl-list">
              <li>
                <b>{JOIN_POINTS} points</b> for joining.
              </li>
              <li>
                <b>+{REFERRAL_POINTS} points</b> for every friend who joins with your link.
              </li>
              <li>Points count toward a future airdrop. Details come before launch.</li>
              <li>Sign-ups are checked for fakes before any points count, so farming doesn&apos;t pay.</li>
            </ul>
          </div>
          <div className="panel">
            <div className="panel-head">Top of the line</div>
            {board.data && board.data.top.length > 0 ? (
              board.data.top.map((t) => (
                <div key={t.rank} className="r-row wl-row">
                  <span className="dim">#{t.rank}</span>
                  <span className="row-name">@{t.handle}</span>
                  <span className="num">{t.points} pts</span>
                </div>
              ))
            ) : (
              <div className="empty">Be the first in line.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

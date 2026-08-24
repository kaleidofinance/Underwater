"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useChainId, useConfig } from "wagmi";
import { switchChain } from "wagmi/actions";
import { CHAINS } from "@/lib/chains";

const PARAM = "chain";
const KEY = "underwater.chain";

/** One of ours, or something a stale link made up. */
const served = (id: number) => CHAINS.some((c) => c.id === id);

/** The chain a query string names, if it names one we actually serve. */
function readParam(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get(PARAM);
  if (raw === null) return null;
  const id = Number(raw);
  return served(id) ? id : null;
}

/**
 * The chain this browser was last on.
 *
 * wagmi persists a `chainId` of its own, and it cannot be used: with `ssr: true`
 * the store writes its *default* state to storage as the module loads, which
 * overwrites the remembered chain before hydration gets to read it back. Checked
 * in a browser rather than assumed — after switching to anvil, opening the bare
 * URL again came up on Ink, with `31337` gone from wagmi's key. So the choice
 * lives in a key of ours that nothing else touches.
 */
function readStored(): number | null {
  if (typeof window === "undefined") return null;
  const id = Number(read(KEY));
  return Number.isFinite(id) && id !== 0 && served(id) ? id : null;
}

// Storage throws rather than returns null in a locked-down browser, and a chain
// preference is never worth taking the page down for.
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * State the chain in the address bar, without pushing a history entry.
 *
 * `replaceState` rather than a router navigation: the chain is not a different
 * page, and turning every network switch into a back-button step would make the
 * back button walk through chains instead of leaving the market.
 */
function writeParam(id: number) {
  const url = new URL(window.location.href);
  if (url.searchParams.get(PARAM) === String(id)) return;
  url.searchParams.set(PARAM, String(id));
  window.history.replaceState(null, "", url);
}

/** Put the chain where both a shared link and a later visit will find it. */
function remember(id: number) {
  writeParam(id);
  try {
    window.localStorage.setItem(KEY, String(id));
  } catch {
    // See `read`: not worth throwing over.
  }
}

/**
 * Keep the selected chain in the URL, both ways.
 *
 * Two problems, one hook. A link to a token said nothing about which chain it
 * lived on, so the same URL showed a market on mainnet and a specimen on anvil
 * depending on who opened it. And the app had no memory of the choice at all —
 * wagmi's own storage looked like one, but it does not survive a reload (see
 * `readStored`).
 *
 * The rule: **on load the URL wins, then what we remembered, then the default —
 * and after that wagmi wins.** A pasted link opens on the chain it names, which
 * is the whole point of putting it there; a bare URL opens where you left off;
 * and once that is honoured every later switch is written back, including one
 * made in the wallet rather than in our dialog.
 */
export function useChainUrlSync() {
  const chainId = useChainId();
  const pathname = usePathname();
  const config = useConfig();

  // What this tab was opened as: the chain the link named, or failing that the
  // one this browser was last on. Read on the first render, before the effect
  // below rewrites the query string, and cleared once it has been honoured —
  // after that this ref is what says "wagmi is in charge now".
  const requested = useRef<number | null | undefined>(undefined);
  if (requested.current === undefined) requested.current = readParam() ?? readStored();

  useEffect(() => {
    const target = requested.current;

    // Nothing asked for, or already settled: mirror the chain out. The pathname
    // is a dependency so a client navigation — including to routes this hook has
    // never heard of — carries the chain with it.
    if (target === null || target === undefined) {
      remember(chainId);
      return;
    }

    if (target === chainId) {
      requested.current = null;
      remember(chainId);
      return;
    }

    // The action, not `useSwitchChain`. The hook routes the switch through a
    // react-query mutation, so the chain lands a few microtasks late — and this
    // effect runs during the same commit in which wagmi reads its own stored
    // chain back out of localStorage. Late lost that race every time: the URL
    // switched to anvil, hydration replaced it with the stored chain, and the
    // link may as well not have named one. Called directly, and with no wallet
    // connected, `switchChain` writes the chain (and therefore the storage
    // wagmi is about to read) synchronously, while we are still ahead of it.
    void switchChain(config, { chainId: target }).catch(() => {
      // A wallet can refuse: it may not know the chain, or the person said no.
      // The URL then describes a chain we are not on, so correct it rather than
      // leave a link that lies about what is on screen.
      requested.current = null;
      remember(chainId);
    });
  }, [chainId, config, pathname]);
}

/**
 * The hook, mounted once for the whole app. Renders nothing.
 *
 * It sits in the provider tree rather than in a layout or a page so that every
 * route inherits it without knowing it exists.
 */
export function ChainSync() {
  useChainUrlSync();
  return null;
}

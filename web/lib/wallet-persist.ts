"use client";

import { useEffect } from "react";
import { deserialize, useConfig, type Connection } from "wagmi";

/**
 * The connection wagmi persisted and then overwrote, read back before it is lost.
 *
 * `createConfig` ends on `store.setState(getInitialState())`. With `ssr: true` the
 * persist middleware is built with `skipHydration`, so at that moment nothing has
 * been read out of storage yet — and that write goes *through* the middleware, which
 * puts the empty defaults where the remembered `connections` and `current` were. The
 * config destroys its own memory by being constructed. `Hydrate`'s effect then
 * rehydrates the blob it has already clobbered and hands `reconnect()` a clean slate.
 *
 * Checked rather than reasoned about: a probe that seeded the store with a connection,
 * built a second config over the same storage, and printed the blob found `connections:
 * []` and `current: null` back out before a single `setState` of the app's own. It is
 * also the same clobber `readStored` in components/ChainSync.tsx describes for the
 * chain id, which is how that comment came to exist.
 *
 * Two symptoms follow, and to a visitor both read as "it forgot my wallet":
 *
 *  - `reconnect()` starts from `current: null`, so it sets `status: "connecting"`
 *    instead of `"reconnecting"` — and `getAccount()` reports `isConnected: false` for
 *    `connecting` even after a connector in its loop has succeeded and put the address
 *    in state. That loop is sequential across every configured connector and asks each
 *    one for its provider, which for Coinbase and WalletConnect means dynamically
 *    importing an SDK. So the masthead holds "Connect wallet" for as long as that
 *    takes, while everything needing only the address — the balance beside it, the
 *    percent picks' basis — renders as connected. Two halves of one page disagreeing
 *    about whether there is a wallet.
 *  - Nothing is optimistic. Even when the loop is quick there is a gap on every page
 *    load, and when the extension is locked `isAuthorized()` is false, the gap never
 *    closes, and nothing says so.
 *
 * Hence the snapshot, and hence its own module: ES modules evaluate before the body of
 * whatever imports them, which is the only ordering that puts this read ahead of the
 * `createConfig` call in app/providers.tsx. A `localStorage.getItem` sitting above it
 * in that file would work today and break the first time a line moved.
 */

/** wagmi's own key — `createStorage`'s default `wagmi` prefix, the store's own name. */
const KEY = "wagmi.store";

type Restorable = { connections: Map<string, Connection>; current: string };

const SNAPSHOT = read();

function read(): Restorable | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    // wagmi's deserializer, because wagmi wrote it: the Map crosses as a
    // `{__type: "Map"}` envelope that `JSON.parse` alone leaves as a plain object.
    const { state } = deserialize<{
      state?: { connections?: unknown; current?: unknown };
    }>(raw);
    const connections = state?.connections;
    const current = state?.current;
    if (typeof current !== "string" || !(connections instanceof Map)) return null;
    // A `current` with nothing behind it, or a connection with no account, is not a
    // session — and the empty case is also what a deliberate `disconnect()` leaves,
    // which must stay disconnected. An address is the point: `getAccount()` reports
    // `isConnected` for a `reconnecting` state as `!!address`, so a connection
    // without one would restore into a state that still reads as disconnected.
    const held = connections.get(current) as Connection | undefined;
    if (!held?.accounts?.[0]) return null;
    return { connections: connections as Map<string, Connection>, current };
  } catch {
    // Storage throws outright in a locked-down browser, and a blob written by an
    // older wagmi can be any shape. Neither is worth a blank page: no snapshot means
    // the reconnect behaves exactly as it did before this file existed.
    return null;
  }
}

/**
 * Puts it back, one tick after hydration. Renders nothing.
 *
 * Not during render, and not through `WagmiProvider`'s `initialState`, which is where
 * this belongs and cannot go: the server has no localStorage, so a state restored on
 * the first client render is markup the server did not produce — a hydration mismatch
 * of exactly the kind lib/hydration.ts exists to avoid, for the most ordinary visitor
 * there is, one holding a wallet. From an effect the first paint still matches the
 * HTML and the wallet arrives a tick later.
 *
 * It must be mounted *after* `ChainSync`, and the order of the JSX is the order of the
 * effects. ChainSync calls `switchChain` while it is still ahead of wagmi's hydration,
 * and `switchChain` asks the *connector* to switch whenever there is a connection to
 * ask — but a connection read back off storage carries only the four fields wagmi
 * persists of a connector, no methods. Restoring after it leaves that path exactly as
 * it was; a real connector is in place long before anything else can reach one.
 *
 * `status: "reconnecting"` and not `"connected"`, because that is what this is: the
 * address is the one that was here last time, `reconnect()` is on its way to check it
 * against the wallet, and if the wallet says no — locked, revoked, a different account
 * — it lands on `disconnected` a moment later. Optimistic, and corrected by the wallet
 * rather than trusted. It is also the state wagmi already has a truthful reading of:
 * `getAccount()` returns `isConnected: !!address` for `reconnecting`, where for
 * `connecting` it returns false beside an address it is holding.
 *
 * One consequence worth knowing about, because it looks alarming and is not: restoring
 * `current` fires the `syncConnectedChain` subscriber, so the app's chain follows the
 * *stored* connection's chain — which can be stale, and which can override the chain a
 * `?chain=` link just asked for. It settles in the same place it always did. Without
 * this the same subscriber fires when `reconnect()` finishes and moves the app onto the
 * wallet's chain then; all this changes is that it happens in the first commit instead
 * of half a second later, and `reconnect()` still corrects a stale chain id when it
 * reports the wallet's real one. ChainSync's `switchChain` may throw
 * `SwitchChainNotSupportedError` against the restored connector in that window; it
 * catches, and lands on the chain it would have landed on anyway.
 */
export function WalletPersist() {
  const config = useConfig();

  useEffect(() => {
    if (!SNAPSHOT) return;
    // Anything live wins. A second mount — StrictMode, a fast refresh — must not put
    // a stale session over a connection that has been made since.
    if (config.state.current) return;
    config.setState((state) => ({
      ...state,
      connections: SNAPSHOT.connections,
      current: SNAPSHOT.current,
      status: "reconnecting",
    }));
  }, [config]);

  return null;
}

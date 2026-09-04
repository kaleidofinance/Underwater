"use client";

import { useEffect } from "react";
import { deserialize, useAccount, useConfig, type Connection } from "wagmi";
import { reconnect } from "wagmi/actions";

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
 *
 * The snapshot buys the address back and cannot buy the *connector* back, which is the
 * subject of {@link useWalletReady} — a restored connection has no methods on it, and
 * anything that signs has to wait for the real one. {@link useReconnectOnReturn}
 * covers the other end: the case where the reconnect fails once and never tries again.
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
 * reports the wallet's real one. ChainSync's `switchChain` does throw
 * `SwitchChainNotSupportedError` against the restored connector in that window — it
 * recognises that one by name and holds the request open until {@link useWalletReady}
 * says a real connector has arrived, rather than reading it as a refusal.
 */
export function WalletPersist() {
  const config = useConfig();
  useReconnectOnReturn();

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

/**
 * Whether the wallet in state can actually be *asked* anything.
 *
 * A restored connection carries the four fields wagmi persists of a connector — id,
 * name, type, uid — and none of its methods, which is the whole shape of the object
 * `partialize` writes. Between {@link WalletPersist}'s effect and `reconnect()`
 * finishing, that husk is what `config.state.connections` holds, and it is enough to
 * make `getAccount()` report `isConnected: true`: the status is `reconnecting` and
 * there is an address, which is exactly what wagmi calls connected.
 *
 * Which is right for a *readout* and wrong for a *button*. `useAccount().connector`
 * is the husk itself, so anything that gates on `isConnected` alone enables a control
 * whose first act is to call a method that is not there — `writeContract` reaches
 * `getConnectorClient`, which does an unguarded `await connection.connector
 * .getChainId()` and throws a bare TypeError rather than a wagmi error. wagmi has a
 * named error for this exact state, `ConnectorUnavailableReconnectingError`, but only
 * on the branch where a connector is passed explicitly, which `writeContract` never
 * does.
 *
 * The window is as long as `reconnect()` takes, and that is not instant: it walks
 * every configured connector in sequence asking each for its provider, and for
 * Coinbase and WalletConnect that means fetching an SDK. It is also the last effect
 * to run, since it lives in wagmi's own `Hydrate` at the top of the provider tree and
 * React flushes effects child-first.
 *
 * `getChainId` rather than a truthiness check on the connector, because the husk is a
 * real object with a real `id`. It is the method the failing path calls first.
 */
export function useWalletReady() {
  const { isConnected, connector } = useAccount();
  return isConnected && typeof connector?.getChainId === "function";
}

/**
 * Try the reconnect again when the page comes back to the foreground.
 *
 * `reconnect()` runs exactly once, on mount, and gives up for good: if no connector
 * is authorized at that instant it writes `connections: new Map(), current: null,
 * status: "disconnected"` and nothing retries. The instant matters, because the
 * common reasons to fail are temporary — an extension still locked, a provider not
 * yet injected, a phone wallet that has not been reopened. The visitor then sees
 * "Connect wallet" for a wallet the browser has authorized, and pressing it is the
 * only way back.
 *
 * A tab returning to the foreground is the one moment worth spending a retry on: it
 * is very often *why* it came back — the wallet was unlocked in another window. So
 * this listens for that and nothing else. No polling, no timer: a wallet that stays
 * locked is a legitimate disconnected state and hammering it would only mean an
 * `isAuthorized` round trip per connector, forever.
 *
 * Only from `disconnected`, so this can never interrupt a live session or race the
 * first reconnect — wagmi's own re-entrancy guard would drop the call anyway, and
 * from any other status there is nothing to retry. `reconnect` is idempotent when it
 * finds nothing: the state it lands on is the state it started from.
 */
export function useReconnectOnReturn() {
  const config = useConfig();

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      if (config.state.status !== "disconnected") return;
      // Nothing to await: it settles into the store, which is what every consumer
      // reads. A rejection here means no connector answered, which is the state we
      // are already in.
      void reconnect(config);
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [config]);
}

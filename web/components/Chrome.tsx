"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  useAccount,
  useBalance,
  useChainId,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { Modal } from "@/components/Modal";
import { ChainIcon, chainKind } from "@/components/ChainIcon";
import { chainById, CHAINS } from "@/lib/chains";
import { launchpadFor } from "@/lib/contracts";
import { fmtEth, shortAddr } from "@/lib/format";
import { useHydratedChainId } from "@/lib/hydration";
import { platesFor } from "@/lib/plates";
import { waitlistFor } from "@/lib/waitlist";

/// Which deploy the masthead is talking about on this route.
///
/// The chip and the network list both report "not deployed" off a single
/// address, and which address that is depends on the page: the collection routes
/// (`/plates`, `/mint`) read the plates deploy, `/waterdrop` reads the waitlist,
/// and everything else reads the launchpad. They are three independent deploys —
/// a chain can have any subset of them — so reporting the wrong one tells a
/// visitor on a working page that nothing is deployed.
function deployment(pathname: string, chainId: number) {
  if (pathname.startsWith("/waterdrop")) {
    return { label: "waitlist", address: waitlistFor(chainId) };
  }
  if (pathname.startsWith("/plates") || pathname.startsWith("/mint")) {
    return { label: "collection", address: platesFor(chainId) };
  }
  return { label: "launchpad", address: launchpadFor(chainId) };
}

export function Masthead() {
  const pathname = usePathname();
  const chainId = useHydratedChainId();
  const { address, isConnected } = useAccount();
  const { data: balance } = useBalance({ address });
  const [walletOpen, setWalletOpen] = useState(false);
  const [netOpen, setNetOpen] = useState(false);

  const chain = chainById(chainId);
  const { address: deployed } = deployment(pathname, chainId);

  return (
    <header className="top">
      {/* Not a heading. The wordmark is site identity and it is on every page,
          so making it the `h1` left each page's own title as a second one —
          and on a token page the specimen's name is what the page is about.
          `.wordmark` is a class, so the tag is free. */}
      <div className="wordmark">
        under<em>water</em>.fun
      </div>

      {/* Everything you can press, in one right-hand column: the chain and the
          wallet on top, the routes under them. The routes used to sit beneath the
          wordmark, which read as a caption to the title rather than as controls. */}
      <div className="mast-side">
        <div className="mast-meta">
          {/*
          The chain moved here from a headline stat card. It is plumbing, not a
          market number — but it cannot be hidden either, because on a chain with
          no launchpad it is the only thing that explains the empty page. So: a
          chip beside the wallet, gold when there is something to read and red
          when there is not, next to the control that changes it.
        */}
          <button
            type="button"
            className="account chip"
            data-switch
            onClick={() => setNetOpen(true)}
          >
            <ChainIcon chainId={chainId} size={15} className="chain-mark" />
            <b>{chain ? chain.name : `Chain ${chainId}`}</b>
            <span className={deployed ? "ok" : "warn"}>
              {deployed ? shortAddr(deployed) : "not deployed"}
            </span>
          </button>

          {isConnected && address ? (
            <button
              type="button"
              className="account"
              data-wallet
              onClick={() => setWalletOpen(true)}
            >
              <b>{shortAddr(address)}</b>
              <span>{balance ? `${fmtEth(balance.value)} ETH` : "—"}</span>
            </button>
          ) : (
            <button
              type="button"
              className="primary account"
              data-wallet
              onClick={() => setWalletOpen(true)}
            >
              <b>Connect wallet</b>
              <span>not connected</span>
            </button>
          )}
        </div>

        <nav className="nav">
          <Link href="/" data-active={pathname === "/"}>
            Market
          </Link>
          <Link href="/create" data-active={pathname === "/create"}>
            Launch
          </Link>
          <Link href="/swap" data-active={pathname === "/swap"}>
            Swap
          </Link>
          <Link
            href="/plates"
            data-active={pathname === "/plates" || pathname === "/mint"}
          >
            Plates
          </Link>
          <Link href="/waterdrop" data-active={pathname === "/waterdrop"}>
            Waterdrop
          </Link>
          <Link href="/profile" data-active={pathname === "/profile"}>
            Profile
          </Link>
        </nav>
      </div>

      <WalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
      <NetworkModal open={netOpen} onClose={() => setNetOpen(false)} />
    </header>
  );
}

/**
 * What each connector reaches, in the words a visitor would use.
 *
 * wagmi hands us an id and a name, and neither is enough on its own: "Injected"
 * is not a wallet anybody has heard of, and a bare name does not say whether you
 * need an extension installed or your phone in your hand. Keyed by connector id,
 * so a connector we have no entry for still renders under its own name.
 */
const WALLETS: Record<string, { name?: string; reach: string }> = {
  injected: { name: "Browser wallet", reach: "metamask, rabby, …" },
  // Not "coinbaseWallet" — the connector's own id, which is what wagmi reports.
  coinbaseWalletSDK: { reach: "extension, or the app by QR" },
  walletConnect: { reach: "scan with any mobile wallet" },
};

/**
 * One dialog for both halves of the wallet's life: pick a connector when
 * disconnected, read the account and leave when connected.
 *
 * The connector list is whatever wagmi was configured with — see providers.tsx,
 * where WalletConnect appears only if it has a project ID — rather than a row of
 * logos for wallets we cannot actually reach. A failed connect surfaces here
 * instead of vanishing into the console, which is what happened when this was a
 * single button.
 */
function WalletModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { data: balance } = useBalance({ address });
  const { connect, connectors, isPending, error, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const explorer = chainById(chainId)?.blockExplorers?.default.url;
  // Which row is waiting. `isPending` alone is true for the whole dialog, so
  // every wallet claimed to be waiting on the wallet when only one was.
  const pendingUid =
    isPending && variables?.connector && "uid" in variables.connector
      ? variables.connector.uid
      : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isConnected ? "Account" : "Connect a wallet"}
    >
      {isConnected && address ? (
        <>
          <dl style={{ marginBottom: 16 }}>
            <div className="r-row">
              <dt>Address</dt>
              <dd style={{ wordBreak: "break-all" }}>{address}</dd>
            </div>
            <div className="r-row">
              <dt>Balance</dt>
              <dd>{balance ? `${fmtEth(balance.value)} ETH` : "—"}</dd>
            </div>
            <div className="r-row">
              <dt>Network</dt>
              <dd>{chainById(chainId)?.name ?? `Unknown (${chainId})`}</dd>
            </div>
          </dl>
          <div style={{ display: "flex", gap: 8 }}>
            {explorer && (
              <a
                href={`${explorer}/address/${address}`}
                target="_blank"
                rel="noreferrer"
                style={{ flex: 1 }}
              >
                <button type="button" style={{ width: "100%" }}>
                  Explorer
                </button>
              </a>
            )}
            <button
              type="button"
              style={{ flex: 1 }}
              onClick={() => {
                disconnect();
                onClose();
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          {connectors.map((connector) => {
            const wallet = WALLETS[connector.id];
            return (
              <button
                key={connector.uid}
                type="button"
                className="choice"
                disabled={isPending}
                onClick={() =>
                  connect({ connector }, { onSuccess: () => onClose() })
                }
              >
                <span className="choice-name">
                  {wallet?.name ?? connector.name}
                </span>
                <span className="choice-meta">
                  {connector.uid === pendingUid
                    ? "waiting on the wallet…"
                    : (wallet?.reach ?? connector.name)}
                </span>
              </button>
            );
          })}
          {error && (
            <div className="alert" style={{ marginTop: 12 }}>
              {error.message.split("\n")[0]}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Where the chain facts live now.
 *
 * Each row says what is actually deployed on the chain it offers, which is the
 * one thing a bare chain name never told anyone: switching to Ink mainnet today
 * gets you an empty market, and the list says so before you click rather than
 * after. Which deploy it reports follows the route, like the chip does.
 */
function NetworkModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const chainId = useHydratedChainId();
  const pathname = usePathname();
  const { switchChain, isPending, error } = useSwitchChain();

  return (
    <Modal open={open} onClose={onClose} title="Network">
      {CHAINS.map((c) => {
        const { label, address } = deployment(pathname, c.id);
        const current = c.id === chainId;
        return (
          <button
            key={c.id}
            type="button"
            className="choice"
            data-current={current}
            disabled={current || isPending}
            onClick={() =>
              // Closing only on success: a wallet that does not know the chain,
              // or a person who declines the prompt, used to leave the dialog
              // shut and the network unchanged with nothing said.
              switchChain({ chainId: c.id }, { onSuccess: () => onClose() })
            }
          >
            <ChainIcon chainId={c.id} size={22} className="choice-mark" />
            <span className="choice-name">{c.name}</span>
            <span className="choice-meta">
              {chainKind(c.id)} · chain {c.id} ·{" "}
              {address ? (
                <>
                  {label} <span className="addr">{shortAddr(address)}</span>
                </>
              ) : (
                "not deployed"
              )}
              {current && " · current"}
            </span>
          </button>
        );
      })}
      {error && (
        <div className="alert" style={{ marginTop: 12 }}>
          {error.message.split("\n")[0]}
        </div>
      )}
      <p className="field-note">
        With a wallet connected this asks the wallet to switch too.
      </p>
    </Modal>
  );
}

/**
 * Shown when a URL names something that is not here.
 *
 * It carries the page's `h1` deliberately. A dead end used to be a single grey
 * line of mono text — no heading, nothing to press, and on a token page not even
 * a statement of what was being looked for. Every route now says what happened
 * and offers the one way out, and the document keeps exactly one heading.
 */
export function NotFound({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="stack" style={{ paddingTop: 40, maxWidth: "62ch" }}>
      <h1 className="title">{title}</h1>
      {children}
      <div>
        <Link href="/" className="btn primary">
          Back to the market
        </Link>
      </div>
    </div>
  );
}

/**
 * Shown in place of content when the page's contract does not exist here.
 *
 * Says what is true and what to do about it, and nothing else. This used to
 * carry the deploy runbook — `forge script` lines, the env var to set, the
 * local-node command — which is documentation for whoever operates this, not
 * for whoever is visiting it. That belongs in the README.
 *
 * The body is overridable because the collection and waterdrop routes are about
 * different deploys: "there is no market to show" is the wrong sentence for a
 * collection or a waterdrop that is not on this chain.
 */
export function NotDeployed({ children }: { children?: ReactNode }) {
  const chainId = useHydratedChainId();
  const chain = chainById(chainId);

  return (
    <div className="stack" style={{ paddingTop: 40, maxWidth: "52ch" }}>
      <h1 className="title">
        Not live on {chain?.name ?? "this network"} yet.
      </h1>
      <p className="note">
        {children ??
          "There is no market to show here. Switch networks in the masthead."}
      </p>
    </div>
  );
}

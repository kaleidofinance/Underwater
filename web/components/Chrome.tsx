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
import { chainById, CHAINS } from "@/lib/chains";
import { launchpadFor } from "@/lib/contracts";
import { fmtEth, shortAddr } from "@/lib/format";

export function Masthead() {
  const pathname = usePathname();
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const { data: balance } = useBalance({ address });
  const [walletOpen, setWalletOpen] = useState(false);
  const [netOpen, setNetOpen] = useState(false);
  const chain = chainById(chainId);
  const launchpad = launchpadFor(chainId);

  return (
    <header className="top">
      <div>
        {/* Not a heading. The wordmark is site identity and it is on every page,
            so making it the `h1` left each page's own title as a second one —
            and on a token page the specimen's name is what the page is about.
            `.wordmark` is a class, so the tag is free. */}
        <div className="wordmark">
          under<em>water</em>.fun
        </div>
        <nav className="nav">
          <Link href="/" data-active={pathname === "/"}>
            Market
          </Link>
          <Link href="/create" data-active={pathname === "/create"}>
            Launch
          </Link>
          <a
            href="https://github.com/underwater-fun"
            target="_blank"
            rel="noreferrer"
          >
            Contracts
          </a>
        </nav>
      </div>

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
          <b>{chain ? chain.name : `Chain ${chainId}`}</b>
          <span className={launchpad ? "ok" : "warn"}>
            {launchpad ? shortAddr(launchpad) : "not deployed"}
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

      <WalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
      <NetworkModal open={netOpen} onClose={() => setNetOpen(false)} />
    </header>
  );
}

/**
 * One dialog for both halves of the wallet's life: pick a connector when
 * disconnected, read the account and leave when connected.
 *
 * The connector list is whatever wagmi was configured with — injected only, for
 * now — rather than a row of logos for wallets we cannot actually reach. A
 * failed connect surfaces here instead of vanishing into the console, which is
 * what happened when this was a single button.
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
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const explorer = chainById(chainId)?.blockExplorers?.default.url;

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
          {connectors.map((connector) => (
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
                {connector.name === "Injected"
                  ? "Browser wallet"
                  : connector.name}
              </span>
              <span className="choice-meta">
                {isPending ? "waiting on the wallet…" : "metamask, rabby, …"}
              </span>
            </button>
          ))}
          {error && (
            <div className="alert" style={{ marginTop: 12 }}>
              {error.message.split("\n")[0]}
            </div>
          )}
          <p className="field-note">
            Injected wallets only for now. WalletConnect and Coinbase both need
            project credentials, and a button that cannot work is worse than no
            button.
          </p>
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
 * after.
 */
function NetworkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chainId = useChainId();
  const { switchChain, isPending, error } = useSwitchChain();

  return (
    <Modal open={open} onClose={onClose} title="Network">
      {CHAINS.map((c) => {
        const pad = launchpadFor(c.id);
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
            <span className="choice-name">{c.name}</span>
            <span className="choice-meta">
              chain {c.id} ·{" "}
              {pad ? (
                <>
                  launchpad <span className="addr">{shortAddr(pad)}</span>
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
        With a wallet connected this asks the wallet to change networks. Without
        one it just changes which chain the app reads from. Either way the chain
        goes in the address bar, so a link you copy opens where you are.
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

/** Shown in place of content when no launchpad exists on the selected chain. */
export function NotDeployed() {
  return (
    <div className="stack" style={{ paddingTop: 40, maxWidth: "68ch" }}>
      <h1 className="title">Nothing deployed here yet.</h1>
      <p className="note">
        The contracts are written and tested — <b>314 passing tests</b>,
        including full launch-to-graduation runs against forks of both Ink
        mainnet and Ink Sepolia — but no instance has been broadcast to a live
        network.
      </p>
      <p className="note">
        To point this app at one, deploy the DEX and the launchpad, then set the
        matching <code>NEXT_PUBLIC_LAUNCHPAD_*</code> variable in{" "}
        <code>web/.env.local</code>:
      </p>
      <div className="panel">
        <div className="panel-head">
          <span>Deploy order</span>
        </div>
        <pre
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            lineHeight: 1.9,
            margin: 0,
            color: "var(--ink-dim)",
            whiteSpace: "pre-wrap",
          }}
        >
          {`forge script script/DeployDex.s.sol --rpc-url ink_sepolia
# paste the router into .env as DEX_ROUTER, then
forge script script/Deploy.s.sol --rpc-url ink_sepolia
# add --broadcast once the dry run looks right`}
        </pre>
      </div>
      <p className="note">
        Or run it all locally with no faucet and no keys:{" "}
        <b>npm run localchain</b> in <code>web/</code> starts an anvil node,
        deploys everything to it, seeds a few launches, and prints the address to
        put in <code>NEXT_PUBLIC_LAUNCHPAD_ANVIL</code>.
      </p>
    </div>
  );
}

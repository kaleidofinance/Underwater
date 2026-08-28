"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useAccount, useConfig, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { switchChain } from "wagmi/actions";
import { ChainIcon } from "@/components/ChainIcon";
import { Logo } from "@/components/Logo";
import { Modal } from "@/components/Modal";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WaitlistPanel } from "@/components/WaitlistPanel";
import { XLink } from "@/components/XLink";
import { chainById, CHAINS } from "@/lib/chains";
import { fmtDuration, shortAddr } from "@/lib/format";
import { GATE_ON, readBypass } from "@/lib/gate";
import { PLATES, usePlatesState } from "@/lib/plates";
import {
  useWaitlist,
  useWaitlistState,
  useWaitlistWindow,
  waitlistFor,
} from "@/lib/waitlist";

/**
 * The waterdrop gate — the only thing the public can reach before launch.
 *
 * The app is not taken away, it is put behind glass: everything renders, the
 * water still moves, and one card sits over it with the registration form in it.
 * That is the deliberate shape of the announcement — there is visibly a launchpad
 * back there, and today the one thing to do is get on the allowlist.
 *
 * Three things it has to carry that the pages behind it carry for themselves, and
 * that is most of the code below:
 *
 *  - **A wallet.** Connecting lives in the masthead, which is behind the blur, and
 *    {@link WaitlistPanel}'s own button reads "Connect a wallet" while being
 *    disabled — it registers, it does not connect. So the gate needs its own
 *    control. It is not Chrome.tsx's dialog: that one is private to the masthead,
 *    and this one is deliberately smaller (no balance, no explorer link — nothing
 *    that invites reading the app through the gate).
 *  - **A chain.** The waterdrop is one deploy on one chain, and it is not always
 *    the chain the app defaults to. See `useGateChain` below.
 *  - **The gate itself.** `GATE_ON` is decided at build time, so the shut state is
 *    in the server's HTML and nothing about the app is visible before hydration.
 *    The bypass is the opposite — localStorage and a query param are browser
 *    facts — so it lifts one tick after mount. The asymmetry is the point: a
 *    visitor never blinks at the app, and the team blinks at the gate.
 *
 * What it deliberately does *not* do is stop anyone determined. See lib/gate.ts.
 */
export function Gate() {
  const [bypassed, setBypassed] = useState(false);

  useEffect(() => {
    // Guarded so a build with the gate off never touches the URL: `readBypass`
    // strips `?key=` as a side effect, and it has no business doing that to a
    // query string on an open site.
    if (GATE_ON && readBypass()) setBypassed(true);
  }, []);

  // Every chain read the gate needs lives in the shell, so an open site mounts
  // none of them — no waitlist poll, no plates poll, nothing.
  if (!GATE_ON || bypassed) return null;
  return <GateShell />;
}

/**
 * Put the app on the chain the waterdrop is actually on.
 *
 * The app defaults to Ink mainnet on purpose — that is where it launches — and
 * the waitlist is deployed on Sepolia first, so the gate's whole reason for
 * existing would render "not on this network" for every visitor. It picks the
 * first chain that has a waitlist configured, which is `CHAINS` order and
 * therefore mainnet before Sepolia before anvil: the day the waitlist is on
 * mainnet this stops doing anything at all.
 *
 * Only when no wallet is connected, and that restraint is the whole design. With
 * nothing connected `switchChain` is a local state write — the same call
 * ChainSync makes for a `?chain=` link, and for the same reason it uses the
 * action rather than the hook. With a wallet connected it is a prompt in someone
 * else's software, and a page that fires one at you on arrival for a reason it
 * hasn't explained yet has overstepped; that case gets a button instead.
 *
 * It does leave a trace: ChainSync mirrors the result into `?chain=` and
 * localStorage, so a visitor gated onto Sepolia opens on Sepolia later too. That
 * is a fair price while the only thing here is the waterdrop, and it resolves
 * itself once the waitlist and the launchpad are on the same chain.
 */
function useGateChain(configured: boolean, chainId: number, connected: boolean) {
  const config = useConfig();
  const target = CHAINS.find((c) => waitlistFor(c.id) !== null) ?? null;

  useEffect(() => {
    if (configured || connected || !target || target.id === chainId) return;
    void switchChain(config, { chainId: target.id }).catch(() => {
      // Nothing to fall back to: the body below already says the waterdrop is
      // not on this network, and offers the switch as a button.
    });
  }, [config, configured, connected, chainId, target]);

  return target;
}

/**
 * Take the keyboard and the screen reader away from the page behind the glass.
 *
 * The overlay stops the mouse and the blur stops the eye, and without this Tab
 * still walks straight into a blurred masthead — a hard gate that is only hard
 * for people using a pointer is not one. `inert` does both halves: unfocusable,
 * and out of the accessibility tree, so what a screen reader is handed is the
 * card and nothing else.
 *
 * It has to be applied to siblings, because there is nothing to wrap: the page,
 * the water layers, the footer and this gate are all children of `<body>`. But
 * *which* sibling the gate is arrives from `closest` rather than from assuming it
 * is the gate element itself, and that is the whole reason this takes a ref.
 * Today `<Providers>` renders no element of its own, so the two are the same
 * node — one day it might, and then the assumption fails in the worst way
 * available to it: `inert` lands on the gate's own ancestor, and the registration
 * form is unfocusable and invisible to a screen reader on the one page the public
 * can reach. Nothing about that shows up in a type check or a screenshot, and it
 * would be a fact about a different file. One DOM walk cannot be wrong about it.
 *
 * Next's own elements are left alone — `<nextjs-portal>` carries the dev error
 * overlay, and an inert one can be neither read nor dismissed.
 */
function useInertBehind(gate: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = gate.current?.closest("body > *");
    if (!root) return;

    const behind = Array.from(document.body.children).filter(
      (el) => el !== root && !el.tagName.toLowerCase().startsWith("next"),
    );
    for (const el of behind) el.setAttribute("inert", "");
    return () => {
      for (const el of behind) el.removeAttribute("inert");
    };
  }, [gate]);
}

function GateShell() {
  const { address: account, isConnected } = useAccount();
  const { address: waitlist, chainId } = useWaitlist();
  const {
    state: wlState,
    ready: wlReady,
    isLoading: wlLoading,
    refetch: refetchWaitlist,
  } = useWaitlistState(account);
  const win = useWaitlistWindow(wlState);
  // Only for `maxPerWallet`, which is what turns the allocation into a number of
  // people — the same one read the /waterdrop page takes it from.
  const { state: plates } = usePlatesState(account);

  const target = useGateChain(waitlist !== null, chainId, isConnected);
  const gate = useRef<HTMLDivElement>(null);
  useInertBehind(gate);

  const framing =
    win.kind === "open"
      ? {
          title: wlState.registered
            ? "You are in the waterdrop."
            : "The waterdrop is open.",
          note: wlState.registered
            ? "This wallet is registered. Nothing more to do — the list is on chain, the deadline cannot move, and nobody can remove you."
            : "Register the wallet you want on the allowlist for the plates. A short quest and one transaction. The launchpad behind this opens after.",
        }
      : win.kind === "before"
        ? {
            title: "The waterdrop opens soon.",
            note: `Registration opens in ${fmtDuration(win.opensIn)}. There is no cap and no queue, so being first is worth nothing — come back when it opens.`,
          }
        : {
            title: "The waterdrop has closed.",
            note: "Registration is closed and the list is fixed. Whatever the allowlist does not use rolls into the public phase, which is open to anyone.",
          };

  return (
    <div
      className="gate"
      ref={gate}
      role="dialog"
      aria-modal="true"
      aria-labelledby="gate-title"
    >
      <div className="gate-card">
        <div className="gate-head">
          {/* The same wordmark as the masthead, and the same class, so it is the
              same thing rather than a copy that drifts. */}
          <div className="wordmark">
            <Logo className="logo-mark" />
            under<em>water</em>.fun
          </div>
          <div className="gate-controls">
            <XLink />
            <ThemeToggle />
            <GateWallet />
          </div>
        </div>

        <div className="gate-body">
          {/* Not an `h1`. The page behind this has one, and it is still in the
              document — inert, but there. `aria-labelledby` is what makes this the
              dialog's name, which is the job the heading would have been doing. */}
          <p className="gate-title" id="gate-title">
            {framing.title}
          </p>
          <p className="gate-note">{framing.note}</p>

          {!waitlist ? (
            <GateChain
              target={target}
              chainId={chainId}
              connected={isConnected}
            />
          ) : !wlReady && wlLoading ? (
            <div className="empty">Sounding…</div>
          ) : (
            <WaitlistPanel
              waitlist={waitlist}
              state={wlState}
              window={win}
              allocation={PLATES.wlAllocation}
              perAddress={plates.maxPerWallet}
              onDone={refetchWaitlist}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The waterdrop is somewhere else, or nowhere yet.
 *
 * Reached two ways: a wallet is connected to the wrong chain, so `useGateChain`
 * left it alone on purpose and this is the prompt it deferred to; or no chain has
 * a waitlist configured at all, which is a deploy that has not happened and is
 * not something a visitor can press their way out of.
 *
 * With nothing connected it is also on screen for a tick before the automatic
 * switch lands, which is why it says "you are on" rather than "this wallet is
 * on" — the copy has to be true of a browser with no wallet in it. It stays
 * pressable in that tick rather than becoming a spinner: a switch that quietly
 * failed would leave a spinner turning forever, and a button that turned out not
 * to be needed costs nothing.
 */
function GateChain({
  target,
  chainId,
  connected,
}: {
  target: { id: number; name: string } | null;
  chainId: number;
  connected: boolean;
}) {
  const { switchChain: switchTo, isPending, error } = useSwitchChain();
  const here = chainById(chainId);

  if (!target) {
    return (
      <div className="alert info">
        The waterdrop is not deployed yet. Nothing to register for — follow{" "}
        <a
          className="link"
          href="https://x.com/underwaterxyz"
          target="_blank"
          rel="noreferrer"
        >
          @underwaterxyz
        </a>{" "}
        and it will be announced there first.
      </div>
    );
  }

  return (
    <>
      <div className="alert info" style={{ marginBottom: 12 }}>
        The waterdrop is on {target.name}, and you are on{" "}
        {here?.name ?? `chain ${chainId}`}.
        {connected && " Switching asks the wallet too."}
      </div>
      <button
        type="button"
        className="primary"
        style={{ width: "100%" }}
        disabled={isPending}
        onClick={() => switchTo({ chainId: target.id })}
      >
        <ChainIcon chainId={target.id} size={15} className="chain-mark" />
        {isPending ? "Switching…" : `Switch to ${target.name}`}
      </button>
      {error && (
        <div className="alert" style={{ marginTop: 12 }}>
          {error.message.split("\n")[0]}
        </div>
      )}
    </>
  );
}

/**
 * Connect, and disconnect, without the masthead.
 *
 * A deliberately thinner version of the masthead's dialog: the connector list and
 * a way back out, and none of the account read-out — the gate has one job, and a
 * balance and an explorer link are the app talking about itself.
 *
 * The list is only built once the dialog opens, which is what {@link Modal} does
 * with its children and is load-bearing here for the same reason it is there:
 * part of it comes from wallets announcing themselves at runtime, so the server
 * cannot know it and rendering it before an interaction is a hydration mismatch
 * for anyone holding a wallet.
 */
function GateWallet() {
  const [open, setOpen] = useState(false);
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error, variables } = useConnect();
  const { disconnect } = useDisconnect();

  // Which row is waiting: `isPending` is true for the whole dialog, so on its own
  // it makes every wallet in the list claim to be the one being waited on.
  const pendingUid =
    isPending && variables?.connector && "uid" in variables.connector
      ? variables.connector.uid
      : undefined;

  return (
    <>
      <button
        type="button"
        className={isConnected ? "account" : "primary account"}
        data-wallet
        onClick={() => setOpen(true)}
      >
        <b>{isConnected && address ? shortAddr(address) : "Connect wallet"}</b>
        <span>{isConnected ? "connected" : "to register"}</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={isConnected ? "Wallet" : "Connect a wallet"}
      >
        {isConnected ? (
          <>
            <p className="field-note" style={{ marginTop: 0 }}>
              Registering is a transaction from this address, and it is the address
              that goes on the list. Disconnect to register a different one.
            </p>
            <button
              type="button"
              style={{ width: "100%" }}
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
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
                  connect({ connector }, { onSuccess: () => setOpen(false) })
                }
              >
                <span className="choice-name">{connector.name}</span>
                <span className="choice-meta">
                  {connector.uid === pendingUid
                    ? "waiting on the wallet…"
                    : "connect"}
                </span>
              </button>
            ))}
            {error && (
              <div className="alert" style={{ marginTop: 12 }}>
                {error.message.split("\n")[0]}
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}

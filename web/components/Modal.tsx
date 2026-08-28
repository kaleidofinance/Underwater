"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A real `<dialog>`, not a div pretending to be one.
 *
 * Escape closes it, focus is trapped inside it, the page behind it goes inert
 * and the backdrop is a first-class pseudo-element — all from the platform,
 * none of it reimplemented here (badly) with keydown handlers and z-index.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      // Fires for Escape and for `close()` alike, so the caller's state can
      // never drift out of step with the dialog's own.
      onClose={onClose}
      // A click that lands on the dialog element itself landed on the backdrop:
      // everything visible sits inside .modal-head / .modal-body.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {/* A closed dialog has no contents. The element itself stays mounted —
          the effect above needs something to call `showModal()` on — but what
          is inside it is built only once it opens.

          This was unconditional, so every page's HTML carried all three of the
          app's dialogs fully rendered, invisible and inert. Cheap, until one of
          them renders something the server cannot know: the wallet dialog's
          connector list comes partly from EIP-6963, which is wallets announcing
          themselves to the browser at runtime. The server has two connectors,
          a visitor with an extension has three, and React hydrated a closed
          dialog nobody had asked for and found the tree it was given did not
          match — for the most ordinary visitor there is, one holding a wallet.

          Why it showed up on `/swap` alone: same reason as `useHydratedChainId`
          in lib/hydration.ts. That route's `<Suspense>` boundary shifts its
          first client render past the announcement, while on other routes the
          first paint happens before it and both sides see two.

          Safe because nothing can be open on the first render — every caller
          drives `open` from its own `useState(false)`, so contents mount on an
          interaction, which is already after hydration. It is also when
          `showModal()` wants them there, for the focus it moves inside. */}
      {open && (
        <>
          <div className="modal-head">
            <span>{title}</span>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="modal-body">{children}</div>
        </>
      )}
    </dialog>
  );
}

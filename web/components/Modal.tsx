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
      <div className="modal-head">
        <span>{title}</span>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

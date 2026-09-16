import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Matches the Vanilla vehicle modal's max-w-lg. */
  width?: string;
}

/**
 * Modal, matching the Vanilla shell in js/pages/dashboard.js
 * (renderVehicleModal): same overlay colour, same card, same slideUp
 * animation, same close button.
 *
 * Two things the Vanilla version did not do, both of which are bugs a
 * keyboard or screen-reader user hits immediately:
 *   - Escape closes it
 *   - the page behind does not scroll while it is open
 *
 * Rendered through a portal so an ancestor's `overflow: hidden` or stacking
 * context cannot clip it -- the Vanilla modal was emitted inside the page
 * markup and relied on nothing above it ever creating one.
 */
export default function Modal({ open, title, onClose, children, width = "32rem" }: Props) {
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(15,23,42,0.55)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full card p-6"
        style={{ maxWidth: width, maxHeight: "90vh", overflowY: "auto", animation: "slideUp .2s ease" }}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-bold" style={{ fontFamily: "'Space Grotesk'" }}>
            {title}
          </h3>
          <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close">
            <i className="fas fa-xmark" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

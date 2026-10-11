import { useEffect, useRef, type ReactNode } from "react";

/**
 * Something looked at closely: a photo at full size, or a chart big enough to
 * read.
 *
 * One component for both, because they are the same interaction — a thing is
 * too small to study in place, so it opens over the page until dismissed.
 * Building a photo viewer and a chart expander separately is how a product
 * ends up with two overlays that close differently.
 *
 * WHAT IT HANDLES SO CALLERS DO NOT
 *
 *   - Escape, the backdrop and an explicit close button all dismiss it; on a
 *     phone the close button is the only one a thumb can rely on, so it is
 *     always there and always big enough.
 *   - The page behind does not scroll while it is open. Without that, a
 *     flick on a phone scrolls the page under the overlay and the thing you
 *     opened drifts away.
 *   - Focus moves in and returns to whatever opened it, so a keyboard user
 *     is not dropped at the top of the document on close.
 *   - Safe areas, for the Android app, where the status bar sits over the
 *     page.
 */
export default function Lightbox({
  open,
  onClose,
  title,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  /** Named for screen readers, and shown in the bar when given. */
  title?: string;
  children: ReactNode;
  testId?: string;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    returnTo.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    // Hold the page still underneath.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      // Back to the thumbnail that was clicked, not to the top of the page.
      returnTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="ds-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={title || "Enlarged view"}
      onClick={onClose}
      data-testid={testId}
    >
      <div className="ds-lightbox-bar">
        {title && <p className="ds-lightbox-title">{title}</p>}
        <button type="button" ref={closeRef} className="ds-lightbox-close" onClick={onClose} aria-label="Close">
          <i className="fas fa-xmark" aria-hidden />
        </button>
      </div>

      {/* Clicks inside the content must not dismiss it: a person pinching a
          photo or reading a chart is interacting, not asking to leave. */}
      <div className="ds-lightbox-body" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

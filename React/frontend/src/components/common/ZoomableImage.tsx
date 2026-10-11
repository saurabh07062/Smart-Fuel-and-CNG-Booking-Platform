import { useState } from "react";
import Lightbox from "./Lightbox";

/**
 * A picture you can tap to see properly.
 *
 * Station photos are shown at thumbnail size all over the app — a strip on a
 * card, a square in a list — which is exactly the size at which you cannot
 * tell whether the pump has the bay you need. Wrapping the thumbnail makes it
 * open full size, and makes it announce itself as something that opens rather
 * than as decoration.
 *
 * It is a real `<button>`, not a `<div onClick>`, so it is reachable by
 * keyboard and announced by a screen reader without any extra attributes.
 */
export default function ZoomableImage({
  src,
  alt,
  className,
  caption,
  testId,
}: {
  src: string;
  /** Empty for a decorative thumbnail; the caption names it in the viewer. */
  alt?: string;
  className?: string;
  /** Shown in the viewer's bar — the station's name, usually. */
  caption?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  // A broken image is not worth opening, so it stops being a button.
  if (failed) return null;

  return (
    <>
      <button
        type="button"
        className={`ds-zoomable ${className ?? ""}`}
        onClick={() => setOpen(true)}
        aria-label={caption ? `${caption} — view larger` : "View larger"}
        data-testid={testId}
      >
        <img src={src} alt={alt ?? ""} loading="lazy" onError={() => setFailed(true)} />
        <span className="ds-zoomable-hint" aria-hidden>
          <i className="fas fa-expand" />
        </span>
      </button>

      <Lightbox open={open} onClose={() => setOpen(false)} title={caption}>
        <img className="ds-lightbox-image" src={src} alt={alt ?? caption ?? ""} />
      </Lightbox>
    </>
  );
}

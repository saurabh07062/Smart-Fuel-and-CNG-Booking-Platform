import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

/**
 * "Are you booking fuel for multiple vehicles?"
 *
 * Asked once, right after a station is chosen, because that is the moment the
 * two journeys diverge: one vehicle goes to the four-step wizard, several go
 * to the fleet screen. Asking earlier (a permanent toggle somewhere) would put
 * a question in front of the many customers who only ever book one car;
 * asking later means the customer has already filled in a form they cannot use.
 *
 * It only ROUTES. Neither flow's logic lives here: "No" is the existing
 * /booking address with the existing query, unchanged, and "Yes" is
 * /fleet-booking with the station carried across so the fleet screen opens on
 * the pump they just picked.
 */
export interface BookingModeTarget {
  stationId: string;
  stationName?: string | null;
  /** Carried into the single-vehicle flow exactly as the caller built it. */
  singleQuery?: string;
  /** Preselects the fuel on the fleet screen, when the caller knows it. */
  fuelType?: string | null;
}

export default function BookingModeSheet({
  target,
  onClose,
}: {
  /** null keeps the sheet closed; setting it opens the question. */
  target: BookingModeTarget | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Escape closes it, and focus moves in so a keyboard user is not left
  // behind the overlay.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  const single = () => {
    onClose();
    navigate(`/booking?stationId=${target.stationId}${target.singleQuery ? `&${target.singleQuery}` : ""}`);
  };

  const fleet = () => {
    onClose();
    const params = new URLSearchParams({ stationId: target.stationId });
    if (target.stationName) params.set("stationName", target.stationName);
    if (target.fuelType) params.set("fuelType", target.fuelType);
    navigate(`/fleet-booking?${params.toString()}`);
  };

  return (
    <div className="cx-mode-overlay" role="presentation" onClick={onClose}>
      <div
        className="cx-mode-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-mode-title"
        tabIndex={-1}
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        data-testid="booking-mode-sheet"
      >
        <button type="button" className="cx-mode-close" onClick={onClose} aria-label="Close">
          <i className="fas fa-xmark" aria-hidden />
        </button>

        <h2 id="booking-mode-title" className="cx-mode-title">
          Are you booking fuel for multiple vehicles?
        </h2>
        {target.stationName && <p className="cx-mode-sub">{target.stationName}</p>}

        <div className="cx-mode-options">
          <button type="button" className="cx-mode-option" onClick={single} data-testid="choose-single">
            <span className="cx-mode-icon">
              <i className="fas fa-car-side" aria-hidden />
            </span>
            <span className="cx-mode-text">
              <strong>No, single vehicle</strong>
              <small>One slot, one vehicle — the usual booking.</small>
            </span>
            <i className="fas fa-chevron-right cx-mode-go" aria-hidden />
          </button>

          <button type="button" className="cx-mode-option" onClick={fleet} data-testid="choose-fleet">
            <span className="cx-mode-icon cx-mode-icon-alt">
              <i className="fas fa-truck-fast" aria-hidden />
            </span>
            <span className="cx-mode-text">
              <strong>Yes, fleet booking</strong>
              <small>Several vehicles in one visit, one group PIN, paid together at the pump.</small>
            </span>
            <i className="fas fa-chevron-right cx-mode-go" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

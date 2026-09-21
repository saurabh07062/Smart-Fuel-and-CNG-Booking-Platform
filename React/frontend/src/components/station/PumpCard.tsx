import { useNavigate } from "react-router-dom";
import type { NearbyStation } from "@/types";
import { directionsUrl } from "@/utils/navigation";
import { distanceNote } from "@/utils/distanceNote";

interface Props {
  station: NearbyStation;
  fuelType: string;
  isPrimary?: boolean;
}

/** "17:30" -> "5:30 PM". Ported from renderPumpCard()'s formatTime(). */
function formatTime(t?: string): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Wait-time buckets, unchanged: <=5 good, <=15 warn, else bad. */
function waitBucket(mins: number) {
  if (mins <= 5) return { token: "good", level: "low", label: "Low queue — quick fill" };
  if (mins <= 15) return { token: "warn", level: "medium", label: "Moderate queue" };
  return { token: "bad", level: "high", label: "High queue — consider an alternative" };
}

/**
 * Port of renderPumpCard() in js/pages/nearestPump.js.
 *
 * Every value shown is a field the server already decided -- distance,
 * estimatedWaitingTime, the per-fuel prices, preferredSlot,
 * recommendedAlternative. Nothing is recomputed here; that is what keeps the
 * KNN / smart-recommender results identical to the Vanilla app's.
 */
export default function PumpCard({ station: st, fuelType, isPrimary = false }: Props) {
  const navigate = useNavigate();
  // Same navigation link as every other Directions button (utils/navigation.ts);
  // it used to open a map search here, and "null,null" for a station with no position.
  const directions = directionsUrl(st.latitude, st.longitude);

  const searchedUnit = fuelType.toUpperCase() === "CNG" ? "/kg" : "/L";
  const searchedPrice =
    st._fuelPriceForDisplay != null ? `₹${st._fuelPriceForDisplay.toFixed(2)}` : "N/A";

  const offeredTypes = (st.fuelTypes ?? []).map((f) => f.toUpperCase());
  const wait = st.estimatedWaitingTime ?? 0;
  const bucket = waitBucket(wait);

  const preferredSlot = st.preferredSlot;
  const hasPreferredSlot = !!preferredSlot && preferredSlot.status === "AVAILABLE";
  const bookingSlot = preferredSlot?.slot ?? st.currentSlot?.slot ?? "";

  const fuelChip = (label: string, type: string, price?: number | null, unit?: string) => {
    const offered = offeredTypes.includes(type);
    return (
      <span key={type} className={`cx-price ${offered ? "" : "is-off"}`}>
        {label}
        {offered ? (
          <b>{price != null ? `₹${Number(price).toFixed(2)}${unit}` : "Available"}</b>
        ) : (
          <span>Not available</span>
        )}
      </span>
    );
  };

  const book = () => {
    const params = new URLSearchParams({
      stationId: st.stationId,
      stationName: st.stationName,
      fuelType,
      step: "1",
      ...(st._fuelPriceForDisplay != null ? { price: String(st._fuelPriceForDisplay) } : {}),
      ...(bookingSlot ? { timeSlot: bookingSlot } : {}),
    });
    navigate(`/booking?${params.toString()}`);
  };

  return (
    <article className={`cx-panel ${isPrimary ? "cx-pump-primary" : ""}`}>
      <div className="cx-panel-body">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-start gap-3 min-w-0">
            <span className={`cx-stat-icon ${st.isOpen ? "cx-tone-blue" : "cx-tone-slate"}`}>
              <i className="fas fa-gas-pump" aria-hidden />
            </span>
            <div className="min-w-0">
              <h3 className="cx-row-name" style={{ fontSize: 15 }}>
                {st.stationName}
              </h3>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                <i className="fas fa-location-dot mr-1" aria-hidden />
                {st.address}
              </p>
            </div>
          </div>
          <span className={`cx-tag ${st.isOpen ? "is-green" : "is-red"} flex-shrink-0`}>
            {st.isOpen ? "Open" : "Closed"}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="cx-metric is-soft">
            <p className="cx-metric-label">Distance</p>
            <p className="cx-metric-value">
              {st.distance}
              <small>km</small>
            </p>
            {distanceNote(st) && <p className="text-[11px] text-[var(--muted)] mt-0.5">{distanceNote(st)}</p>}
          </div>
          <div className="cx-metric is-soft">
            <p className="cx-metric-label">{fuelType} price</p>
            <p className="cx-metric-value" style={{ color: "var(--primary)" }}>
              {searchedPrice}
              {st._fuelPriceForDisplay != null && <small>{searchedUnit}</small>}
            </p>
          </div>
          <div className="cx-metric is-soft">
            <p className="cx-metric-label">Wait</p>
            <p className="cx-metric-value" style={{ color: `var(--status-${bucket.token})` }}>
              {wait}
              <small>min</small>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className={`queue-pill ${bucket.level}`}>
            <span className="dot" />
            {bucket.label}
          </span>
        </div>

        <div className="cx-price-row mb-3">
          {fuelChip("Petrol", "PETROL", st.petrolPrice, "/L")}
          {fuelChip("Diesel", "DIESEL", st.dieselPrice, "/L")}
          {fuelChip("CNG", "CNG", st.cngPrice, "/kg")}
        </div>

        {!st.isOpen ? (
          <div className="cx-status-banner t-bad mb-3">
            <span className="cx-stat-icon">
              <i className="fas fa-store-slash" aria-hidden />
            </span>
            <p className="cx-status-title">
              Currently closed{st.nextOpenTime ? ` · Opens ${st.nextOpenTime}` : ""}
            </p>
          </div>
        ) : st.canBook && hasPreferredSlot ? (
          <div className="cx-status-banner t-info mb-3">
            <span className="cx-stat-icon">
              <i className="fas fa-clock" aria-hidden />
            </span>
            <p className="cx-status-title">
              Next slot {formatTime(preferredSlot!.start)} – {formatTime(preferredSlot!.end)}
            </p>
          </div>
        ) : (
          <div className="cx-status-banner t-warn mb-3">
            <span className="cx-stat-icon">
              <i className="fas fa-hourglass-end" aria-hidden />
            </span>
            <p className="cx-status-title">{st.unavailableReason ?? "No booking slot left today"}</p>
          </div>
        )}

        {st.recommendedAlternative && (
          <div className="cx-status-banner t-good mb-3">
            <span className="cx-stat-icon">
              <i className="fas fa-bolt" aria-hidden />
            </span>
            <p className="cx-status-sub">
              Faster option: <b>{st.recommendedAlternative.name}</b> ({st.recommendedAlternative.distanceKm} km) —{" "}
              {st.recommendedAlternative.reason}
            </p>
          </div>
        )}
      </div>

      <div className="cx-panel-foot flex items-center gap-2">
        {st.canBook && hasPreferredSlot ? (
          <button type="button" className="btn btn-primary flex-1" onClick={book}>
            <i className="fas fa-calendar-check" aria-hidden /> Book Slot
          </button>
        ) : (
          <button type="button" className="btn btn-outline flex-1" disabled>
            Unavailable
          </button>
        )}
        <button
          type="button"
          className="cx-icon-btn"
          disabled={!directions}
          onClick={() => directions && window.open(directions, "_blank", "noopener,noreferrer")}
          title={directions ? "Directions" : "Location not set for this station"}
          aria-label="Directions"
        >
          <i className="fas fa-diamond-turn-right" aria-hidden />
        </button>
        <button
          type="button"
          className="cx-icon-btn"
          onClick={() => navigate(`/stations/${st.stationId}`)}
          title="Details"
          aria-label="Details"
        >
          <i className="fas fa-circle-info" aria-hidden />
        </button>
      </div>
    </article>
  );
}

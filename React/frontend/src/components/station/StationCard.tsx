import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { UiStation } from "@/types";
import { queueLabelOf, queueLevelOf } from "@/utils/format";

interface Props {
  station: UiStation;
  /** Row index, only used for the staggered entrance. */
  index?: number;
}

/**
 * One station in the list beside the map.
 *
 * A compact horizontal card: the details a customer compares at a glance
 * (open or closed, distance, live queue and wait, prices) sit in one
 * scan line, with Book as the primary action. Stations without a photo show
 * a small tinted pump tile instead of a large empty image area.
 */
export default function StationCard({ station: s, index = 0 }: Props) {
  const navigate = useNavigate();
  const [imageFailed, setImageFailed] = useState(false);
  const level = queueLevelOf(s.queueStatus);

  const openDetail = () => navigate(`/stations/${s.id}`);
  const book = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/booking?stationId=${s.id}`);
  };

  return (
    <article
      className="cx-station"
      style={{ animation: `slideUp .35s ease ${Math.min(index, 8) * 0.04}s both` }}
      onClick={openDetail}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openDetail();
        }
      }}
      tabIndex={0}
      aria-label={`${s.name}, ${s.open ? "open" : "closed"}`}
    >
      <div className={`cx-thumb ${s.open ? "" : "is-closed"}`}>
        <i className="fas fa-gas-pump" aria-hidden />
        {s.image && !imageFailed && (
          <img src={s.image} alt="" loading="lazy" onError={() => setImageFailed(true)} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="cx-row-name" style={{ fontSize: 15 }}>
              {s.name}
            </h3>
            <p className="cx-row-sub flex items-center gap-1.5">
              <i className="fas fa-location-dot text-[10px]" aria-hidden />
              <span className="truncate">{s.address}</span>
            </p>
          </div>
          <span className={`cx-tag ${s.open ? "is-green" : "is-red"} flex-shrink-0`}>
            {s.open ? "Open" : "Closed"}
          </span>
        </div>

        <div className="cx-meta mt-2">
          {s.distance != null && (
            <span>
              <i className="fas fa-route" aria-hidden /> {s.distance} km
            </span>
          )}
          <span className={`queue-pill ${level}`} title={queueLabelOf(s.queueStatus)}>
            <span className="dot" />
            {s.queue} in queue · {s.waitTime} min
          </span>
        </div>

        <div className="flex items-end justify-between gap-3 mt-3 flex-wrap">
          <div className="cx-price-row">
            {s.fuelTypes.slice(0, 3).map((f) => (
              <span className="cx-price" key={f}>
                {f}
                <b>₹{s.uiPrices[f as keyof typeof s.uiPrices] ?? "—"}</b>
              </span>
            ))}
          </div>
          <div className="flex gap-2 ml-auto">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                openDetail();
              }}
            >
              Details
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={!s.open} onClick={book}>
              <i className="fas fa-bolt" aria-hidden /> Book Now
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

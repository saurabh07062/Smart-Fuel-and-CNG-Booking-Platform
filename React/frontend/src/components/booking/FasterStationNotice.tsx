import { useCallback, useEffect, useState } from "react";
import { useResync, useSocketEvent } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { fetchBookingRecommendation, type BookingRecommendation } from "@/services/api/bookingApi";
import { getLastKnownUserCoords } from "@/utils/geo";
import { formatCurrency } from "@/utils/format";

interface Props {
  stationId: string;
  fuelType: string | null;
  quantity: number;
  date: string | null;
  timeSlot: string | null;
  onSwitch: (stationId: string, stationName: string) => void;
}

/**
 * The Smart Queue Recommender, shown on the review step once the whole
 * booking is known (station, fuel, quantity, date, slot).
 *
 * The decision is the server's (GET /api/v1/slots/recommend-alternative):
 * whether this station can actually take the booking, today's live line at
 * the slot, stock for this quantity and the drive from the customer. The
 * browser only renders it. A failed call shows nothing -- booking still works
 * and the server still refuses a booking it cannot take.
 */
export default function FasterStationNotice({ stationId, fuelType, quantity, date, timeSlot, onSwitch }: Props) {
  const [rec, setRec] = useState<BookingRecommendation | null>(null);
  // Bumped by a slot change at this station or a reconnect, so the decision
  // is re-asked with live data -- without blanking the notice in between.
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  useSocketEvent<{ stationId?: string }>(
    SOCKET_EVENTS.SLOT_UPDATED,
    (change) => {
      if (String(change?.stationId) === String(stationId)) bump();
    },
    [stationId, bump],
  );
  useResync(bump, [bump]);

  // A different booking is a different question: clear the old answer.
  useEffect(() => {
    setRec(null);
  }, [stationId, fuelType, quantity, date, timeSlot]);

  useEffect(() => {
    if (!fuelType || !date || !timeSlot) return;
    let cancelled = false;
    const coords = getLastKnownUserCoords();
    fetchBookingRecommendation({
      stationId,
      fuelType,
      quantity,
      date,
      timeSlot,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
    })
      .then((r) => {
        if (!cancelled) setRec(r);
      })
      .catch(() => {
        /* no notice */
      });
    return () => {
      cancelled = true;
    };
  }, [stationId, fuelType, quantity, date, timeSlot, version]);

  if (!rec) return null;
  const { target, alternative: alt } = rec;
  if (target.canBook && !alt) return null;

  return (
    <div
      className="p-4 rounded-2xl text-xs"
      style={{
        animation: "slideUp .3s ease",
        background: "var(--status-warn-bg)",
        border: "1px solid var(--status-warn)",
      }}
      role="status"
    >
      <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
        <span className="font-bold flex items-center gap-1.5 text-sm" style={{ color: "var(--status-warn)" }}>
          <i className="fas fa-bolt" aria-hidden /> Smart Queue Recommender
        </span>
        {alt && (
          <span className="cx-tag is-green">
            <i className="fas fa-clock" aria-hidden />{" "}
            {alt.timeSavedMinutes !== null ? `Saves ~${alt.timeSavedMinutes} min` : "Can take this booking"}
          </span>
        )}
      </div>

      <p className="mb-3 leading-relaxed" style={{ color: "var(--text2)" }}>
        {target.canBook ? (
          <>
            <strong>{target.name}</strong>: about <strong>{target.waitMinutes} min</strong> wait at {timeSlot},{" "}
            {target.totalTripTimeMinutes} min in total.{" "}
          </>
        ) : (
          <>
            <strong>{target.name}</strong> cannot take this booking: {target.unavailableReason}.{" "}
          </>
        )}
        {alt ? (
          <>
            <strong>{alt.name}</strong> ({alt.distanceKm} km, ~{alt.waitMinutes} min wait
            {alt.price !== null ? `, ${formatCurrency(alt.price)}/unit` : ""}) {alt.reason}.
          </>
        ) : (
          <>No nearby station can take it either. Try another slot, date or quantity.</>
        )}
      </p>

      {alt && (
        <button
          type="button"
          className="btn btn-sm btn-primary w-full"
          onClick={() => onSwitch(alt.stationId, alt.name)}
        >
          <i className="fas fa-route" aria-hidden /> Switch to {alt.name}
        </button>
      )}
    </div>
  );
}

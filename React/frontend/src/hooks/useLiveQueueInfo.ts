import { useMemo } from "react";
import { useBookingStore } from "@/store/bookingStore";
import { useSocketEvent, useWatchStations } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { coalesce } from "@/utils/coalesce";

const ACTIVE = ["upcoming", "serving", "waitlisted"];

/**
 * Keeps each active booking's queueInfo (vehicles ahead, position, wait,
 * start -- computed by the server, services/queue/queueInfo.js) current.
 *
 * Joins the rooms of the stations the customer has an active booking at, and
 * refetches the bookings whenever the line there moves: someone books or
 * cancels (slot:updated), a car starts or finishes, or the server pushes this
 * customer's own turn (eta_update). A burst of events costs one or two
 * requests (utils/coalesce.ts), and nothing is fetched without an active booking.
 */
export function useLiveQueueInfo() {
  const bookings = useBookingStore((s) => s.bookings);
  const load = useBookingStore((s) => s.load);

  const stationIds = useMemo(
    () =>
      [
        ...new Set(
          bookings
            .filter((b) => ACTIVE.includes(String(b.status)))
            .map((b) => String(typeof b.station === "object" && b.station ? (b.station as { _id?: string })._id : b.station))
            .filter((id) => id && id !== "undefined"),
        ),
      ],
    [bookings],
  );
  useWatchStations(stationIds);

  const refresh = useMemo(() => coalesce(() => load()), [load]);
  const onLineMoved = (payload?: { stationId?: string }) => {
    if (stationIds.length === 0) return;
    if (payload?.stationId && !stationIds.includes(String(payload.stationId))) return;
    refresh();
  };

  useSocketEvent(SOCKET_EVENTS.SLOT_UPDATED, onLineMoved, [stationIds, refresh]);
  useSocketEvent(SOCKET_EVENTS.ETA_UPDATE, () => onLineMoved(), [stationIds, refresh]);
}

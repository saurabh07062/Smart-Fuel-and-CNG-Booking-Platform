import { useState } from "react";
import type { Booking } from "@/types";
import { stationCheckIn } from "@/services/api/bookingApi";
import { toApiError } from "@/services/api/apiClient";
import { useBookingStore } from "@/store/bookingStore";
import { pushToast } from "@/store/toastStore";
import { getFreshUserCoords } from "@/utils/geo";

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * "Check In at Petrol Pump": on reaching the station, the customer marks
 * their arrival. The phone's position is sent and the server decides
 * (backend services/booking/stationArrival.js): today, the check-in window,
 * and within reach of the pump. The arrival time fixes the order the
 * attendant serves customers in; fuelling itself starts with the PIN.
 */
export default function StationCheckInCard({ booking: b }: { booking: Booking }) {
  const loadBookings = useBookingStore((s) => s.load);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Only for a booking still waiting for its turn.
  if (b.status !== "upcoming" || b.arrivalTime) return null;

  if (b.stationCheckInAt) {
    return (
      <div className="cx-status-banner t-good mb-4" role="status" data-testid="station-checked-in">
        <span className="cx-stat-icon">
          <i className="fas fa-location-dot" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="cx-status-title">Checked in at the pump · {clock(b.stationCheckInAt)}</p>
          <p className="cx-status-sub">You are in line by arrival time. Show your PIN or QR to the attendant when called.</p>
        </div>
      </div>
    );
  }

  const checkIn = async () => {
    setBusy(true);
    setProblem(null);
    try {
      // A short wait for GPS. Without a position the request still goes: the
      // server decides (it refuses unless its testing mode is on).
      const fix = await getFreshUserCoords({ timeout: 5000 });
      const r = await stationCheckIn(String(b._id), fix?.lat ?? null, fix?.lng ?? null);
      pushToast(r.msg || "Checked in at the pump", "success");
      await loadBookings();
    } catch (err) {
      setProblem(toApiError(err).msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4" data-testid="station-check-in">
      <button type="button" className="btn btn-primary btn-block" onClick={() => void checkIn()} disabled={busy}>
        <i className={`fas ${busy ? "fa-spinner fa-spin" : "fa-location-crosshairs"}`} aria-hidden />
        {busy ? "Checking your location…" : "Check In at Petrol Pump"}
      </button>
      <p className="text-[12px] mt-1.5" style={{ color: problem ? "var(--danger)" : "var(--muted)" }} role={problem ? "alert" : undefined}>
        {problem ?? "Tap when you reach the station. Customers are served in the order they check in."}
      </p>
    </div>
  );
}

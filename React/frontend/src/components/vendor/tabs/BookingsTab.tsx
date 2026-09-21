import { useState } from "react";
import * as api from "@/services/api/vendorApi";
import { useFuelingCountdown } from "@/hooks/useFuelingCountdown";
import type { VendorBooking } from "@/services/api/vendorApi";
import { useVendorStore } from "@/store/vendorStore";
import { pushToast } from "@/store/toastStore";
import { toApiError } from "@/services/api/apiClient";
import { formatDate, formatINR } from "@/utils/vendorFormat";
import { bookingRef, canCollectAtPump, paymentState, PAYMENT_TONE_COLOR } from "@/utils/payment";
import { VendorEmpty, VendorHeading } from "../VendorBits";
import WalkInPanel from "../WalkInPanel";
import CollectPaymentModal, { type CollectionMethod } from "../CollectPaymentModal";

const STATUS_CLS: Record<string, string> = {
  completed: "bg-emerald-900/30 text-emerald-400",
  upcoming: "bg-blue-900/30 vm-accent-text",
  serving: "bg-blue-900/30 vm-accent-text",
  cancelled: "bg-red-900/30 text-red-400",
  no_show: "bg-red-900/30 text-red-400",
  expired: "bg-red-900/30 text-red-400",
};

const unitOf = (fuel?: string) => (String(fuel).toLowerCase() === "cng" ? "kg" : "L");

/**
 * Port of renderVendorBookingsTab() + updateBookingStatus().
 *
 * This is the vendor half of the booking real-time flow: "Start Fueling"
 * checks the car in at the pump. The backend locks the nozzle: if it is free
 * the booking moves to `serving` (fuelingStartTime stamped server-side, the
 * customer's page switches to the live countdown); if another car is at the
 * nozzle the car waits and starts automatically when it is released.
 *
 * Payment is a separate, recorded step. A pay-at-the-pump booking that is being
 * fuelled or has finished shows "Due at pump" and a Collect button; the server
 * records the collection once, and only then does the booking count as revenue.
 * Every row comes from the database (GET station bookings), refreshed on each
 * booking socket event (pages/vendor/VendorPanel.tsx).
 */
export default function BookingsTab() {
  const stations = useVendorStore((s) => s.stations);
  const selectedStation = useVendorStore((s) => s.selectedStation);
  const bookings = useVendorStore((s) => s.stationBookings);
  const viewStationBookings = useVendorStore((s) => s.viewStationBookings);
  const refreshLive = useVendorStore((s) => s.refreshLive);
  const backToStationList = useVendorStore((s) => s.backToStationList);

  const setStatus = async (bookingId: string, status: string) => {
    if (!selectedStation) return;
    try {
      const r = await api.updateVendorBookingStatus(selectedStation, bookingId, status);
      pushToast(r.msg || `Booking ${status}`, r.waitingForNozzle ? "info" : "success");
      await viewStationBookings(selectedStation);
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  // Check-in with the customer's 4-digit code: the server starts fueling and
  // completes it automatically; this page follows along over the socket.
  const [code, setCode] = useState("");
  const [checkingIn, setCheckingIn] = useState(false);
  const checkIn = async () => {
    if (!/^\d{4}$/.test(code)) {
      pushToast("Enter the customer's 4-digit code", "error");
      return;
    }
    setCheckingIn(true);
    try {
      const r = await api.checkInWithCode(code);
      pushToast(r.msg || (r.queued ? "Checked in. Waiting for the nozzle." : "Fueling started."), r.queued ? "info" : "success");
      setCode("");
      // The car is at the pump (fueling, or waiting for the nozzle) on a
      // pay-at-the-pump booking: ask how it was paid.
      const b = r.booking;
      const stationId = typeof b?.station === "object" ? b?.station?._id : b?.station;
      if ((r.started || r.queued) && b?._id && stationId && b.payMethod === "station" && b.paymentStatus === "due_at_station") {
        setCollecting({
          stationId: String(stationId),
          bookingId: String(b._id),
          ref: bookingRef(b),
          amount: b.amount || 0,
          title: r.started ? "Fueling started" : "Checked in · waiting for the nozzle",
        });
      }
      // A silent refresh: a loading refresh swaps this tab for a spinner,
      // which unmounts it and would close the payment popup just opened.
      await refreshLive();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setCheckingIn(false);
    }
  };

  // The booking whose "How was it paid?" popup is open.
  const [collecting, setCollecting] = useState<{
    stationId: string;
    bookingId: string;
    ref: string;
    amount: number;
    title?: string;
  } | null>(null);
  const [collectBusy, setCollectBusy] = useState(false);

  const collect = (b: VendorBooking) => {
    if (!selectedStation) return;
    setCollecting({ stationId: selectedStation, bookingId: String(b._id), ref: bookingRef(b), amount: b.amount || 0 });
  };

  const recordCollection = async (method: CollectionMethod) => {
    if (!collecting) return;
    setCollectBusy(true);
    try {
      const r = await api.collectVendorBookingPayment(collecting.stationId, collecting.bookingId, method);
      pushToast(r.msg || "Payment recorded", r.alreadyPaid ? "info" : "success");
      setCollecting(null);
      await refreshLive();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setCollectBusy(false);
    }
  };

  const collectModal = (
    <CollectPaymentModal
      open={collecting !== null}
      bookingRef={collecting?.ref ?? ""}
      amount={collecting?.amount ?? 0}
      title={collecting?.title}
      busy={collectBusy}
      onCollect={(m) => void recordCollection(m)}
      onLater={() => {
        setCollecting(null);
        pushToast("Payment still due. Use Collect in the bookings list when it is paid.", "info");
      }}
    />
  );

  if (stations.length === 0) {
    return (
      <>
        <VendorHeading title="Bookings Management" />
        <VendorEmpty icon="fa-calendar-check" message="Add a station first to view bookings." />
      </>
    );
  }

  if (!selectedStation) {
    return (
      <>
        <VendorHeading title="Bookings Management" />
        <div className="vm-bg-surface rounded-2xl border vm-border p-6 mb-6">
          <h3 className="text-sm font-bold vm-text-muted mb-4">Select a station to view bookings:</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {stations.map((s) => (
              <button
                key={String(s._id)}
                onClick={() => void viewStationBookings(String(s._id))}
                className="vm-bg-ground vm-hover border vm-border rounded-xl p-4 text-left transition-colors flex items-center gap-3"
              >
                <i className="fas fa-gas-pump text-indigo-400 text-xl" aria-hidden />
                <div>
                  <p className="font-bold text-sm">{s.name}</p>
                  <p className="text-xs vm-text-muted">{s.address || "No address"}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  const station = stations.find((s) => String(s._id) === selectedStation);

  return (
    <>
      {collectModal}
      <VendorHeading title="Bookings Management" />

      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={backToStationList}
          className="vm-text-muted transition-colors text-sm flex items-center gap-2"
        >
          <i className="fas fa-arrow-left" aria-hidden /> Back
        </button>
        <h3 className="vm-panel-title">{station ? station.name : "Station"} Bookings</h3>
      </div>

      <form
        className="vm-bg-surface rounded-2xl border vm-border p-5 mb-6 flex flex-wrap items-center gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void checkIn();
        }}
      >
        <div className="flex items-center gap-3 min-w-[220px] flex-1">
          <span className="w-10 h-10 rounded-xl vm-accent/20 flex items-center justify-center">
            <i className="fas fa-key vm-accent-text" aria-hidden />
          </span>
          <div>
            <p className="font-bold text-sm vm-text">Check in a customer</p>
            <p className="text-xs vm-text-muted">
              Enter their 4-digit code. Fueling starts and completes automatically (Petrol/Diesel 40 s, CNG 5 min).
            </p>
          </div>
        </div>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          aria-label="Customer verification code"
          placeholder="----"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
          className="w-32 text-center text-2xl font-mono tracking-[0.3em] font-bold vm-input px-3 py-2 vm-text"
        />
        <button type="submit" disabled={checkingIn} className="vm-btn vm-btn-primary">
          <i className={`fas ${checkingIn ? "fa-spinner fa-spin" : "fa-gas-pump"} mr-2`} aria-hidden />
          {checkingIn ? "Checking in…" : "Start Fueling"}
        </button>
      </form>

      <WalkInPanel stationId={selectedStation} fuelTypes={station?.fuelTypes ?? []} />

      {bookings.length === 0 ? (
        <VendorEmpty icon="fa-inbox" message="No bookings for this station yet." />
      ) : (
        <div className="vm-bg-surface rounded-2xl border vm-border overflow-hidden">
          <div className="w-full overflow-x-auto">
            <table className="vm-table">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Customer</th>
                  <th>Vehicle</th>
                  <th>Fuel</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => {
                  const customer = typeof b.user === "object" && b.user ? b.user : null;
                  const ref = bookingRef(b);
                  // Checked in at the pump while the nozzle is busy: the backend
                  // starts this car automatically when the nozzle is released.
                  const waitingAtPump = b.status === "upcoming" && Boolean(b.arrivalTime);
                  const cls = waitingAtPump
                    ? "bg-yellow-900/30 text-yellow-400"
                    : (STATUS_CLS[b.status] ?? "bg-yellow-900/30 text-yellow-400");
                  const label = b.status === "serving" ? "In Progress" : waitingAtPump ? "At pump · waiting" : b.status || "unknown";
                  const payment = paymentState(b);
                  const unit = unitOf(b.fuelType);
                  return (
                    <tr key={String(b._id)} data-testid={`booking-row-${b._id}`}>
                      <td>
                        <p className="font-mono text-xs font-bold vm-text" title={String(b._id)}>
                          {ref}
                        </p>
                        <p className="text-xs vm-text-muted">
                          {b.bookingDate ? `${b.bookingDate} · ${b.timeSlot || ""}` : formatDate(b.createdAt)}
                        </p>
                      </td>
                      <td>
                        <p className="font-bold vm-text">{customer?.name || "Unknown"}</p>
                        <p className="text-xs vm-text-muted">{customer?.phone || ""}</p>
                      </td>
                      <td>
                        <p className="text-sm vm-text">{b.vehiclePlate || "—"}</p>
                        <p className="text-xs vm-text-muted">{b.vehicleName || b.vehicleType || ""}</p>
                      </td>
                      <td>
                        <p className="text-sm vm-text">
                          {b.fuelType || "N/A"} · {b.quantity || 0} {unit}
                        </p>
                        {typeof b.price === "number" && (
                          <p className="text-xs vm-text-muted">
                            {formatINR(b.price)}/{unit}
                          </p>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-emerald-400">{formatINR(b.amount || 0)}</td>
                      <td>
                        <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${cls}`}>
                          {label}
                        </span>
                        {b.status === "serving" && <FuelingTimer booking={b} />}
                      </td>
                      <td>
                        <span className="text-xs font-bold" style={{ color: PAYMENT_TONE_COLOR[payment.tone] }}>
                          {payment.label}
                        </span>
                      </td>
                      <td>
                        <div className="flex items-center gap-1 flex-wrap">
                          {b.status === "upcoming" && (
                            <>
                              {waitingAtPump ? (
                                <span
                                  title="Checked in. Starts automatically when the nozzle is released"
                                  className="w-8 h-8 rounded-lg text-yellow-400 border border-yellow-700/50 inline-flex items-center justify-center"
                                >
                                  <i className="fas fa-hourglass-half text-xs" aria-hidden />
                                </span>
                              ) : (
                                <button
                                  onClick={() => void setStatus(String(b._id), "serving")}
                                  title="Start Fueling"
                                  aria-label="Start fueling"
                                  className="w-8 h-8 rounded-lg vm-accent-text border border-blue-700/50 transition-colors inline-flex items-center justify-center"
                                >
                                  <i className="fas fa-gas-pump text-xs" aria-hidden />
                                </button>
                              )}
                              <button
                                onClick={() => void setStatus(String(b._id), "cancelled")}
                                title="Reject"
                                aria-label="Reject booking"
                                className="w-8 h-8 rounded-lg bg-red-600/20 text-red-400 border border-red-700/50 transition-colors inline-flex items-center justify-center"
                              >
                                <i className="fas fa-times text-xs" aria-hidden />
                              </button>
                            </>
                          )}
                          {b.status === "completed" && (
                            <a
                              href={`/api/invoices/${String(b._id)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open invoice for ${ref}`}
                              className="h-8 px-2 rounded-lg vm-accent-text border border-blue-700/50 transition-colors inline-flex items-center gap-1 text-[11px] font-bold"
                            >
                              <i className="fas fa-file-invoice text-xs" aria-hidden /> Invoice
                            </a>
                          )}
                          {canCollectAtPump(b) && (
                            <button
                              onClick={() => void collect(b)}
                              aria-label={`Collect payment for ${ref}`}
                              className="h-8 px-2 rounded-lg bg-emerald-600/20 text-emerald-400 border border-emerald-700/50 transition-colors inline-flex items-center gap-1 text-[11px] font-bold"
                            >
                              <i className="fas fa-hand-holding-dollar text-xs" aria-hidden /> Collect {formatINR(b.amount || 0)}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Live time left on a fill, from the server's start time and duration. At 0
 * the server completes the booking and this row refreshes to "completed" over
 * the socket -- there is no manual complete step.
 */
function FuelingTimer({ booking }: { booking: VendorBooking }) {
  const { label, finished, progress } = useFuelingCountdown(booking);
  return (
    <div className="mt-1.5 w-24" data-testid="fueling-timer">
      <p className="font-mono text-xs font-bold vm-accent-text" role="timer">
        {finished ? "Completing…" : `${label} left`}
      </p>
      <div className="h-1 rounded-full overflow-hidden vm-bg-ground mt-1">
        <div className="h-full rounded-full vm-accent" style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

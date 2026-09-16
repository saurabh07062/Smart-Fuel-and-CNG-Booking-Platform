import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Booking } from "@/types";
import Layout from "@/components/layout/Layout";
import Loader from "@/components/common/Loader";
import EmptyState from "@/components/common/EmptyState";
import RouteMap from "@/components/maps/RouteMap";
import ServiceCountdown from "@/components/booking/ServiceCountdown";
import BookingQrCard from "@/components/booking/BookingQrCard";
import UpiPaymentCard from "@/components/booking/UpiPaymentCard";
import { useBookingStore } from "@/store/bookingStore";
import { useStationStore } from "@/store/stationStore";
import { useLocationStore } from "@/store/locationStore";
import { pushToast } from "@/store/toastStore";
import { cancelBooking as apiCancelBooking } from "@/services/api/bookingApi";
import { toApiError } from "@/services/api/apiClient";
import { formatCurrency, isSlotElapsed } from "@/utils/format";
import { resolveBookingStation } from "@/utils/station";
import { getVehicleIcon } from "@/utils/vehicle";
import { getFreshUserCoords, haversineKm } from "@/utils/geo";
import { istDateKey } from "@/utils/businessTime";
import { paymentState } from "@/utils/payment";
import { useWatchStation } from "@/hooks/useSocket";

const ACTIVE_STATUSES = ["upcoming", "serving", "waitlisted"];

const NOZZLE_STATUS: Record<string, string> = {
  upcoming: "Reserved",
  serving: "In Use",
  completed: "Free",
  cancelled: "Free",
  no_show: "Free",
  expired: "Free",
};

type Tone = "good" | "bad" | "warn" | "info";
const TONE_ICON_CLASS: Record<Tone, string> = {
  good: "cx-tone-green",
  bad: "cx-tone-red",
  warn: "cx-tone-amber",
  info: "cx-tone-blue",
};
const TONE_TAG_CLASS: Record<Tone, string> = {
  good: "is-green",
  bad: "is-red",
  warn: "is-amber",
  info: "is-blue",
};

interface DetailRow {
  label: string;
  value: string;
  icon: string;
}

/** The icon+label+value rows every variant of this page shares. */
function DetailList({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="cx-facts">
      {rows.map(({ label, value, icon }) => (
        <div className="cx-fact" key={label}>
          <dt>
            <i className={`fas ${icon}`} aria-hidden />
            {label}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "2026-09-10" -> "Thu, 10 Sept 2026". Falls back to the raw value. */
function formatDay(date: string): string {
  if (!date) return "—";
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/**
 * Port of renderConfirmation() in js/pages/booking.js.
 *
 * All five states are preserved: no booking, cancelled/rejected, completed,
 * serving (live countdown), and the active reservation with its route card,
 * mini-map and PIN.
 *
 * The booking is addressed by id in the URL. The fallback to "the first
 * active booking, else the first booking" is kept only for the bare
 * /confirmation path (the sidebar's "My QR Pass" link); an explicit
 * /confirmation/:id always shows that id.
 */
export default function Confirmation() {
  const { id } = useParams();
  const navigate = useNavigate();

  const bookings = useBookingStore((s) => s.bookings);
  const loading = useBookingStore((s) => s.loading);
  const loadBookings = useBookingStore((s) => s.load);
  const stations = useStationStore((s) => s.stations);
  const loadStations = useStationStore((s) => s.load);
  const userCoords = useLocationStore((s) => s.coords);
  const setCoords = useLocationStore((s) => s.setCoords);

  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void loadBookings().finally(() => setBooted(true));
    if (stations.length === 0) void loadStations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Ask for a fresh fix the moment this page opens, so the route starts from
   * where the user actually is rather than a stale last-session point. A
   * denial leaves the last known value in place and the card offers a retry.
   */
  useEffect(() => {
    let cancelled = false;
    void getFreshUserCoords().then((fix) => {
      if (!cancelled && fix) setCoords(fix.lat, fix.lng);
    });
    return () => {
      cancelled = true;
    };
  }, [setCoords]);

  const booking: Booking | null = useMemo(() => {
    if (id) return bookings.find((b) => String(b._id) === String(id)) ?? null;
    const active = bookings.filter(
      (b) => ACTIVE_STATUSES.includes(b.status) && !isSlotElapsed(b.bookingDate, b.timeSlot),
    );
    return active[0] ?? bookings[0] ?? null;
  }, [bookings, id]);

  // This booking's station room carries its live queue and slot changes.
  useWatchStation(
    booking
      ? ((typeof booking.station === "object" && booking.station ? booking.station._id : booking.station) ?? null)
      : null,
  );

  const retryLocation = async () => {
    const fix = await getFreshUserCoords();
    if (fix) setCoords(fix.lat, fix.lng);
    else pushToast("Please allow location access to show the route.", "error");
  };

  const onCancel = async (bookingId: string) => {
    if (!window.confirm("Are you sure you want to cancel this booking?")) return;
    try {
      await apiCancelBooking(bookingId);
      pushToast("Booking cancelled successfully", "success");
      await loadBookings();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  if (!booted || (loading && bookings.length === 0)) {
    return (
      <Layout>
        <Loader label="Loading your booking…" />
      </Layout>
    );
  }

  // 1. No booking at all.
  if (!booking || !booking.status) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto pt-4 md:pt-10">
          <section className="cx-panel">
            <EmptyState
              icon="fa-ticket"
              title="No Active Booking"
              subtitle="You do not have any active fuel slot reservations right now."
              action={
                <div className="flex justify-center gap-2 flex-wrap">
                  <button className="btn btn-primary btn-sm" onClick={() => navigate("/stations")}>
                    <i className="fas fa-gas-pump" aria-hidden /> Find Nearby Stations
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={() => navigate("/dashboard")}>
                    <i className="fas fa-home" aria-hidden /> Dashboard
                  </button>
                </div>
              }
            />
          </section>
        </div>
      </Layout>
    );
  }

  const b = booking;
  const bookingId = String(b._id);
  const shortRef = bookingId.slice(-8).toUpperCase();
  const st = resolveBookingStation(b, stations);
  const fuelType = b.fuelType || "Petrol";
  const qty = b.quantity ?? 5;
  const date = b.bookingDate || (b.createdAt ? b.createdAt.slice(0, 10) : "");
  const time = b.timeSlot || "10:00 AM";
  // "My Bike · MH12AB1234" when the booking carries the vehicle snapshot;
  // older bookings only ever had the plate, and some have neither.
  const vehicle = [b.vehicleName, b.vehiclePlate].filter(Boolean).join(" · ") || "Not recorded";
  const vehicleIcon = getVehicleIcon(b.vehicleType || "Car");
  const amount = b.amount ?? 0;
  const payment = paymentState(b);

  /** Back link + title row shared by every state. */
  const pageHead = (tone: Tone, icon: string, title: string, subtitle: string, badge: string) => (
    <>
      <button type="button" className="cx-back" onClick={() => navigate("/dashboard")}>
        <i className="fas fa-arrow-left" aria-hidden /> Back to Dashboard
      </button>
      <div className="cx-page-head">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`cx-stat-icon ${TONE_ICON_CLASS[tone]}`} style={{ width: 48, height: 48, fontSize: 18 }}>
            <i className={`fas ${icon}`} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="cx-title flex items-center gap-2 flex-wrap">
              {title} <span className={`cx-tag ${TONE_TAG_CLASS[tone]}`}>{badge}</span>
            </h1>
            <p className="cx-subtitle">{subtitle}</p>
          </div>
        </div>
        <span className="cx-plate" title={bookingId}>
          Ref #{shortRef}
        </span>
      </div>
    </>
  );

  /** Cancelled / completed share one layout with different tokens and copy. */
  const terminalView = (
    tone: Tone,
    icon: string,
    title: string,
    subtitle: string,
    badge: string,
    amountLabel: string,
    actionLabel: string,
  ) => (
    <Layout>
      <div className="max-w-2xl mx-auto">
        {pageHead(tone, icon, title, subtitle, badge)}
        <section className="cx-panel" style={{ animation: "slideUp .4s ease" }}>
          <div className="cx-panel-head">
            <h2 className="cx-panel-title">
              <i className="fas fa-receipt" aria-hidden /> Booking details
            </h2>
          </div>
          <div className="cx-panel-body">
            <DetailList
              rows={[
                { label: "Station", value: st.name, icon: "fa-gas-pump" },
                { label: "Date", value: formatDay(date), icon: "fa-calendar" },
                { label: "Slot", value: time, icon: "fa-clock" },
                { label: "Fuel Type", value: fuelType, icon: "fa-droplet" },
                { label: "Quantity", value: `${qty} Litres`, icon: "fa-gauge" },
                { label: "Vehicle", value: vehicle, icon: vehicleIcon },
                { label: "Payment", value: payment.label, icon: "fa-wallet" },
              ]}
            />
            <hr className="cx-split" />
            <div className="cx-total">
              <span className="cx-total-label">{amountLabel}</span>
              <span className="cx-total-value">{formatCurrency(amount)}</span>
            </div>
          </div>
          <div className="cx-panel-foot grid grid-cols-2 gap-3">
            <button className="btn btn-primary btn-block" onClick={() => navigate("/stations")}>
              <i className="fas fa-gas-pump" aria-hidden /> {actionLabel}
            </button>
            <button className="btn btn-outline btn-block" onClick={() => navigate("/dashboard")}>
              <i className="fas fa-home" aria-hidden /> Dashboard
            </button>
          </div>
        </section>
      </div>
    </Layout>
  );

  // 2. Cancelled or rejected.
  if (b.status === "cancelled") {
    return terminalView(
      "bad",
      "fa-circle-xmark",
      "Booking Cancelled",
      "This fuel slot reservation has been cancelled and is no longer active.",
      "Cancelled",
      "Amount",
      "Book New Slot",
    );
  }

  // 3. Completed.
  if (b.status === "completed") {
    return terminalView(
      "good",
      "fa-circle-check",
      "Booking Completed",
      String(fuelType).toLowerCase() === "cng"
        ? "Your CNG service has been completed successfully."
        : "Thank you for fueling with FuelMart! Your order is complete.",
      "Completed",
      b.paymentStatus === "paid" ? "Amount Paid" : "Amount Due at Pump",
      "Book Fuel Again",
    );
  }

  // 3b. Service in progress -- the live countdown to the backend sweep.
  if (b.status === "serving") {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto">
          <button type="button" className="cx-back" onClick={() => navigate("/dashboard")}>
            <i className="fas fa-arrow-left" aria-hidden /> Back to Dashboard
          </button>
          <ServiceCountdown booking={b} />
          <section className="cx-panel" style={{ animation: "slideUp .55s ease" }}>
            <div className="cx-panel-head">
              <h2 className="cx-panel-title">
                <i className="fas fa-receipt" aria-hidden /> Booking details
              </h2>
              <span className="cx-tag is-amber">In Progress</span>
            </div>
            <div className="cx-panel-body">
              <DetailList
                rows={[
                  { label: "Station", value: st.name, icon: "fa-gas-pump" },
                  { label: "Fuel Type", value: fuelType, icon: "fa-droplet" },
                  { label: "Quantity", value: `${qty} Litres`, icon: "fa-gauge" },
                  { label: "Vehicle", value: vehicle, icon: vehicleIcon },
                  { label: "Amount", value: formatCurrency(amount), icon: "fa-receipt" },
                  { label: "Payment", value: payment.label, icon: "fa-wallet" },
                ]}
              />
            </div>
          </section>
        </div>
      </Layout>
    );
  }

  // 3c. On the waitlist for a full slot.
  if (b.status === "waitlisted") {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto">
          {pageHead(
            "warn",
            "fa-hourglass-half",
            "On the Waitlist",
            `${time} at ${st.name} is full. If the booking ahead is cancelled or missed, the slot becomes yours automatically and you'll be notified with your PIN.`,
            b.waitlistPosition ? `#${b.waitlistPosition} in line` : "Waitlisted",
          )}
          <section className="cx-panel" style={{ animation: "slideUp .4s ease" }}>
            <div className="cx-panel-head">
              <h2 className="cx-panel-title">
                <i className="fas fa-receipt" aria-hidden /> Waitlist request
              </h2>
            </div>
            <div className="cx-panel-body">
              <DetailList
                rows={[
                  { label: "Station", value: st.name, icon: "fa-gas-pump" },
                  { label: "Date", value: formatDay(date), icon: "fa-calendar" },
                  { label: "Slot", value: time, icon: "fa-clock" },
                  {
                    label: "Position",
                    value: b.waitlistPosition ? `#${b.waitlistPosition} for this slot` : "—",
                    icon: "fa-list-ol",
                  },
                  { label: "Fuel Type", value: fuelType, icon: "fa-droplet" },
                  { label: "Quantity", value: `${qty} Litres`, icon: "fa-gauge" },
                  { label: "Vehicle", value: vehicle, icon: vehicleIcon },
                  { label: "Payment", value: "At the station, if you get the slot", icon: "fa-wallet" },
                ]}
              />
              <hr className="cx-split" />
              <div className="cx-total">
                <span className="cx-total-label">Amount if confirmed</span>
                <span className="cx-total-value">{formatCurrency(amount)}</span>
              </div>
            </div>
            <div className="cx-panel-foot grid grid-cols-2 gap-3">
              <button className="btn btn-danger-outline btn-block" onClick={() => onCancel(bookingId)}>
                <i className="fas fa-circle-xmark" aria-hidden /> Leave Waitlist
              </button>
              <button className="btn btn-outline btn-block" onClick={() => navigate("/dashboard")}>
                <i className="fas fa-home" aria-hidden /> Dashboard
              </button>
            </div>
          </section>
        </div>
      </Layout>
    );
  }

  // 4. Active reservation, with the live route card.
  const hasValidRoute = st.hasValidCoords && !!userCoords;
  let distKm: number | null = null;
  let driveTimeMin: number | null = null;
  let etaTime: string | null = null;
  let gmapsUrl: string | null = null;

  if (hasValidRoute && userCoords && st.coordinates) {
    distKm = parseFloat(haversineKm(userCoords, st.coordinates).toFixed(2));
    // 25 km/h urban average -- the Vanilla figure, unchanged.
    driveTimeMin = Math.max(1, Math.round((distKm / 25) * 60));
    etaTime = new Date(Date.now() + driveTimeMin * 60000).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    // No origin= on purpose: Google Maps uses the device's own live GPS,
    // which is more reliable than anything this app could pass along.
    gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}&travelmode=driving`;
  }

  const estDuration = b.serviceDurationSeconds
    ? b.serviceDurationSeconds >= 60
      ? `${Math.round(b.serviceDurationSeconds / 60)} min`
      : `${b.serviceDurationSeconds} sec`
    : null;
  const estCompletion = b.bookingEndTime
    ? new Date(b.bookingEndTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const metric = (icon: string, label: string, value: ReactNode, valueColor?: string) => (
    <div className="cx-metric is-soft">
      <p className="cx-metric-label">
        <i className={`fas ${icon}`} aria-hidden /> {label}
      </p>
      <p className="cx-metric-value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </p>
    </div>
  );

  const liveQueue = stations.find((x) => x.id === st.stationId)?.queue ?? 0;
  const statusLabel = b.status.charAt(0).toUpperCase() + b.status.slice(1);
  // The server's live estimate of this booking's turn at the nozzle
  // (services/queue/stationQueue.js), pushed by eta_update. Only today's line has one.
  const turnMinutes =
    b.status === "upcoming" && date === istDateKey() && typeof b.etaMinutes === "number" ? b.etaMinutes : null;

  return (
    <Layout>
      {pageHead(
        "good",
        "fa-circle-check",
        "Booking Confirmed",
        "Your fuel slot is reserved. Show the QR pass or PIN when you reach the pump.",
        statusLabel,
      )}

      <div className="grid gap-5 items-start lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5 min-w-0">
          <section className="cx-panel" style={{ animation: "slideUp .45s ease" }}>
            <div className="cx-panel-head">
              <h2 className="cx-panel-title">
                <i className="fas fa-route" aria-hidden /> Route to station
              </h2>
              {hasValidRoute ? (
                <span className="cx-live">~{driveTimeMin} min drive</span>
              ) : (
                <span className="cx-tag is-neutral">Route unavailable</span>
              )}
            </div>
            <div className="cx-panel-body">
              {turnMinutes !== null && (
                <div className="cx-status-banner t-good mb-3" role="status" aria-live="polite">
                  <span className="cx-stat-icon">
                    <i className="fas fa-stopwatch" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="cx-status-title">
                      {b.arrivalTime
                        ? turnMinutes === 0
                          ? "Checked in: fueling starts as soon as the nozzle is released"
                          : `Checked in: waiting for the nozzle, ~${turnMinutes} min`
                        : turnMinutes === 0
                          ? "Your turn: the nozzle is free now"
                          : `Your turn in ~${turnMinutes} min`}
                    </p>
                    <p className="cx-status-sub">
                      {b.queuePosition ? `#${b.queuePosition} at the nozzle today · ` : ""}
                      {b.arrivalTime
                        ? "Fueling starts automatically; this page updates when it does."
                        : "Live from the station's bookings; updates as the line moves."}
                    </p>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2.5">
                {metric(
                  "fa-route",
                  "Distance",
                  hasValidRoute ? (
                    <>
                      {distKm}
                      <small>km</small>
                    </>
                  ) : (
                    "—"
                  ),
                )}
                {metric("fa-clock", "Est. arrival", hasValidRoute ? etaTime : "—")}
                {metric(
                  "fa-users",
                  "Live queue",
                  <>
                    {liveQueue}
                    <small>veh</small>
                  </>,
                )}
              </div>

              <div className="relative pl-7 space-y-4 my-5">
                <div
                  style={{ position: "absolute", left: 9, top: 8, bottom: 8, width: 2, background: "var(--border)" }}
                />
                <div className="relative">
                  <span
                    className="absolute -left-7 top-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                    style={{ background: "var(--secondary-light)", border: "2px solid var(--secondary)" }}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ background: "var(--secondary)" }} />
                  </span>
                  <p className="text-[13px] font-semibold" style={{ color: "var(--text)" }}>
                    Your current location
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                    Depart now to reach before your slot begins
                  </p>
                </div>
                <div className="relative">
                  <span
                    className="absolute -left-7 top-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                    style={{ background: "var(--accent-light)", border: "2px solid var(--accent)" }}
                  >
                    <i className="fas fa-gas-pump text-[9px]" style={{ color: "var(--accent)" }} aria-hidden />
                  </span>
                  <p className="text-[13px] font-semibold flex items-center gap-2 flex-wrap" style={{ color: "var(--text)" }}>
                    {st.name} <span className="cx-tag is-amber">Slot {time}</span>
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                    <i className="fas fa-location-dot mr-1" aria-hidden />
                    {st.address}
                  </p>
                </div>
              </div>

              {hasValidRoute && userCoords && st.coordinates ? (
                <>
                  <RouteMap from={userCoords} to={st.coordinates} stationName={st.name} />
                  <a
                    href={gmapsUrl!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-primary btn-block"
                  >
                    <i className="fas fa-location-arrow" aria-hidden />
                    Start Google Maps Navigation
                    <i className="fas fa-arrow-up-right-from-square text-xs opacity-75" aria-hidden />
                  </a>
                </>
              ) : (
                /* Never show a map or nav link built from a guessed coordinate. */
                <div className="cx-status-banner t-bad flex-wrap">
                  <span className="cx-stat-icon">
                    <i className="fas fa-location-crosshairs" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="cx-status-title">
                      {!st.hasValidCoords ? "Station location unavailable" : "Your location is unavailable"}
                    </p>
                    <p className="cx-status-sub">
                      {!st.hasValidCoords
                        ? "This station hasn't been geo-located yet, so a route can't be shown."
                        : "Enable location access so we can show the route from where you are."}
                    </p>
                  </div>
                  {st.hasValidCoords && (
                    <button className="btn btn-outline btn-sm" onClick={retryLocation}>
                      <i className="fas fa-location-crosshairs" aria-hidden /> Retry
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="cx-panel" style={{ animation: "slideUp .55s ease" }}>
            <div className="cx-panel-head">
              <h2 className="cx-panel-title">
                <i className="fas fa-receipt" aria-hidden /> Booking details
              </h2>
            </div>
            <div className="cx-panel-body">
              <DetailList
                rows={[
                  { label: "Station", value: st.name, icon: "fa-gas-pump" },
                  { label: "Date", value: formatDay(date), icon: "fa-calendar" },
                  { label: "Reserved Slot", value: time, icon: "fa-clock" },
                  { label: "Fuel Type", value: fuelType, icon: "fa-droplet" },
                  ...(estDuration
                    ? [{ label: "Estimated Duration", value: estDuration, icon: "fa-hourglass-half" }]
                    : []),
                  ...(estCompletion
                    ? [{ label: "Estimated Completion", value: estCompletion, icon: "fa-flag-checkered" }]
                    : []),
                  { label: "Nozzle Status", value: NOZZLE_STATUS[b.status] ?? "—", icon: "fa-plug-circle-check" },
                  { label: "Booking Status", value: statusLabel, icon: "fa-circle-info" },
                  { label: "Quantity", value: `${qty} Litres`, icon: "fa-gauge" },
                  { label: "Vehicle", value: vehicle, icon: vehicleIcon },
                ]}
              />
              <hr className="cx-split" />
              <div className="cx-total">
                <span className="cx-total-label">Total Amount</span>
                <span className="cx-total-value">{formatCurrency(amount)}</span>
              </div>
            </div>
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-[88px]">
          <BookingQrCard booking={b} stations={stations} />

          {/* Scan-to-pay, only for a booking that still owes money at the pump.
              The card decides for itself whether UPI is actually available and
              falls back to "pay the attendant" when it is not. */}
          {b.paymentStatus !== "paid" && b.payMethod !== "online" && <UpiPaymentCard booking={b} />}

          <section className="cx-panel">
            <div className="cx-panel-body space-y-2">
              <button className="btn btn-outline btn-block" onClick={() => navigate("/stations")}>
                <i className="fas fa-location-dot" aria-hidden /> Nearby Stations
              </button>
              <button className="btn btn-danger-outline btn-block" onClick={() => onCancel(bookingId)}>
                <i className="fas fa-circle-xmark" aria-hidden /> Cancel Booking
              </button>
            </div>
          </section>
        </aside>
      </div>
    </Layout>
  );
}

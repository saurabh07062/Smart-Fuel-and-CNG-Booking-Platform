import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Booking, UiStation } from "@/types";
import Layout from "@/components/layout/Layout";
import EmptyState from "@/components/common/EmptyState";
import BookingCard from "@/components/booking/BookingCard";
import CancelBookingSheet from "@/components/booking/CancelBookingSheet";
import LocationPicker from "@/components/maps/LocationPicker";
import StationsMap from "@/components/maps/StationsMap";
import { getLastKnownUserCoords } from "@/utils/geo";
import { directionsUrl } from "@/utils/navigation";
import FuelSelection from "@/components/maps/FuelSelection";
import VehicleArt from "@/components/vehicle/VehicleArt";
import { useAuthStore } from "@/store/authStore";
import { useBookingStore } from "@/store/bookingStore";
import { bookingRef, paymentState } from "@/utils/payment";
import { useStationStore } from "@/store/stationStore";
import { useWatchStations } from "@/hooks/useSocket";
import { pushToast } from "@/store/toastStore";
import { cancelBooking as apiCancelBooking } from "@/services/api/bookingApi";
import { toApiError } from "@/services/api/apiClient";
import { formatCurrency, isSlotElapsed, queueLabelOf, queueLevelOf } from "@/utils/format";
import { resolveBookingStation } from "@/utils/station";
import { getVehicleIcon, vehicleDisplayName } from "@/utils/vehicle";

const ACTIVE_STATUSES = ["upcoming", "serving", "waitlisted"];
/** How many saved vehicles / nearby stations the dashboard previews. */
const VEHICLE_PREVIEW = 3;
const NEARBY_PREVIEW = 4;

/** Morning 5 AM-noon, afternoon to 5 PM, evening after that (and through the night). */
export function greeting(h = new Date().getHours()): string {
  if (h >= 5 && h < 12) return "Good Morning";
  if (h >= 12 && h < 17) return "Good Afternoon";
  return "Good Evening";
}

/** "2026-09-10" -> "Thu, 10 Sept". */
function formatDay(date?: string | null): string {
  if (!date) return "—";
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

const todayKey = () => new Date().toISOString().slice(0, 10);

/**
 * The customer dashboard, laid out like the Admin Panel dashboard:
 *
 *   - the page title and Refresh live in the top bar,
 *   - a full-width row of four KPI cards (icon + status badge, label, value),
 *   - a main panel (the next booking, or a way to make one) beside a summary
 *     panel modelled on the admin "Order Summary",
 *   - then stations near you and bookings, beside vehicles and the
 *     "best station for you" finder.
 *
 * Behaviour is unchanged: the same booking filters and cancel flow, the same
 * stats and their links, and the location picker with its fuel search.
 */
export default function Dashboard() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const bookings = useBookingStore((s) => s.bookings);
  const showAll = useBookingStore((s) => s.showAll);
  const setShowAll = useBookingStore((s) => s.setShowAll);
  const loadBookings = useBookingStore((s) => s.load);

  const stations = useStationStore((s) => s.stations);
  const stationsLoading = useStationStore((s) => s.loading);
  const loadStations = useStationStore((s) => s.load);

  useEffect(() => {
    void loadBookings();
    // Always refetch; what is on screen stays until the fresh list arrives.
    void loadStations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    void loadBookings();
    void loadStations();
  };

  /**
   * "Upcoming" for the KPI card, matching the Vanilla filter exactly: status
   * upcoming AND the slot has not already elapsed.
   */
  const upcoming = useMemo(
    () => bookings.filter((b) => b.status === "upcoming" && !isSlotElapsed(b.bookingDate, b.timeSlot)),
    [bookings],
  );

  const activeBookings = useMemo(
    () =>
      bookings.filter(
        (b) => ACTIVE_STATUSES.includes(b.status) && !isSlotElapsed(b.bookingDate, b.timeSlot),
      ),
    [bookings],
  );

  const displayBookings = showAll ? bookings : activeBookings;
  const next = activeBookings[0] ?? null;

  const vehicles = useMemo(
    () => [...(user?.vehicles ?? [])].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault)),
    [user],
  );

  const nearby = useMemo(
    () =>
      [...stations]
        .sort((a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY))
        .slice(0, NEARBY_PREVIEW),
    [stations],
  );
  const openStations = stations.filter((s) => s.open).length;

  // Queue, wait, price and status events are sent to each station's room, so
  // the stations on this page -- the nearby preview and the ones this customer
  // has an active booking at -- are followed while it is open.
  useWatchStations(
    useMemo(
      () => [
        ...nearby.map((s) => s.id),
        ...activeBookings
          .map((b) => (typeof b.station === "object" && b.station ? b.station._id : b.station))
          .filter((id): id is string => Boolean(id)),
      ],
      [nearby, activeBookings],
    ),
  );

  // The booking whose cancel sheet is open (null = closed).
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const onCancel = (id: string) => setCancelling(id);
  const confirmCancel = async (reason?: string) => {
    if (!cancelling) return;
    setCancelBusy(true);
    try {
      await apiCancelBooking(cancelling, reason);
      pushToast("Booking cancelled. Nothing was charged.", "success");
      setCancelling(null);
      // Refetch rather than patching locally: cancelling frees a slot and
      // moves the queue, and the server owns both of those.
      await loadBookings();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setCancelBusy(false);
    }
  };

  /** Quick action: the full booking list on this page. */
  const showHistory = () => {
    setShowAll(true);
    document.getElementById("my-bookings")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const firstName = user?.name?.split(" ")[0];
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

  // Active / All bookings. On top beside "Best station for you" when nothing
  // is booked; below, under the upcoming booking card, when something is.
  const bookingsPanel = (
    <section className="cx-panel" id="my-bookings" style={{ scrollMarginTop: 90 }}>
      <div className="cx-panel-head">
        <h2 className="cx-panel-title">
          <i className="fas fa-calendar-check" aria-hidden />
          {showAll ? "Booking History" : "Active Bookings"}
        </h2>
        <div className="cx-segment" role="group" aria-label="Filter bookings">
          <button
            type="button"
            className={!showAll ? "is-on" : ""}
            aria-pressed={!showAll}
            onClick={() => setShowAll(false)}
          >
            Active
          </button>
          <button
            type="button"
            className={showAll ? "is-on" : ""}
            aria-pressed={showAll}
            onClick={() => setShowAll(true)}
          >
            All
          </button>
        </div>
      </div>

      <div className={`cx-panel-body ${displayBookings.length > 0 ? "is-flush" : ""}`}>
        {displayBookings.length === 0 ? (
          <EmptyState
            icon="fa-calendar-days"
            title={showAll ? "No bookings yet" : "No active bookings"}
            subtitle="Find a nearby station and reserve your fuel slot in under a minute."
            action={
              <button className="btn btn-primary btn-sm" onClick={() => navigate("/stations")}>
                <i className="fas fa-location-dot" aria-hidden /> Find a Station
              </button>
            }
          />
        ) : (
          <div className="cx-rows">
            {displayBookings.map((b) => (
              <BookingCard key={String(b._id)} booking={b} stations={stations} onCancel={onCancel} />
            ))}
          </div>
        )}
      </div>
    </section>
  );

  return (
    <Layout
      title={`${greeting()}${firstName ? ` ${firstName}` : ""}`}
      subtitle={`${today} · Your fuel bookings at a glance`}
      onRefresh={refresh}
    >
      <CancelBookingSheet
        open={cancelling !== null}
        waitlisted={bookings.find((x) => String(x._id) === cancelling)?.status === "waitlisted"}
        busy={cancelBusy}
        onClose={() => setCancelling(null)}
        onConfirm={(reason) => void confirmCancel(reason)}
      />

      {/* Quick actions: in the mobile app only (VITE_APP_MODE=customer), not on the website. */}
      {import.meta.env.VITE_APP_MODE === "customer" && (
      <nav className="grid grid-cols-4 gap-2 mb-5" aria-label="Quick actions">
        {(
          [
            ["fa-gas-pump", "Book fuel", () => navigate("/booking")],
            ["fa-location-arrow", "Nearest", () => navigate("/nearest-pump")],
            ["fa-car-side", "My vehicles", () => navigate("/my-vehicles")],
            ["fa-clock-rotate-left", "History", showHistory],
          ] as const
        ).map(([icon, label, go]) => (
          <button
            key={label}
            type="button"
            onClick={go}
            className="cx-panel flex flex-col items-center justify-center gap-1.5 py-3 min-h-[72px]"
            style={{ cursor: "pointer" }}
          >
            <span className="cx-stat-icon cx-tone-brand" style={{ width: 36, height: 36 }}>
              <i className={`fas ${icon}`} aria-hidden />
            </span>
            <span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>
              {label}
            </span>
          </button>
        ))}
      </nav>
      )}

      <div className="cx-kpis">
        <Kpi
          icon="fa-calendar-check"
          tone="cx-tone-red"
          label="Upcoming Bookings"
          value={upcoming.length}
          badge={upcoming.length > 0 ? "Active" : "None booked"}
          badgeTone={upcoming.length > 0 ? "t-good" : ""}
          highlight={upcoming.length > 0}
          onClick={() => navigate("/booking")}
        />
        <Kpi
          icon="fa-wallet"
          tone="cx-tone-green"
          label="Wallet Balance"
          value={formatCurrency(user?.wallet ?? 0)}
        />
        <Kpi
          icon="fa-star"
          tone="cx-tone-amber"
          label="Reward Points"
          value={(user?.rewards ?? 0).toLocaleString()}
          badge="Member"
          badgeTone="t-warn"
        />
        <Kpi
          icon="fa-location-dot"
          tone="cx-tone-slate"
          label="Nearby Stations"
          value={stations.length}
          badge={`${openStations} open`}
          badgeTone="t-good"
          onClick={() => navigate("/stations")}
        />
      </div>

      <div className="grid gap-5 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5 min-w-0">
          {/* Left column: the upcoming booking, or (with none) the bookings list. */}
          {next ? (
            <NextBookingPanel
              booking={next}
              stations={stations}
              onOpen={() => navigate(`/confirmation/${next._id}`)}
            />
          ) : (
            bookingsPanel
          )}
          <section className="cx-panel">
            <div className="cx-panel-head">
              <div className="flex items-center gap-3 min-w-0">
                <h2 className="cx-panel-title">
                  <i className="fas fa-map-location-dot" aria-hidden /> Stations near you
                </h2>
                <span className="cx-live">Live</span>
              </div>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => navigate("/stations")}>
                View Map <i className="fas fa-arrow-right" aria-hidden />
              </button>
            </div>
            {/* Every station with a real location, live (the store is patched by socket events). */}
            <div className="px-4 pt-4 sm:px-5">
              <StationsMap stations={stations} userCoords={getLastKnownUserCoords()} className="h-[300px] sm:h-[340px]" />
            </div>
            <div className="cx-panel-body is-flush">
              {nearby.length === 0 ? (
                <p className="py-8 text-center text-sm" style={{ color: "var(--muted)" }}>
                  {stationsLoading ? "Loading nearby stations…" : "No stations to show yet."}
                </p>
              ) : (
                <div className="cx-rows">
                  {nearby.map((s) => (
                    <NearbyStationRow
                      key={s.id}
                      station={s}
                      onOpen={() => navigate(`/stations/${s.id}`)}
                      onBook={() => navigate(`/booking?stationId=${s.id}`)}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>

          {next && bookingsPanel}
        </div>

        <div className="space-y-5 min-w-0">
          {/* Right column: "Best station for you" first. */}
          <section className="cx-panel">
            <div className="cx-panel-head">
              <h2 className="cx-panel-title">
                <i className="fas fa-crosshairs" aria-hidden /> Best station for you
              </h2>
            </div>
            <div className="cx-panel-body cx-unwrap">
              <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
                Set your location and choose a fuel. We rank stations by distance, live queue and price.
              </p>
              {/* FuelSelection renders inside the picker's card, where the
                  Vanilla #dashboard-geo-display block lived -- not below it. */}
              <LocationPicker>
                <FuelSelection />
              </LocationPicker>
            </div>
          </section>
          <section className="cx-panel">
            <div className="cx-panel-head">
              <h2 className="cx-panel-title">
                <i className="fas fa-car-side" aria-hidden /> My Vehicles
              </h2>
              <button type="button" className="cx-link" onClick={() => navigate("/my-vehicles")}>
                Manage <i className="fas fa-arrow-right" aria-hidden />
              </button>
            </div>
            <div className={`cx-panel-body ${vehicles.length > 0 ? "is-flush" : ""}`}>
              {vehicles.length === 0 ? (
                <div className="text-center py-1">
                  <VehicleArt type="Car" size={52} radius={14} className="mx-auto mb-3" />
                  <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                    No saved vehicles
                  </p>
                  <p className="text-xs mt-1 mb-3" style={{ color: "var(--muted)" }}>
                    Save a car or bike once and pick it in one tap when you book.
                  </p>
                  <button className="btn btn-outline btn-sm" onClick={() => navigate("/my-vehicles")}>
                    <i className="fas fa-plus" aria-hidden /> Add Vehicle
                  </button>
                </div>
              ) : (
                <div className="cx-rows">
                  {vehicles.slice(0, VEHICLE_PREVIEW).map((v) => (
                    <button
                      type="button"
                      className="cx-row"
                      key={String(v._id)}
                      onClick={() => navigate("/my-vehicles")}
                    >
                      <VehicleArt type={v.vehicleType} image={v.image} size={40} radius={11} />
                      <div className="cx-row-main">
                        <div className="cx-row-name">{vehicleDisplayName(v)}</div>
                        <div className="cx-row-sub">
                          {v.vehicleType || "Car"} · {v.fuelType || "Petrol"}
                          {v.isDefault ? " · Default" : ""}
                        </div>
                      </div>
                      <span className="cx-plate">{v.registrationNumber || "—"}</span>
                    </button>
                  ))}
                  {vehicles.length > VEHICLE_PREVIEW && (
                    <button
                      type="button"
                      className="cx-link justify-center py-2.5"
                      onClick={() => navigate("/my-vehicles")}
                    >
                      +{vehicles.length - VEHICLE_PREVIEW} more
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>

        </div>
      </div>
    </Layout>
  );
}

/** One admin-style KPI card: icon and status badge, label, value. */
function Kpi({
  icon,
  tone,
  label,
  value,
  badge,
  badgeTone = "",
  highlight = false,
  onClick,
}: {
  icon: string;
  tone: string;
  label: string;
  value: ReactNode;
  badge?: string;
  badgeTone?: string;
  highlight?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="cx-kpi-top">
        <span className={`cx-stat-icon ${tone}`}>
          <i className={`fas ${icon}`} aria-hidden />
        </span>
        {badge && <span className={`cx-kpi-badge ${badgeTone}`}>{badge}</span>}
      </div>
      <p className="cx-kpi-label">{label}</p>
      <p className="cx-kpi-value">{value}</p>
    </>
  );
  const cls = `cx-kpi ${highlight ? "is-highlight" : ""}`;
  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={cls}>{content}</div>
  );
}

function NextBookingPanel({
  booking: b,
  stations,
  onOpen,
}: {
  booking: Booking;
  stations: UiStation[];
  onOpen: () => void;
}) {
  const st = resolveBookingStation(b, stations);
  const vehicle = [b.vehicleName, b.vehiclePlate].filter(Boolean).join(" · ");
  const directions = st.hasValidCoords ? directionsUrl(st.lat, st.lng) : null;
  const heading =
    b.status === "serving"
      ? "Fuelling now"
      : b.status === "waitlisted"
        ? "On the waitlist"
        : b.status === "upcoming" && b.arrivalTime
          ? "Checked in · waiting for the nozzle"
          : "Your next booking";

  const fact = (icon: string, label: string, value: string) => (
    <div className="cx-metric is-soft">
      <p className="cx-metric-label">
        <i className={`fas ${icon}`} aria-hidden /> {label}
      </p>
      <p className="cx-metric-value" style={{ fontSize: 15 }} title={value}>
        {value}
      </p>
    </div>
  );

  return (
    <section className="cx-panel">
      <div className="cx-panel-head">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="cx-panel-title">{heading}</h2>
          <span className="cx-pill hidden sm:inline-flex">{b.bookingDate === todayKey() ? "Today" : formatDay(b.bookingDate)}</span>
          <span className="cx-pill hidden sm:inline-flex" title={`Booking ${bookingRef(b)}`}>
            {paymentState(b).label}
          </span>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={onOpen}>
          View Pass <i className="fas fa-arrow-right" aria-hidden />
        </button>
      </div>
      <div className="cx-panel-body">
        <div className="flex items-start gap-4 flex-wrap">
          <span className="cx-stat-icon cx-tone-red" style={{ width: 52, height: 52, fontSize: 20, borderRadius: 14 }}>
            <i className="fas fa-gas-pump" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="cx-row-name" style={{ fontSize: 18 }}>
              {st.name}
            </h3>
            <p className="text-[12.5px] mt-1" style={{ color: "var(--muted)" }}>
              <i className="fas fa-location-dot mr-1.5" aria-hidden />
              {st.address}
            </p>
          </div>
          {b.verificationCode && (
            <div className="cx-pinbox">
              <p className="cx-eyebrow">Attendant PIN</p>
              <p className="cx-pin">{b.verificationCode}</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
          {fact("fa-calendar", "Date", formatDay(b.bookingDate))}
          {fact("fa-clock", "Slot", b.timeSlot || "—")}
          {fact("fa-droplet", "Fuel", `${b.fuelType} · ${b.quantity}L`)}
          {fact(getVehicleIcon(b.vehicleType || "Car"), "Vehicle", vehicle || "Not recorded")}
        </div>

        <div className="flex gap-2 mt-5 flex-wrap">
          <button type="button" className="btn btn-primary" onClick={onOpen}>
            <i className="fas fa-qrcode" aria-hidden /> View QR Pass
          </button>
          {directions && (
            <a className="btn btn-outline" href={directions} target="_blank" rel="noopener noreferrer">
              <i className="fas fa-diamond-turn-right" aria-hidden /> Directions
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function NearbyStationRow({
  station: s,
  onOpen,
  onBook,
}: {
  station: UiStation;
  onOpen: () => void;
  onBook: () => void;
}) {
  return (
    <div
      className="cx-row"
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter") onOpen();
      }}
    >
      <span className={`cx-row-avatar ${s.open ? "cx-tone-red" : "cx-tone-slate"}`}>
        <i className="fas fa-gas-pump" aria-hidden />
      </span>
      <div className="cx-row-main">
        <div className="flex items-center gap-2 min-w-0">
          <span className="cx-row-name">{s.name}</span>
          {!s.open && <span className="cx-tag is-red">Closed</span>}
        </div>
        <div className="cx-row-sub">
          {s.distance != null ? `${s.distance} km · ` : ""}
          {s.fuelTypes.map((f) => `${f} ₹${s.uiPrices[f as keyof typeof s.uiPrices] ?? "—"}`).join(" · ")}
        </div>
      </div>
      <span className={`queue-pill ${queueLevelOf(s.queueStatus)} hidden sm:inline-flex`} title={queueLabelOf(s.queueStatus)}>
        <span className="dot" />
        {s.waitTime} min
      </span>
      <button
        type="button"
        className="btn btn-outline btn-sm"
        disabled={!s.open}
        onClick={(e) => {
          e.stopPropagation();
          onBook();
        }}
      >
        Book
      </button>
    </div>
  );
}

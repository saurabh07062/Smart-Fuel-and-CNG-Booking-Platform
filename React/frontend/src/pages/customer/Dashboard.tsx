import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Booking, UiStation } from "@/types";
import Layout from "@/components/layout/Layout";
import EmptyState from "@/components/common/EmptyState";
import BookingCard from "@/components/booking/BookingCard";
import LocationPicker from "@/components/maps/LocationPicker";
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

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
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
  const setFilter = useStationStore((s) => s.setFilter);

  useEffect(() => {
    void loadBookings();
    if (stations.length === 0) void loadStations();
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
  const completed = bookings.filter((b) => b.status === "completed").length;
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

  const onCancel = async (id: string) => {
    if (!window.confirm("Are you sure you want to cancel this booking?")) return;
    try {
      await apiCancelBooking(id);
      pushToast("Booking cancelled successfully", "success");
      // Refetch rather than patching locally: cancelling frees a slot and
      // moves the queue, and the server owns both of those.
      await loadBookings();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    }
  };

  const findFuel = (filter: "petrol" | "cng") => {
    setFilter(filter);
    navigate("/stations");
  };

  const firstName = user?.name?.split(" ")[0];
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

  return (
    <Layout
      title={`${greeting()}${firstName ? `, ${firstName}` : ""}`}
      subtitle={`${today} · Your fuel bookings at a glance`}
      onRefresh={refresh}
    >
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

      <div className="grid gap-5 items-start mb-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {next ? (
          <NextBookingPanel
            booking={next}
            stations={stations}
            onOpen={() => navigate(`/confirmation/${next._id}`)}
          />
        ) : (
          <BookPromptPanel onBook={() => navigate("/booking")} onFind={findFuel} />
        )}

        <SummaryPanel
          next={next}
          stations={stations}
          completed={completed}
          total={bookings.length}
          onAction={() => (next ? navigate(`/confirmation/${next._id}`) : navigate("/booking"))}
        />
      </div>

      <div className="grid gap-5 items-start lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-5 min-w-0">
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

          <section className="cx-panel">
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
        </div>

        <div className="space-y-5 min-w-0">
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
  const directions = st.hasValidCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}&travelmode=driving`
    : null;
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

function BookPromptPanel({
  onBook,
  onFind,
}: {
  onBook: () => void;
  onFind: (filter: "petrol" | "cng") => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const tile = (icon: string, tone: string, label: string, sub: string, onClick: () => void) => (
    <button type="button" className="cx-option flex items-center gap-3 text-left" onClick={onClick}>
      <span className={`cx-stat-icon ${tone}`}>
        <i className={`fas ${icon}`} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="cx-option-name block">{label}</span>
        <span className="cx-option-sub block">{sub}</span>
      </span>
    </button>
  );

  return (
    <section className="cx-panel">
      <div className="cx-panel-head">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="cx-panel-title">Book your next fill</h2>
          <span className="cx-pill hidden sm:inline-flex">Skip the queue</span>
        </div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => navigate("/stations")}>
          All Stations <i className="fas fa-arrow-right" aria-hidden />
        </button>
      </div>
      <div className="cx-panel-body">
        <p className="text-sm" style={{ color: "var(--text2)" }}>
          Compare live queues and prices nearby, then reserve a slot in under a minute.
        </p>

        <form
          className="cx-search mt-4"
          style={{ maxWidth: "none" }}
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = query.trim();
            navigate(q ? `/stations?q=${encodeURIComponent(q)}` : "/stations");
          }}
        >
          <i className="fas fa-magnifying-glass" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a station or area, e.g. Koregaon Park"
            aria-label="Search stations"
          />
        </form>

        <div className="grid gap-3 mt-4 sm:grid-cols-3">
          {tile("fa-calendar-plus", "cx-tone-red", "Book a slot", "Pick station, time & vehicle", onBook)}
          {tile("fa-droplet", "cx-tone-amber", "Petrol stations", "Nearest with live queues", () => onFind("petrol"))}
          {tile("fa-fire", "cx-tone-green", "CNG stations", "Nearest with live queues", () => onFind("cng"))}
        </div>
      </div>
    </section>
  );
}

/** Modelled on the admin "Order Summary" panel. */
function SummaryPanel({
  next,
  stations,
  completed,
  total,
  onAction,
}: {
  next: Booking | null;
  stations: UiStation[];
  completed: number;
  total: number;
  onAction: () => void;
}) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const station = next ? resolveBookingStation(next, stations) : null;

  return (
    <section className="cx-panel">
      <div className="cx-panel-head">
        <h2 className="cx-panel-title">
          <i className="fas fa-receipt" aria-hidden /> Booking Summary
        </h2>
      </div>
      <div className="cx-panel-body">
        <div className="cx-snapshot">
          <p className="cx-snapshot-eyebrow">Today&apos;s snapshot</p>
          <p className="cx-snapshot-text">
            {next && station ? (
              <>
                Your <b>{next.fuelType}</b> slot at <b>{station.name}</b> is on <b>{formatDay(next.bookingDate)}</b> at{" "}
                <b>{next.timeSlot}</b>. Show your PIN at the pump.
              </>
            ) : (
              <>
                No fuel slot booked. Open <b>Find Stations</b> to compare live queues, or book straight away.
              </>
            )}
          </p>
        </div>

        <div className="flex items-end justify-between mt-6">
          <span className="cx-eyebrow">Completed bookings</span>
          <span className="cx-snapshot-count">{completed}</span>
        </div>
        <div className="cx-progress mt-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[11.5px] mt-2" style={{ color: "var(--muted)" }}>
          {total > 0 ? `${completed} of ${total} bookings completed` : "Your first booking will show up here"}
        </p>

        <button type="button" className="btn btn-primary btn-block btn-lg mt-5" onClick={onAction}>
          <i className={`fas ${next ? "fa-qrcode" : "fa-calendar-plus"}`} aria-hidden />
          {next ? "View QR Pass" : "Book Fuel"}
        </button>
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

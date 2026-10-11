import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Booking, UiStation } from "@/types";
import Layout from "@/components/layout/Layout";
import EmptyState from "@/components/common/EmptyState";
import BookingCard from "@/components/booking/BookingCard";
import CancelBookingSheet from "@/components/booking/CancelBookingSheet";
import RewardsSheet from "@/components/rewards/RewardsSheet";
import QueueInfoCard from "@/components/booking/QueueInfoCard";
import FindFuelHero from "@/components/booking/FindFuelHero";
import { pumpsFor, type FuelKey } from "@/utils/fuelPumps";
import PostLoginFlow from "@/components/location/PostLoginFlow";
import StationsMap from "@/components/maps/StationsMap";
import StationCard from "@/components/station/StationCard";
import { getLastKnownUserCoords, haversineKm } from "@/utils/geo";
import { directionsUrl } from "@/utils/navigation";
import VehicleArt from "@/components/vehicle/VehicleArt";
import { useAuthStore } from "@/store/authStore";
import { useBookingStore } from "@/store/bookingStore";
import { bookingRef, paymentState } from "@/utils/payment";
import { useStationStore } from "@/store/stationStore";
import { useLocationStore } from "@/store/locationStore";
import { useWatchStations } from "@/hooks/useSocket";
import { pushToast } from "@/store/toastStore";
import { cancelBooking as apiCancelBooking } from "@/services/api/bookingApi";
import { toApiError } from "@/services/api/apiClient";
import { isSlotElapsed } from "@/utils/format";
import { resolveBookingStation } from "@/utils/station";
import { getVehicleIcon, vehicleDisplayName } from "@/utils/vehicle";

const ACTIVE_STATUSES = ["upcoming", "serving", "waitlisted"];
/** How many saved vehicles / nearby stations the dashboard previews. */
const VEHICLE_PREVIEW = 3;
/** How many of the nearest stations this page subscribes to for live queue. */
const WATCHED_STATIONS = 8;
/** Station cards shown before "Show all". */
const STATION_PREVIEW = 5;

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
  const coords = useLocationStore((s) => s.coords);
  const askLocation = useLocationStore((s) => s.askLocation);
  const locationAsked = useLocationStore((s) => s.locationAsked);

  /** The fuel the whole page is about; the picker in the hero sets it. */
  const [fuel, setFuel] = useState<FuelKey>("Petrol");

  const bookings = useBookingStore((s) => s.bookings);
  const showAll = useBookingStore((s) => s.showAll);
  const setShowAll = useBookingStore((s) => s.setShowAll);
  const loadBookings = useBookingStore((s) => s.load);

  const stations = useStationStore((s) => s.stations);
  const stationsLoading = useStationStore((s) => s.loading);
  /** Set when the pumps on screen came from this device, not from the server. */
  const stationsStale = useStationStore((s) => s.stale);
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

  const activeBookings = useMemo(
    () =>
      bookings.filter(
        (b) => ACTIVE_STATUSES.includes(b.status) && !isSlotElapsed(b.bookingDate, b.timeSlot),
      ),
    [bookings],
  );

  /** Fills that actually happened -- the customer's own history figure. */
  const completedCount = useMemo(() => bookings.filter((b) => b.status === "completed").length, [bookings]);

  const displayBookings = showAll ? bookings : activeBookings;
  const next = activeBookings[0] ?? null;

  const vehicles = useMemo(
    () => [...(user?.vehicles ?? [])].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault)),
    [user],
  );

  /**
   * Every station with its distance from where the customer is, nearest
   * first. The station list endpoint does not rank by distance (only
   * /stations/nearby does), so without this the "nearest pump" could be one
   * across the city.
   */
  const sortedStations = useMemo(() => {
    const withDistance = coords
      ? stations.map((st) =>
          st.lat != null && st.lng != null
            ? { ...st, distance: Number(haversineKm(coords, { lat: st.lat, lng: st.lng }).toFixed(1)) }
            : st,
        )
      : stations;
    return [...withDistance].sort(
      (a, b) => (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY),
    );
  }, [stations, coords]);

  /**
   * The pumps for the chosen fuel: they must list it, have it in stock and
   * have published a price for it. A station that merely carries a stale
   * price for a fuel it no longer sells is not an answer to "where can I
   * fill CNG".
   */
  const fuelStations = useMemo(() => pumpsFor(fuel, sortedStations), [sortedStations, fuel]);
  /** The stations whose live queue this page follows over the socket. */
  const nearby = useMemo(() => sortedStations.slice(0, WATCHED_STATIONS), [sortedStations]);

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
  /** The pumps list, or the map of them. List first: it is the faster read. */
  /** The pumps list, or the map of them. List first: it is the faster read. */
  const [mapView, setMapView] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  /** The reward-points statement, opened from the points tile. */
  const [rewardsOpen, setRewardsOpen] = useState(false);
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

  /** The customer Android build; the website gets the wider layout. */
  const isApp = import.meta.env.VITE_APP_MODE === "customer";
  const firstName = user?.name?.split(" ")[0];
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

  // Active / All bookings. On top beside "Best station for you" when nothing
  // is booked; below, under the upcoming booking card, when something is.
  /**
   * Every station, on the map and in the list under it -- the customer's own
   * "where can I fill" view, in the place the four counters used to sit.
   * Nearest first, because that is the only order a customer standing
   * somewhere cares about; the map and the rows are the same live data.
   */
  /**
   * The Find Stations view, on the dashboard: the same station cards on the
   * left and the same live map on the right, so a customer who lands here
   * can pick a pump without going anywhere else. One card component, so the
   * two pages cannot drift apart.
   */
  /**
   * The pumps for the fuel chosen above: the nearest one first, each as the
   * same card the Find Stations page uses, with the map one tap away rather
   * than always open.
   */
  const stationsPanel = (
    <section className="mb-4">
      <div className="flex items-center gap-2 mb-2.5">
        <h2 className="text-[15px] font-bold flex items-center gap-2" style={{ color: "var(--text)" }}>
          <i className="fas fa-location-dot" style={{ color: "var(--primary)" }} aria-hidden />
          Nearest {fuel} Pump
        </h2>
        {stationsStale ? (
          <span className="cx-tag is-amber" title={new Date(stationsStale).toLocaleString("en-IN")}>
            Saved copy
          </span>
        ) : (
          <span className="cx-live">Live</span>
        )}
        <div className="cx-segment ml-auto" role="group" aria-label="List or map">
          <button type="button" className={!mapView ? "is-on" : ""} aria-pressed={!mapView} onClick={() => setMapView(false)}>
            List
          </button>
          <button type="button" className={mapView ? "is-on" : ""} aria-pressed={mapView} onClick={() => setMapView(true)}>
            Map
          </button>
        </div>
        <button type="button" className="cx-link" onClick={() => navigate("/stations")}>
          View All Stations <i className="fas fa-arrow-right" aria-hidden />
        </button>
      </div>

      {mapView ? (
        <div>
          <StationsMap
            stations={fuelStations.length > 0 ? fuelStations : sortedStations}
            className="h-[380px] sm:h-[460px]"
            userCoords={getLastKnownUserCoords()}
          />
          <p className="text-[11px] mt-2" style={{ color: "var(--muted)" }}>
            <i className="fas fa-circle-info mr-1" aria-hidden /> Red pins are open, grey are closed. Select a
            pin for station details.
          </p>
        </div>
      ) : fuelStations.length === 0 ? (
        <section className="cx-panel">
          <EmptyState
            icon="fa-map-location-dot"
            title={stationsLoading ? "Loading pumps…" : `No ${fuel} pump listed yet`}
            subtitle="Set your location above, or try another fuel type."
          />
        </section>
      ) : (
        <div className="space-y-3" data-testid="pump-list">
          {fuelStations.slice(0, STATION_PREVIEW).map((st, i) => (
            <StationCard key={st.id} station={st} index={i} highlightFuel={fuel} />
          ))}
          {fuelStations.length > STATION_PREVIEW && (
            <button type="button" className="btn btn-outline btn-sm w-full" onClick={() => navigate("/stations")}>
              See all {fuelStations.length} {fuel} pumps <i className="fas fa-arrow-right" aria-hidden />
            </button>
          )}
        </div>
      )}
    </section>
  );

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
      subtitle={today}
      onRefresh={refresh}
    >
      {/* After signing in: "Login successful", a pause, the location ask, then
          "What do you want?" -- components/location/PostLoginFlow.tsx. */}
      {askLocation && (
        <PostLoginFlow
          onFuelChosen={setFuel}
          onDone={locationAsked}
        />
      )}

      <CancelBookingSheet
        open={cancelling !== null}
        waitlisted={bookings.find((x) => String(x._id) === cancelling)?.status === "waitlisted"}
        busy={cancelBusy}
        onClose={() => setCancelling(null)}
        onConfirm={(reason) => void confirmCancel(reason)}
      />

      {rewardsOpen && <RewardsSheet onClose={() => setRewardsOpen(false)} />}

      {/*
        One column, read top to bottom, in the order a customer cares:
        the fill they have already booked, then booking a new one, then the
        pumps around them, then their vehicles and their history. No
        side-by-side panels competing for the same glance.
      */}
      {/*
        One reading order, two shapes. In the phone app it is a single narrow
        column. On the web the same blocks sit in two columns from xl up --
        the pump search and the station list where the eye lands, the
        customer's own things (vehicles, bookings) in a sticky rail beside
        them -- because a 720px ribbon down the middle of a desktop wastes
        the screen and makes a web page read like a screenshot of a phone.
      */}
      <div
        className={
          isApp
            ? "mx-auto w-full space-y-4"
            : "grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,380px)]"
        }
        style={isApp ? { maxWidth: 720 } : undefined}
      >
        <div className="min-w-0 space-y-4">
        {/* Four numbers, each a way in: bookings, points, history, vehicles. */}
        <div className="grid grid-cols-2 gap-3 mb-4 lg:grid-cols-4">
          <StatTile
            icon="fa-calendar-check"
            tone="cx-tone-red"
            value={activeBookings.length}
            label="Active Bookings"
            onClick={() => (activeBookings.length > 0 ? showHistory() : navigate("/booking"))}
            testId="stat-active-bookings"
          />
          {/* Points are earned on completed fills and spent as a discount at
              checkout; this opens the statement behind the number. */}
          <StatTile
            icon="fa-star"
            tone="cx-tone-amber"
            value={(user?.rewards ?? 0).toLocaleString("en-IN")}
            label="Reward Points"
            onClick={() => setRewardsOpen(true)}
            testId="stat-reward-points"
          />
          <StatTile
            icon="fa-circle-check"
            tone="cx-tone-green"
            value={completedCount}
            label="Completed Bookings"
            onClick={showHistory}
            testId="stat-completed"
          />
          <StatTile
            icon="fa-car-side"
            tone="cx-tone-slate"
            value={vehicles.length}
            label="Saved Vehicles"
            onClick={() => navigate("/my-vehicles")}
            testId="stat-vehicles"
          />
        </div>

        {/* What is happening right now, if anything is. */}
        {next && (
          <div className="mb-4">
            <NextBookingPanel
              booking={next}
              stations={stations}
              onOpen={() => navigate(`/confirmation/${next._id}`)}
            />
          </div>
        )}

        <FindFuelHero fuel={fuel} onFuel={setFuel} stations={sortedStations} />

        {/* Shortcuts, in the mobile app only (VITE_APP_MODE=customer). */}
        {isApp && (
          <nav className="grid grid-cols-5 gap-2 mb-4" aria-label="Quick actions">
            {(
              [
                ["fa-gas-pump", "Book", () => navigate("/booking")],
                ["fa-location-arrow", "Nearest", () => navigate("/nearest-pump")],
                ["fa-car-side", "Vehicles", () => navigate("/my-vehicles")],
                ["fa-clock-rotate-left", "History", showHistory],
                // A demonstration of the whole booking journey, on sample
                // data (pages/customer/Simulation.tsx). It books nothing.
                ["fa-flask", "Demo", () => navigate("/simulation")],
              ] as const
            ).map(([icon, label, go]) => (
              <button
                key={label}
                type="button"
                onClick={go}
                className="cx-panel flex flex-col items-center justify-center gap-1 py-2.5"
                style={{ cursor: "pointer" }}
              >
                <i className={`fas ${icon}`} style={{ color: "var(--primary)" }} aria-hidden />
                <span className="text-[11px] font-semibold" style={{ color: "var(--text)" }}>
                  {label}
                </span>
              </button>
            ))}
          </nav>
        )}

        {/* Booking for a family member or a driver: same flow, their name on
            the booking so the attendant hands the fill to the right person. */}
        <button
          type="button"
          // Straight to the station search, not to this customer's nearest
          // pump: the person they are booking for may be in another city.
          onClick={() => navigate("/stations?forSomeoneElse=1")}
          className="cx-panel flex w-full items-center gap-3 px-4 py-3.5 text-left mb-4"
          data-testid="book-for-someone-else"
        >
          <span className="cx-stat-icon cx-tone-brand" style={{ width: 44, height: 44, flex: "0 0 auto" }}>
            <i className="fas fa-user-group" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold" style={{ color: "var(--text)" }}>
              Book for someone else
            </span>
            <span className="block text-[12px]" style={{ color: "var(--muted)" }}>
              Pick the pump in their city, add their name — the booking, the PIN and the payment stay with you.
            </span>
          </span>
          <i className="fas fa-chevron-right text-[12px]" style={{ color: "var(--muted)" }} aria-hidden />
        </button>

        {/* Several vehicles in one visit. Beside "Book for someone else"
            because they are the same kind of thing -- a booking that is not
            the plain one -- and because a fleet owner should not have to find
            it in the sidebar to discover it exists. */}
        <button
          type="button"
          onClick={() => navigate("/fleet-booking")}
          className="cx-panel flex w-full items-center gap-3 px-4 py-3.5 text-left mb-4"
          data-testid="dashboard-fleet-booking"
        >
          <span className="cx-stat-icon cx-tone-brand" style={{ width: 44, height: 44, flex: "0 0 auto" }}>
            <i className="fas fa-truck-fast" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold" style={{ color: "var(--text)" }}>
              Fleet booking — several vehicles
            </span>
            <span className="block text-[12px]" style={{ color: "var(--muted)" }}>
              Book a slot for each vehicle in one go. One group PIN, paid together at the pump.
            </span>
          </span>
          <i className="fas fa-chevron-right text-[12px]" style={{ color: "var(--muted)" }} aria-hidden />
        </button>

        {stationsPanel}

        </div>

        <aside className="min-w-0 space-y-4 xl:sticky xl:top-[88px]">
          {/* The customer's own things, beside the search rather than under it. */}
          <section className="cx-panel">
            <div className="cx-panel-head">
              <h2 className="cx-panel-title">
                <i className="fas fa-car-side" aria-hidden /> Your Vehicles
              </h2>
              <button type="button" className="cx-link" onClick={() => navigate("/my-vehicles")}>
                Manage Vehicles <i className="fas fa-arrow-right" aria-hidden />
              </button>
            </div>
            <div className={`cx-panel-body ${vehicles.length > 0 ? "is-flush" : ""}`}>
              {vehicles.length > 0 && (
                <div className="cx-rows">
                  {vehicles.slice(0, VEHICLE_PREVIEW).map((v) => (
                    <button
                      type="button"
                      key={String(v._id)}
                      onClick={() => navigate("/my-vehicles")}
                      className="cx-row"
                    >
                      <VehicleArt type={v.vehicleType} image={v.image} size={42} radius={11} />
                      <div className="cx-row-main">
                        <div className="cx-row-name">{v.vehicleType || "Car"}</div>
                        <div className="cx-row-sub">{vehicleDisplayName(v)}</div>
                        <div className="flex gap-1.5 mt-1 flex-wrap">
                          <span className="cx-tag is-green">{v.fuelType || "Petrol"}</span>
                          {v.isDefault && <span className="cx-tag is-green">Default</span>}
                        </div>
                      </div>
                      <span className="cx-plate">{v.registrationNumber || "—"}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className={vehicles.length > 0 ? "px-4 py-3 sm:px-5" : ""}>
                {vehicles.length === 0 && (
                  <p className="text-[12px] mb-3" style={{ color: "var(--muted)" }}>
                    Save a car or bike once, then pick it in one tap when you book.
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-outline w-full"
                  onClick={() => navigate("/my-vehicles")}
                >
                  <i className="fas fa-plus" aria-hidden /> Add Vehicle
                </button>
              </div>
            </div>
          </section>

          {bookingsPanel}
        </aside>
      </div>
    </Layout>
  );
}


/** One dashboard figure: icon tile, the number, its label, and a way in. */
function StatTile({
  icon,
  tone,
  value,
  label,
  onClick,
  testId,
}: {
  icon: string;
  tone: string;
  value: number | string;
  label: string;
  onClick?: () => void;
  testId?: string;
}) {
  const inner = (
    <>
      <span className={`cx-stat-icon ${tone}`} style={{ width: 44, height: 44, flex: "0 0 auto" }}>
        <i className={`fas ${icon}`} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xl font-extrabold leading-tight" style={{ color: "var(--text)" }}>
          {value}
        </span>
        <span className="block text-[12px]" style={{ color: "var(--muted)" }}>
          {label}
        </span>
      </span>
      {onClick && <i className="fas fa-chevron-right text-[12px]" style={{ color: "var(--muted)" }} aria-hidden />}
    </>
  );
  const cls = "cx-panel flex items-center gap-3 px-4 py-3.5 text-left w-full";
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} data-testid={testId}>
      {inner}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {inner}
    </div>
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
        {b.queueInfo && b.status === "upcoming" && (
          <div className="mb-4">
            <QueueInfoCard info={b.queueInfo} />
          </div>
        )}
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


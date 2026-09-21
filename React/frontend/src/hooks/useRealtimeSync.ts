import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Booking, Station } from "@/types";
import { onResync, onSocket } from "@/services/socket/socket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { useAuthStore } from "@/store/authStore";
import { useBookingStore } from "@/store/bookingStore";
import { useStationStore } from "@/store/stationStore";
import { useNotificationStore } from "@/store/notificationStore";
import { pushToast } from "@/store/toastStore";

/**
 * The application's single real-time wiring.
 *
 * ARCHITECTURE
 *
 *   Socket.IO server -> this hook -> Zustand store -> React re-renders
 *
 * Nothing here touches the DOM and nothing calls a "refresh". A store write
 * is the only effect an event has, and the components subscribed to that
 * store update themselves. That is what makes "no manual refresh" a property
 * of the design rather than something each page has to remember.
 *
 * MOUNTED EXACTLY ONCE, at the App root. These handlers are app-wide -- a
 * booking event matters whichever page you are on -- so they are not
 * page-scoped. Page-scoped subscriptions (StationDetail following one
 * station) register and clean up themselves via useWatchStation.
 *
 * EVENT NAMES are the canonical ones from backend/src/services/notification/realtime.js. The
 * server also emits a legacy alias for each ("booking_updated" beside
 * "booking:updated") for bundles cached before that shipped; binding to both
 * would handle every change twice, so this binds to the canonical name only.
 *
 * TRUST: the server addresses booking and notification events to
 * `user:<id>` / `vendor:<id>` / `admin` rooms, so anything that arrives here
 * is genuinely ours -- there is no client-side filtering by id, and adding
 * some would not be a security improvement anyway.
 */
export function useRealtimeSync() {
  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);

  const loadBookings = useBookingStore((s) => s.load);
  const upsertBooking = useBookingStore((s) => s.upsert);

  const loadStations = useStationStore((s) => s.load);
  const patchStation = useStationStore((s) => s.patchStation);
  const addStation = useStationStore((s) => s.addStation);
  const removeStation = useStationStore((s) => s.removeStation);

  const addNotification = useNotificationStore((s) => s.add);
  const loadNotifications = useNotificationStore((s) => s.load);

  /**
   * Booking ids already announced as complete.
   *
   * A completion can be observed twice -- the booking:completed event and the
   * countdown's fallback poll can both see the same row -- and the customer
   * should be told once. Vanilla's `notifiedCompletions` set, kept in a ref so
   * it survives re-renders without being state.
   */
  const notified = useRef<Set<string>>(new Set());

  // Keep the latest user in a ref so the effect below can stay mounted for
  // the whole session instead of resubscribing every time the profile
  // changes -- resubscribing is precisely how duplicate listeners appear.
  const userRef = useRef(user);
  userRef.current = user;

  // Fueling started for this customer (the attendant entered their code):
  // open that booking's live countdown page from wherever they are. Once per
  // booking, customers only -- vendors and admins receive the same event.
  const navigate = useNavigate();
  const location = useLocation();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const openedCountdown = useRef<Set<string>>(new Set());

  useEffect(() => {
    /** Fired for every booking event. The list is refetched, not guessed. */
    const onBooking = (booking: Booking) => {
      // Patch first so the change is on screen immediately, then refetch for
      // the authoritative version. The patch is timestamp-guarded, so a
      // slower refetch cannot be overwritten by this older event.
      upsertBooking(booking);
      void loadBookings();
      openCountdown(booking);
      announceCompletion(booking);
    };

    const openCountdown = (booking: Booking) => {
      if (!booking || booking.status !== "serving") return;
      const me = userRef.current;
      if (!me || me.role !== "customer") return;
      const bookingUserId =
        typeof booking.user === "object" && booking.user ? booking.user._id : booking.user;
      if (String(bookingUserId) !== String(me.id ?? me._id)) return;

      const id = String(booking._id);
      if (!id || openedCountdown.current.has(id)) return;
      openedCountdown.current.add(id);
      const target = `/confirmation/${id}`;
      if (pathRef.current !== target) navigateRef.current(target);
    };

    const announceCompletion = (booking: Booking) => {
      if (!booking || booking.status !== "completed") return;
      const me = userRef.current;
      if (!me) return;

      const bookingUserId =
        typeof booking.user === "object" && booking.user ? booking.user._id : booking.user;
      // Vendors and admins receive other people's bookings in this room; only
      // the customer whose booking it is gets the "your service is done" note.
      if (String(bookingUserId) !== String(me.id ?? me._id)) return;

      const id = String(booking._id);
      if (!id || notified.current.has(id)) return;
      notified.current.add(id);

      const fuelType = booking.fuelType || "Fuel";
      const isCng = String(fuelType).toLowerCase() === "cng";
      const message = isCng
        ? "Your 5-minute CNG service has been completed."
        : `Your ${fuelType} booking has been completed.`;

      addNotification({
        id: `completion-${id}`,
        type: "booking",
        title: isCng ? "CNG Booking Completed" : "Booking Completed",
        message,
        time: "Just now",
        read: false,
      });
      pushToast(message, "success");
    };

    const isOperator = () => {
      const role = userRef.current?.role;
      return role === "vendor" || role === "admin";
    };

    // Each returns its own unsubscribe; they are collected and all called on
    // unmount. Missing one is how a listener outlives its component.
    const off: Array<() => void> = [
      // ---- bookings ----------------------------------------------------
      onSocket<Booking>(SOCKET_EVENTS.BOOKING_CREATED, (booking) => {
        onBooking(booking);
        if (isOperator()) {
          pushToast(`New booking: ${booking.fuelType || "fuel"} · ₹${booking.amount || 0}`, "info");
        }
      }),
      onSocket<Booking>(SOCKET_EVENTS.BOOKING_UPDATED, onBooking),
      onSocket<Booking>(SOCKET_EVENTS.BOOKING_COMPLETED, onBooking),
      onSocket<Booking>(SOCKET_EVENTS.BOOKING_CANCELLED, (booking) => {
        onBooking(booking);
        pushToast("A booking was cancelled", "warning");
      }),
      // The customer's live turn in the nozzle line. Only patches a booking
      // already held: an ETA alone is not enough to render a booking row.
      onSocket<{ bookingId?: string; position?: number; etaMinutes?: number }>(
        SOCKET_EVENTS.ETA_UPDATE,
        (eta) => {
          if (!eta?.bookingId) return;
          const held = useBookingStore.getState().bookings.some((b) => String(b._id) === String(eta.bookingId));
          if (!held) return;
          upsertBooking({ _id: eta.bookingId, etaMinutes: eta.etaMinutes ?? null, queuePosition: eta.position ?? null });
        },
      ),

      // ---- stations ----------------------------------------------------
      onSocket<Station & Record<string, unknown>>(SOCKET_EVENTS.STATION_CREATED, (station) => {
        const added = addStation(station);
        if (added) pushToast(`New station available: ${added.name}`, "success");
      }),
      onSocket<Station>(SOCKET_EVENTS.STATION_UPDATED, patchStation),
      onSocket<{ id?: string; _id?: string }>(SOCKET_EVENTS.STATION_DELETED, (payload) => {
        const id = String(payload?.id ?? payload?._id ?? "");
        if (!id) return;
        const existing = useStationStore.getState().stations.find((x) => String(x.id) === id);
        removeStation(id);
        if (existing) pushToast(`${existing.name} is no longer available`, "warning");
      }),

      // ---- prices, availability, queue, inventory ----------------------
      // Each carries only what changed, so patchStation merges rather than
      // replaces -- which is what lets a price tick over without the card
      // flickering or losing its client-computed distance.
      onSocket<Station & { id?: string; fuelType?: string; newPrice?: number }>(
        SOCKET_EVENTS.FUEL_PRICE_UPDATED,
        (payload) => {
          patchStation(payload);
          const station = useStationStore
            .getState()
            .stations.find((x) => String(x._id) === String(payload._id ?? payload.id));
          if (!station) return; // a station this client is not showing
          const label = String(payload.fuelType || "Fuel");
          pushToast(
            `${station.name}: ${label.charAt(0).toUpperCase() + label.slice(1)} now ₹${payload.newPrice}`,
            "info",
          );
        },
      ),
      onSocket<Station>(SOCKET_EVENTS.FUEL_AVAILABILITY_UPDATED, patchStation),
      onSocket<Station>(SOCKET_EVENTS.QUEUE_UPDATED, patchStation),
      onSocket<Station>(SOCKET_EVENTS.INVENTORY_UPDATED, patchStation),
      onSocket<Station>(SOCKET_EVENTS.STATION_STATUS_UPDATED, patchStation),

      // ---- vendor ------------------------------------------------------
      // Website only: compiled out of the customer app build (VITE_APP_MODE=customer).
      ...(import.meta.env.VITE_APP_MODE === "customer"
        ? []
        : [
      // The vendor's tracking page flips from "waiting" to "check your email"
      // with no refresh, because the store it reads is updated here.
      onSocket<{ vendorStatus?: string; vendorCode?: string; secretCodeEmailed?: boolean }>(
        SOCKET_EVENTS.VENDOR_APPROVED,
        (payload) => {
          patchUser({
            vendorStatus: payload.vendorStatus as never,
            ...(payload.vendorCode ? { vendorCode: payload.vendorCode } : {}),
          });
          pushToast(
            payload.secretCodeEmailed
              ? "Your vendor application was approved — check your email for the access code"
              : "Your vendor application was approved. Ask an admin to resend your access code.",
            "success",
          );
        },
      ),

      // A signed-in vendor whose account was suspended, reactivated or had its
      // code reissued: the route guard reads these fields, so the panel closes
      // (or reopens) at once. Admins receive the same event about OTHER
      // vendors -- only a payload about this user is applied.
      onSocket<{ vendorId?: string; vendorStatus?: string; activated?: boolean }>(
        SOCKET_EVENTS.VENDOR_STATUS_CHANGED,
        (payload) => {
          const me = userRef.current;
          if (!me || me.role !== "vendor" || String(payload?.vendorId) !== String(me.id ?? me._id)) return;
          if (!payload.vendorStatus || payload.vendorStatus === "deleted") return;
          patchUser({
            vendorStatus: payload.vendorStatus as never,
            ...(typeof payload.activated === "boolean" ? { activated: payload.activated } : {}),
          });
          if (payload.vendorStatus === "suspended") pushToast("Your vendor account has been suspended.", "warning");
        },
      ),

          ]),

      // ---- notifications -----------------------------------------------
      onSocket<{ _id?: string; type?: string; title?: string; body?: string; message?: string }>(
        SOCKET_EVENTS.NOTIFICATION_CREATED,
        (note) => {
          addNotification({
            id: String(note._id ?? `note-${Date.now()}`),
            type: note.type || "booking",
            title: note.title || "Notification",
            // The server row's text field is `body`; it used to render blank.
            message: note.body || note.message || "",
            time: "Just now",
            read: false,
          });
          if (note.title) pushToast(note.title, "info");
        },
      ),

      // ---- resync after a dropped connection ---------------------------
      // Events that happened while offline are gone; socket.io does not
      // replay. Pull a fresh baseline over HTTP rather than trusting whatever
      // was on screen when the link dropped.
      onResync(() => {
        void loadBookings();
        void loadStations();
        void loadNotifications();
      }),
    ];

    return () => off.forEach((fn) => fn());
    // Every dependency is a stable Zustand action or a ref, so this subscribes
    // once per session. Anything unstable here would tear down and re-add all
    // fourteen listeners on each render.
  }, [
    upsertBooking,
    loadBookings,
    loadStations,
    patchStation,
    addStation,
    removeStation,
    addNotification,
    loadNotifications,
    patchUser,
  ]);
}

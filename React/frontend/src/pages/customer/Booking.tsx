import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { UiStation, Vehicle } from "@/types";
import Layout from "@/components/layout/Layout";
import Loader from "@/components/common/Loader";
import StepProgress from "@/components/booking/StepProgress";
import FuelVehicleStep from "@/components/booking/FuelVehicleStep";
import DateSlotStep from "@/components/booking/DateSlotStep";
import QuantityStep from "@/components/booking/QuantityStep";
import ConfirmPayStep from "@/components/booking/ConfirmPayStep";
import FasterStationNotice from "@/components/booking/FasterStationNotice";
import VehicleArt from "@/components/vehicle/VehicleArt";
import { useAuthStore } from "@/store/authStore";
import { useBookingStore } from "@/store/bookingStore";
import { useBookingDraftStore } from "@/store/bookingDraftStore";
import { useStationStore } from "@/store/stationStore";
import { pushToast } from "@/store/toastStore";
import { cancelBooking, createBooking, fetchAvailability } from "@/services/api/bookingApi";
import CancelBookingSheet from "@/components/booking/CancelBookingSheet";
import { useResync, useSocketEvent, useWatchStation } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/services/socket/socketEvents";
import { coalesce } from "@/utils/coalesce";
import { addVehicle } from "@/services/api/customerApi";
import { toApiError } from "@/services/api/apiClient";
import {
  BOOKING_STEPS,
  PAY_AT_PUMP,
  SERVICE_FEE,
  TIME_SLOTS,
} from "@/constants/booking";
import { formatCurrency, isSlotElapsed } from "@/utils/format";
import { istDateKey } from "@/utils/businessTime";
import { resolveDraftVehicle, vehicleDisplayName, type DraftVehicle } from "@/utils/vehicle";

/**
 * Port of renderBooking() plus app.js's booking event handlers.
 *
 * Query parameters replace the Vanilla `navigate('booking', {...})` state
 * payload, so /booking?stationId=… is a real address the station cards, the
 * predicted-pump result and "Book with This" can all link to directly.
 *
 * The one-active-booking rule, the four steps, the per-step validation
 * messages and the suggestedSlot recovery are preserved exactly. Payment is
 * taken at the petrol pump only: every booking is sent as pay-at-the-pump.
 *
 * The vehicle is chosen (or added inline) in step 0, shown in the live
 * summary beside the wizard, and sent with the booking as a plate plus a
 * type/name snapshot (backend/src/services/booking/vehicleSnapshot.js).
 */
export default function Booking() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const user = useAuthStore((s) => s.user);
  const patchUser = useAuthStore((s) => s.patchUser);
  const bookings = useBookingStore((s) => s.bookings);
  const loadBookings = useBookingStore((s) => s.load);
  const stations = useStationStore((s) => s.stations);
  const loadStations = useStationStore((s) => s.load);

  const step = useBookingDraftStore((s) => s.step);
  const setStep = useBookingDraftStore((s) => s.setStep);
  const draft = useBookingDraftStore((s) => s.draft);
  const patch = useBookingDraftStore((s) => s.patch);
  const submitting = useBookingDraftStore((s) => s.submitting);
  const setSubmitting = useBookingDraftStore((s) => s.setSubmitting);
  const resetDraft = useBookingDraftStore((s) => s.reset);

  const [savingVehicle, setSavingVehicle] = useState(false);

  const vehicles = useMemo<Vehicle[]>(() => user?.vehicles ?? [], [user]);
  const draftVehicle = useMemo(() => resolveDraftVehicle(draft, vehicles), [draft, vehicles]);

  useEffect(() => {
    void loadBookings();
    // Always refetch: the list on screen stays while the fresh one loads, so
    // navigating back here never shows prices or stations from earlier.
    void loadStations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the draft from the URL once the station list is available. This is
  // what carries "Book Now", "Book with This" and the predicted-pump card's
  // pre-chosen fuel/slot into the wizard.
  useEffect(() => {
    const stationId = params.get("stationId");
    const fuelType = params.get("fuelType");
    const timeSlot = params.get("timeSlot");
    const vehicleId = params.get("vehicleId");
    const vehiclePlate = params.get("vehiclePlate");
    const stepParam = params.get("step");

    const seed: Record<string, unknown> = {};
    if (stationId) {
      seed.stationId = stationId;
      seed.stationName = params.get("stationName");
    }
    // The nearby-search returns "PETROL"; the station's fuelTypes are
    // "Petrol". Match the station's casing so the fuel button highlights.
    if (fuelType) {
      seed.fuelType = fuelType.charAt(0).toUpperCase() + fuelType.slice(1).toLowerCase();
    }
    // Only a real bookable label: the nearest-pump card can pass a
    // "HH:MM-HH:MM" bucket, which the server refuses as a start time.
    if (timeSlot && (TIME_SLOTS as readonly string[]).includes(timeSlot)) seed.timeSlot = timeSlot;
    if (vehicleId) seed.vehicleId = vehicleId;
    if (vehiclePlate) seed.vehiclePlate = vehiclePlate;

    if (Object.keys(seed).length > 0) patch(seed);
    if (stepParam) setStep(Number(stepParam) || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default the vehicle to the user's default, as the Vanilla page did on
  // every render. Only when nothing has been chosen yet -- a saved pick or a
  // one-time vehicle -- so it never overrides a deliberate choice.
  useEffect(() => {
    if (draft.vehicleId || draft.vehiclePlate || vehicles.length === 0) return;
    const def = vehicles.find((v) => v.isDefault) ?? vehicles[0];
    patch({
      vehicleId: String(def._id ?? ""),
      vehiclePlate: def.registrationNumber ?? null,
      vehicleType: def.vehicleType ?? null,
      vehicleName: vehicleDisplayName(def),
    });
  }, [vehicles, draft.vehicleId, draft.vehiclePlate, patch]);

  /** Default the date to today, matching the Vanilla grid's own default. */
  useEffect(() => {
    if (!draft.date) patch({ date: istDateKey() });
  }, [draft.date, patch]);

  const station: UiStation | null = useMemo(() => {
    if (draft.stationId) {
      return stations.find((x) => String(x.id) === String(draft.stationId)) ?? null;
    }
    // The sidebar's generic "Book Fuel" link starts with no station chosen.
    return stations[0] ?? null;
  }, [stations, draft.stationId]);

  /**
   * The one-active-booking rule, unchanged: a customer may hold exactly one
   * live booking. Elapsed slots do not count, because the sweep expires them
   * shortly after and they would otherwise lock the user out permanently.
   */
  const activeBookings = useMemo(
    () =>
      bookings.filter(
        (b) =>
          ["upcoming", "serving", "waitlisted"].includes(b.status) &&
          !isSlotElapsed(b.bookingDate, b.timeSlot),
      ),
    [bookings],
  );

  // "Cancel & rebook" from the one-booking notice: cancel the current booking
  // (with the usual confirmation), then this page carries on as a new booking.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const cancelAndRebook = async (reason?: string) => {
    const current = activeBookings[0];
    if (!current) return;
    setCancelBusy(true);
    try {
      await cancelBooking(String(current._id), reason);
      pushToast("Booking cancelled. Choose your new slot.", "success");
      setCancelOpen(false);
      await loadBookings();
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
    } finally {
      setCancelBusy(false);
    }
  };
  const cancelSheet = (
    <CancelBookingSheet
      open={cancelOpen}
      waitlisted={activeBookings[0]?.status === "waitlisted"}
      busy={cancelBusy}
      onClose={() => setCancelOpen(false)}
      onConfirm={(reason) => void cancelAndRebook(reason)}
    />
  );

  /**
   * The station's published price for the chosen fuel, or null. Never a
   * made-up default: the server prices the booking itself and refuses an
   * unpriced fuel, so an estimate built on a guess would only mislead.
   */
  const unitPrice: number | null = useMemo(() => {
    if (!station || !draft.fuelType) return null;
    const p = station.uiPrices[draft.fuelType as keyof typeof station.uiPrices];
    return typeof p === "number" && p > 0 ? p : null;
  }, [station, draft.fuelType]);

  const total: number | null = unitPrice === null ? null : draft.quantity * unitPrice + SERVICE_FEE;

  /**
   * The chosen slot is full on the server's own availability rows, so
   * submitting joins its waitlist. The server re-checks: if the slot freed up
   * in the meantime, the same request simply books it.
   */
  const availability = useBookingDraftStore((s) => s.availability);
  const slotFull = useMemo(() => {
    const a = availability;
    if (!a || !station || String(a.stationId) !== String(station.id)) return false;
    if (a.fuelType !== draft.fuelType || a.date !== draft.date) return false;
    return a.slots.some((r) => r.label === draft.timeSlot && r.reason === "RESERVED");
  }, [availability, station, draft.fuelType, draft.date, draft.timeSlot]);

  /**
   * Live slots. The station's room carries slot:updated whenever a booking
   * there is made, cancelled, missed, promoted or finished; the grid (and the
   * "slot is full" state on the review step) refetch the server's availability
   * rows instead of waiting for a page refresh. Also after a reconnect.
   */
  const stationId = station?.id ?? null;
  const setAvailability = useBookingDraftStore((s) => s.setAvailability);
  useWatchStation(stationId);
  const refreshAvailability = useMemo(
    () =>
      coalesce(async () => {
        const d = useBookingDraftStore.getState().draft;
        if (!stationId || !d.fuelType || !d.date) return;
        const fresh = await fetchAvailability(stationId, d.fuelType, d.date);
        const now = useBookingDraftStore.getState().draft;
        if (now.fuelType === d.fuelType && now.date === d.date) setAvailability(fresh);
      }),
    [stationId, setAvailability],
  );
  useSocketEvent<{ stationId?: string }>(
    SOCKET_EVENTS.SLOT_UPDATED,
    (change) => {
      if (stationId && String(change?.stationId) === String(stationId)) refreshAvailability();
    },
    [stationId, refreshAvailability],
  );
  useResync(refreshAvailability, [refreshAvailability]);

  /** Saves a vehicle added inside the wizard. Returns it, or null on failure. */
  const onSaveVehicle = async (fields: Partial<Vehicle>): Promise<Vehicle | null> => {
    setSavingVehicle(true);
    try {
      const next = await addVehicle(fields, null);
      patchUser({ vehicles: next });
      pushToast("Vehicle saved to My Vehicles", "success");
      return next.find((v) => v.registrationNumber === fields.registrationNumber) ?? null;
    } catch (err) {
      pushToast(toApiError(err).msg, "error");
      return null;
    } finally {
      setSavingVehicle(false);
    }
  };

  /** Per-step validation, with the Vanilla messages verbatim. */
  const next = () => {
    if (step === 0 && !draft.fuelType) return pushToast("Please select a fuel type", "error");
    if (step === 0 && !draftVehicle) return pushToast("Please select a vehicle", "error");
    if (step === 1 && !draft.date) return pushToast("Please select a date", "error");
    if (step === 1 && !draft.timeSlot) return pushToast("Please select a time slot", "error");
    if (step === 2 && (!draft.quantity || draft.quantity < 1)) {
      return pushToast("Please enter quantity", "error");
    }
    if (step === 2 && unitPrice === null) {
      return pushToast(`This station has not published a ${draft.fuelType ?? "fuel"} price yet`, "error");
    }
    setStep(step + 1);
    window.scrollTo(0, 0);
  };

  const pay = async () => {
    if (!station?.id) return pushToast("Please select a station before booking", "error");
    if (unitPrice === null || total === null) {
      return pushToast("This station has not published a price for this fuel", "error");
    }

    setSubmitting(true);
    try {
      const { booking } = await createBooking({
        stationId: station.id,
        fuelType: draft.fuelType || "Petrol",
        quantity: draft.quantity,
        price: unitPrice,
        taxes: SERVICE_FEE,
        bookingDate: draft.date || istDateKey(),
        amount: total,
        timeSlot: draft.timeSlot,
        vehiclePlate: draftVehicle?.plate || draft.vehiclePlate || draft.vehicleId,
        vehicleType: draftVehicle?.type ?? null,
        vehicleName: draftVehicle?.name ?? null,
        // Paid at the petrol pump -- including a waitlist request, once the slot is won.
        payMethod: PAY_AT_PUMP,
        ...(slotFull ? { joinWaitlist: true } : {}),
      });

      await loadBookings();

      if (slotFull) {
        pushToast(
          booking.status === "waitlisted"
            ? `You're on the waitlist for ${booking.timeSlot}${booking.waitlistPosition ? ` (#${booking.waitlistPosition})` : ""}`
            : "The slot just freed up. Booking confirmed! Please pay at the petrol pump.",
          "success",
        );
        resetDraft();
        navigate(`/confirmation/${booking._id}`);
        return;
      }

      pushToast("Booking confirmed! Please pay at the petrol pump.", "success");
      resetDraft();
      navigate(`/confirmation/${booking._id}`);
    } catch (err) {
      const e = err as { response?: { data?: { suggestedSlot?: string; msg?: string } } };
      const suggested = e?.response?.data?.suggestedSlot;

      // Someone took this slot between the grid loading and submit. Back to
      // step 1 with the slot still selected: the grid reloads, shows it full,
      // and the customer chooses -- its waitlist, or the next free slot the
      // server named. Nothing is switched for them.
      if (e?.response?.data && (e.response.data as { reason?: string }).reason === "SLOT_FULL") {
        useBookingDraftStore.getState().setAvailability(null);
        setStep(1);
        pushToast(
          `Slot '${draft.timeSlot}' was just booked. Join its waitlist${suggested ? ` or take ${suggested}` : ""}.`,
          "warning",
        );
        return;
      }
      pushToast(toApiError(err).msg, "error");
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Take the recommender's station. Date, slot, fuel and quantity stay: the
   * server only recommends a station that can take exactly that booking. The
   * station list normally holds it already; if not, reload before switching so
   * the wizard never points at a station it cannot show.
   */
  const switchStation = async (stationId: string, stationName: string) => {
    if (!stations.some((x) => String(x.id) === stationId)) await loadStations();
    if (!useStationStore.getState().stations.some((x) => String(x.id) === stationId)) {
      return pushToast("Could not load that station. Please try again.", "error");
    }
    patch({ stationId, stationName, payMethod: null });
    pushToast(`Switched to ${stationName}`, "success");
  };

  if (activeBookings.length > 0) {
    const current = activeBookings[0];
    const currentStation = stations.find((x) => x.id === String(typeof current.station === "object" ? current.station?._id : current.station));
    const serving = current.status === "serving";
    return (
      <Layout bare>
        <div className="cx max-w-xl mx-auto pt-10 md:pt-16">
          {cancelSheet}
          <div className="cx-panel" style={{ animation: "slideUp .3s ease" }}>
            <div className="cx-panel-body" style={{ padding: "28px 24px" }}>
              <div className="flex items-center gap-3 mb-4">
                <span className="cx-stat-icon cx-tone-blue" style={{ width: 44, height: 44 }}>
                  <i className="fas fa-calendar-check" aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 className="cx-title" style={{ fontSize: 20 }}>You already have a booking</h2>
                  <p className="text-[13px]" style={{ color: "var(--muted)" }}>One booking at a time keeps slots fair for everyone.</p>
                </div>
              </div>
              <div className="rounded-xl p-3.5 mb-5" style={{ background: "var(--bg2)", border: "1px solid var(--border)" }}>
                <p className="font-bold text-[14px] truncate">{currentStation?.name ?? "Your station"}</p>
                <p className="text-[13px] mt-0.5" style={{ color: "var(--muted)" }}>
                  {current.bookingDate} · {current.timeSlot} · {current.fuelType}
                  {typeof current.quantity === "number" ? ` · ${current.quantity} L` : ""}
                </p>
                <span className="cx-tag is-green mt-2 inline-block">
                  {serving ? "Fueling now" : current.status === "waitlisted" ? "On the waitlist" : "Upcoming"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button className="btn btn-primary btn-block" onClick={() => navigate(`/confirmation/${current._id}`)}>
                  <i className="fas fa-qrcode" aria-hidden /> View booking
                </button>
                {/* A booking already being fueled cannot be cancelled. */}
                <button className="btn btn-outline btn-block" disabled={serving} onClick={() => setCancelOpen(true)}>
                  <i className="fas fa-rotate" aria-hidden /> Cancel &amp; rebook
                </button>
              </div>
            </div>
          </div>
        </div>
      </Layout>
    );
  }

  if (!station) {
    return (
      <Layout bare>
        <Loader label="Loading station…" />
      </Layout>
    );
  }

  const reviewing = step === 3;

  return (
    <Layout bare>
      <div className={`cx mx-auto ${reviewing ? "max-w-2xl" : "max-w-5xl"}`}>
        <div className="cx-page-head">
          <div className="min-w-0">
            <button
              type="button"
              className="cx-back"
              onClick={() => (step > 0 ? setStep(step - 1) : navigate(`/stations/${station.id}`))}
            >
              <i className="fas fa-arrow-left" aria-hidden />
              {step > 0 ? "Back" : "Station Details"}
            </button>
            <h1 className="cx-title">Book Fuel Slot</h1>
            <p className="cx-subtitle">
              <i className="fas fa-gas-pump" aria-hidden />
              <span className="truncate">{station.name}</span>
            </p>
          </div>
          <span className="cx-tag is-blue" style={{ fontSize: 12, padding: "5px 12px" }}>
            Step {step + 1} of {BOOKING_STEPS.length} · {BOOKING_STEPS[step]}
          </span>
        </div>

        <div className={reviewing ? "" : "grid gap-5 items-start lg:grid-cols-[minmax(0,1fr)_300px]"}>
          <section className="cx-panel">
            <div className="cx-panel-head cx-stepper" style={{ display: "block", paddingTop: 18 }}>
              <StepProgress step={step} />
            </div>

            <div className="cx-panel-body" key={step} style={{ animation: "slideUp .3s ease" }}>
              {step === 0 && (
                <FuelVehicleStep
                  station={station}
                  vehicles={vehicles}
                  onSaveVehicle={onSaveVehicle}
                  savingVehicle={savingVehicle}
                />
              )}
              {step === 1 && <DateSlotStep station={station} />}
              {step === 2 && <QuantityStep unitPrice={unitPrice} stationId={station.id} />}
              {step === 3 && (
                <div className="mb-4">
                  <FasterStationNotice
                    stationId={station.id}
                    fuelType={draft.fuelType}
                    quantity={draft.quantity}
                    date={draft.date}
                    timeSlot={draft.timeSlot}
                    onSwitch={switchStation}
                  />
                </div>
              )}
              {step === 3 && (
                <ConfirmPayStep
                  station={station}
                  vehicles={vehicles}
                  unitPrice={unitPrice}                  waitlist={slotFull}
                />
              )}
            </div>

            <div className="cx-panel-foot">
              {step < 3 ? (
                <button
                  className="btn btn-primary btn-block btn-lg"
                  disabled={step === 0 && !draft.fuelType}
                  onClick={next}
                >
                  {step === 2 ? "Review Booking" : "Continue"}{" "}
                  <i className="fas fa-arrow-right" aria-hidden />
                </button>
              ) : (
                <button
                  className="btn btn-primary btn-block btn-lg"
                  disabled={submitting || total === null}
                  onClick={pay}
                >
                  {submitting ? (
                    <>
                      <i className="fas fa-spinner fa-spin" aria-hidden /> Processing...
                    </>
                  ) : total === null ? (
                    "Price not published"
                  ) : slotFull ? (
                    <>
                      <i className="fas fa-hourglass-half" aria-hidden /> Join Waitlist for {draft.timeSlot}
                    </>
                  ) : (
                    <>
                      <i className="fas fa-lock" aria-hidden /> Pay {formatCurrency(total)}
                    </>
                  )}
                </button>
              )}
            </div>
          </section>

          {!reviewing && (
            <BookingSummary
              stationName={station.name}
              fuelType={draft.fuelType}
              vehicle={draftVehicle}
              date={draft.date}
              timeSlot={draft.timeSlot}
              quantity={draft.quantity}
              total={total}
            />
          )}
        </div>
      </div>
    </Layout>
  );
}

/** "2026-09-10" -> "Thu, 10 Sept". */
function formatDay(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

/** The live summary beside the wizard on wide screens. */
function BookingSummary({
  stationName,
  fuelType,
  vehicle,
  date,
  timeSlot,
  quantity,
  total,
}: {
  stationName: string;
  fuelType: string | null;
  vehicle: DraftVehicle | null;
  date: string | null;
  timeSlot: string | null;
  quantity: number;
  total: number | null;
}) {
  const fact = (label: string, value: string | null) => (
    <div className="cx-fact">
      <dt>{label}</dt>
      <dd className={value ? "" : "is-empty"}>{value || "Not selected"}</dd>
    </div>
  );

  return (
    <aside className="cx-panel hidden lg:block lg:sticky lg:top-6" aria-label="Booking summary">
      <div className="cx-panel-head">
        <h2 className="cx-panel-title">
          <i className="fas fa-receipt" aria-hidden /> Your booking
        </h2>
      </div>
      <div className="cx-panel-body">
        {vehicle ? (
          <div className="cx-vehicle-card mb-4">
            <VehicleArt type={vehicle.type} image={vehicle.image} size={44} />
            <div className="min-w-0">
              <p className="cx-option-name">{vehicle.name}</p>
              <span className="cx-plate mt-1">{vehicle.plate}</span>
            </div>
          </div>
        ) : (
          <div className="cx-vehicle-card mb-4" style={{ borderStyle: "dashed", background: "transparent" }}>
            <VehicleArt type="Car" size={44} />
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              No vehicle selected yet
            </p>
          </div>
        )}

        <dl className="cx-facts">
          {fact("Station", stationName)}
          {fact("Fuel", fuelType)}
          {fact("Date", formatDay(date))}
          {fact("Slot", timeSlot)}
          {fact("Quantity", `${quantity} L`)}
        </dl>
        <hr className="cx-split" />
        <div className="cx-total">
          <span className="cx-total-label">Est. total</span>
          <span className={`cx-total-value ${fuelType ? "" : "is-empty"}`}>
            {!fuelType ? "Select a fuel" : total === null ? "Price not published" : formatCurrency(total)}
          </span>
        </div>
        <p className="text-[11px] mt-1.5" style={{ color: "var(--muted)" }}>
          Includes {formatCurrency(SERVICE_FEE)} convenience fee.
        </p>
      </div>
    </aside>
  );
}

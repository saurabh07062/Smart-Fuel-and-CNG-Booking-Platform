import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Layout from "@/components/layout/Layout";
import { useFleetStore, plateKey, todayKey } from "@/store/fleetStore";
import { useAuthStore } from "@/store/authStore";
import { useStationStore } from "@/store/stationStore";
import { TIME_SLOTS, QUANTITY_MIN, QUANTITY_MAX } from "@/constants/booking";
import { formatINR } from "@/utils/consoleFormat";
import RewardRedeemCard from "@/components/booking/RewardRedeemCard";
import type { FleetPlanVehicle } from "@/services/api/fleetApi";
import type { Vehicle } from "@/types/auth";

/**
 * Fleet booking: fuel several vehicles in one visit.
 *
 * The screen is three steps, and it never pretends to know anything the
 * server has not told it:
 *
 *   Build      choose the station, fuel, day, a time to start from, and the
 *              vehicles (from the customer's garage, or typed in)
 *   Schedule   the server's suggested run, one row per vehicle, each row
 *              editable on its own
 *   Confirmed  what was booked -- and, plainly, what was not
 *
 * Every slot, price and refusal on this page comes from /bookings/fleet/*.
 * Nothing here works out capacity; a plan holds nothing, and the server
 * allocates again when Confirm is pressed, which is why a row can come back
 * as "taken" at the last moment and only that vehicle is affected.
 */

/** The status chips the spec asks for, each with what it actually means. */
const STATE_LOOK: Record<string, { label: string; cls: string; icon: string }> = {
  suggested: { label: "Suggested", cls: "fm-fleet-chip-good", icon: "fa-wand-magic-sparkles" },
  selected: { label: "Selected", cls: "fm-fleet-chip-good", icon: "fa-check" },
  confirmed: { label: "Confirmed", cls: "fm-fleet-chip-good", icon: "fa-circle-check" },
  conflict: { label: "Conflict", cls: "fm-fleet-chip-bad", icon: "fa-triangle-exclamation" },
  unavailable: { label: "Full", cls: "fm-fleet-chip-warn", icon: "fa-ban" },
  full: { label: "Full", cls: "fm-fleet-chip-warn", icon: "fa-ban" },
};

export default function FleetBooking() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const savedVehicles = user?.vehicles ?? [];

  const stations = useStationStore((s) => s.stations);
  const loadStations = useStationStore((s) => s.load);

  const s = useFleetStore();
  const [plate, setPlate] = useState("");
  const [quantity, setQuantity] = useState(10);
  const [editing, setEditing] = useState<string | null>(null);
  const [editMessage, setEditMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!stations || stations.length === 0) void loadStations();
    void s.loadGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Opened from a station: "Yes, fleet booking" carries the pump across.
   *
   * A real address rather than router state, so the page can be reloaded or
   * the link shared and still open on the station the customer picked
   * (components/booking/BookingModeSheet.tsx builds it).
   */
  const [params] = useSearchParams();
  useEffect(() => {
    const stationId = params.get("stationId");
    if (stationId) {
      /**
       * The station is settled, so this page does not ask for it again.
       *
       * The customer picked it on the page they came from; putting a "Choose a
       * station…" dropdown in front of them here would invite them to change it
       * by accident and would make the two pages disagree about what is being
       * booked. The chooser is replaced by the station itself, with a way back
       * to the list for a deliberate change.
       *
       * Re-applied on every address change rather than only when the store is
       * empty, so a refresh, a back-navigation or a second station opened from
       * the list all land on the station the address names -- the address is the
       * source of truth here, not whatever the store happened to keep.
       */
      if (stationId !== s.stationId) {
        s.setField("stationId", stationId);
        s.setField("stationName", params.get("stationName"));
      } else if (!s.stationName && params.get("stationName")) {
        s.setField("stationName", params.get("stationName"));
      }
      if (!s.stationLocked) s.setField("stationLocked", true);
    } else if (s.stationLocked) {
      // Reached without a station in the address -- from the sidebar or the
      // dashboard card. That is a fleet booking started from scratch, so the
      // chooser comes back rather than silently keeping the station from
      // whatever the customer was looking at earlier in the session.
      s.setField("stationLocked", false);
    }
    const fuelType = params.get("fuelType");
    // Only a fuel this app knows; a junk query parameter is ignored rather
    // than put in front of the customer as a choice.
    if (fuelType && ["Petrol", "Diesel", "CNG"].includes(fuelType)) s.setField("fuelType", fuelType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const station = useMemo(
    () => (stations || []).find((st) => String(st.id ?? st._id) === s.stationId) || null,
    [stations, s.stationId],
  );

  /** The fuels this station actually sells, so an impossible choice is not offered. */
  const fuels = useMemo(() => {
    const list = station?.fuelTypes?.length ? station.fuelTypes : ["Petrol", "Diesel", "CNG"];
    return list;
  }, [station]);

  const planRow = (p: string): FleetPlanVehicle | undefined =>
    s.plan?.vehicles.find((v) => plateKey(v.vehiclePlate) === plateKey(p));

  const addSaved = (v: Vehicle) => {
    const reg = v.registrationNumber || "";
    if (!reg) return;
    s.addVehicle({
      vehiclePlate: reg,
      quantity,
      vehicleId: v._id ?? null,
      vehicleType: v.vehicleType ?? null,
      nickname: v.nickname ?? null,
    });
  };

  const addTyped = (e: React.FormEvent) => {
    e.preventDefault();
    const reg = plateKey(plate);
    if (!reg) return;
    s.addVehicle({ vehiclePlate: reg, quantity });
    setPlate("");
  };

  const chosen = s.vehicles.length;
  /**
   * What is still missing, in the order the customer would fix it.
   *
   * Said out loud rather than left as a greyed-out button: "Find best slots"
   * being dead with no reason given is the commonest way a form wastes
   * somebody's time. The server checks every one of these again
   * (backend services/booking/fleetPlanner.js validateFleetInput) -- this is so
   * the answer arrives before the request does, not instead of it.
   */
  const missing = useMemo((): string | null => {
    if (!s.stationId) return "Choose a station to book at.";
    if (!s.fuelType) return "Choose which fuel you are filling.";
    if (!s.bookingDate) return "Choose the day.";
    if (s.bookingDate < todayKey()) return "That date has passed. Choose today or a later day.";
    if (s.vehicles.length < 2) {
      return s.vehicles.length === 0
        ? "Add at least 2 vehicles. For a single vehicle, use the normal booking."
        : "Add one more vehicle — a fleet booking is for 2 or more. For a single vehicle, use the normal booking.";
    }
    // Every vehicle must say how much, and each may say something different.
    const noQuantity = s.vehicles.find((v) => !(Number(v.quantity) >= QUANTITY_MIN));
    if (noQuantity) return `Set a fuel quantity of at least ${QUANTITY_MIN} for ${noQuantity.vehiclePlate}.`;
    const tooMuch = s.vehicles.find((v) => Number(v.quantity) > QUANTITY_MAX);
    if (tooMuch) return `${tooMuch.vehiclePlate} is over the ${QUANTITY_MAX} per-vehicle limit.`;
    return null;
  }, [s.stationId, s.fuelType, s.bookingDate, s.vehicles]);

  const canFindSlots = missing === null && !s.planning;

  return (
    <Layout title="Fleet booking" subtitle="Fuel several vehicles in one visit">
      <div className="fm-fleet">
        {/* ── the steps ─────────────────────────────────────────────── */}
        <ol className="fm-fleet-steps" aria-label="Fleet booking steps">
          {(
            [
              ["build", "Vehicles & station"],
              ["schedule", "Suggested schedule"],
              ["confirmed", "Confirmed"],
            ] as const
          ).map(([id, label], i) => (
            <li key={id} className={`fm-fleet-step ${s.step === id ? "is-current" : ""}`} aria-current={s.step === id ? "step" : undefined}>
              <span className="fm-fleet-step-n">{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {s.step !== "confirmed" && (
          <section className="fm-fleet-card" aria-label="What you are booking">
            <h2 className="fm-fleet-h">Where and when</h2>

            <div className="fm-fleet-grid">
              {s.stationLocked ? (
                /*
                  Opened from a station the customer had already chosen: it is
                  shown, not asked for. The name is whichever is known first --
                  the loaded station, or the one carried in the address while the
                  list is still loading -- so this never reads "Station" with a
                  blank beside it.
                */
                <div className="fm-fleet-field fm-fleet-station" data-testid="fleet-station-locked">
                  <span>Station</span>
                  <strong className="fm-fleet-station-name">
                    {station?.name || s.stationName || "Selected station"}
                  </strong>
                  {station?.address && <small className="fm-fleet-station-sub">{station.address}</small>}
                  <button
                    type="button"
                    className="fm-fleet-station-change"
                    onClick={() => navigate("/stations")}
                    data-testid="fleet-station-change"
                  >
                    Change station
                  </button>
                </div>
              ) : (
                <label className="fm-fleet-field">
                  <span>Station</span>
                  <select
                    value={s.stationId ?? ""}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      const found = (stations || []).find((st) => String(st.id ?? st._id) === id);
                      s.setField("stationId", id);
                      s.setField("stationName", found?.name ?? null);
                    }}
                    data-testid="fleet-station-select"
                  >
                    <option value="">Choose a station…</option>
                    {(stations || []).map((st) => (
                      <option key={String(st.id ?? st._id)} value={String(st.id ?? st._id)}>
                        {st.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="fm-fleet-field">
                <span>Fuel</span>
                <select value={s.fuelType} onChange={(e) => s.setField("fuelType", e.target.value)}>
                  {fuels.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>

              <label className="fm-fleet-field">
                <span>Date</span>
                <input
                  type="date"
                  value={s.bookingDate}
                  min={todayKey()}
                  onChange={(e) => s.setField("bookingDate", e.target.value)}
                />
              </label>

              <label className="fm-fleet-field">
                <span>Preferred start</span>
                <select value={s.preferredSlot ?? ""} onChange={(e) => s.setField("preferredSlot", e.target.value || null)}>
                  <option value="">Earliest available</option>
                  {TIME_SLOTS.map((slot) => (
                    <option key={slot} value={slot}>
                      {slot}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        )}

        {s.step !== "confirmed" && (
          <section className="fm-fleet-card" aria-label="Vehicles">
            <h2 className="fm-fleet-h">
              Vehicles <span className="fm-fleet-count">{chosen} chosen</span>
            </h2>

            {savedVehicles.length > 0 && (
              <>
                <p className="fm-fleet-hint">From your garage — tap to add.</p>
                <div className="fm-fleet-pickers">
                  {savedVehicles.map((v) => {
                    const reg = plateKey(v.registrationNumber || "");
                    const added = s.vehicles.some((x) => plateKey(x.vehiclePlate) === reg);
                    return (
                      <button
                        key={String(v._id ?? reg)}
                        type="button"
                        className={`fm-fleet-pick ${added ? "is-added" : ""}`}
                        onClick={() => (added ? s.removeVehicle(reg) : addSaved(v))}
                        aria-pressed={added}
                      >
                        <i className={`fas ${added ? "fa-check" : "fa-plus"}`} aria-hidden />
                        <span>
                          <strong>{reg}</strong>
                          {v.nickname ? <small>{v.nickname}</small> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            <form className="fm-fleet-add" onSubmit={addTyped}>
              <label className="fm-fleet-field">
                <span>Add another vehicle</span>
                <input
                  value={plate}
                  onChange={(e) => setPlate(e.target.value.toUpperCase())}
                  placeholder="MH12AB1234"
                  maxLength={20}
                  aria-label="Registration number"
                />
              </label>
              {/*
                The quantity the NEXT vehicle is added with -- not one figure
                for the whole fleet. Every vehicle keeps its own and can be
                changed in the list below, which the note under this form
                says in as many words.
              */}
              <label className="fm-fleet-field fm-fleet-field-sm">
                <span>Fuel Quantity (L/kg)</span>
                <input
                  type="number"
                  min={QUANTITY_MIN}
                  max={QUANTITY_MAX}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  aria-label="Fuel quantity for the vehicle being added"
                />
              </label>
              <button type="submit" className="fm-fleet-btn" disabled={!plate.trim()}>
                <i className="fas fa-plus" aria-hidden /> Add vehicle
              </button>
            </form>

            <p className="fm-fleet-hint">
              <i className="fas fa-circle-info" aria-hidden /> Each vehicle can have a different quantity.
            </p>

            {chosen > 0 && (
              <ul className="fm-fleet-list" aria-label="Chosen vehicles">
                {s.vehicles.map((v) => {
                  const row = planRow(v.vehiclePlate);
                  const look = STATE_LOOK[row?.state ?? (v.timeSlot ? "selected" : "")] || null;
                  return (
                    <li key={v.vehiclePlate} className="fm-fleet-row">
                      <div className="fm-fleet-row-main">
                        <strong>{v.vehiclePlate}</strong>
                        {v.nickname && <small>{v.nickname}</small>}
                      </div>
                      {/*
                        aria-label on the input itself, not a wrapping <label>:
                        the unit beside it is part of the label's text, so the
                        field's accessible name would otherwise read
                        "Fuel quantity for MH12AB0001 L/kg".
                      */}
                      <span className="fm-fleet-qty">
                        <input
                          type="number"
                          min={QUANTITY_MIN}
                          max={QUANTITY_MAX}
                          value={v.quantity}
                          aria-label={`Fuel quantity for ${v.vehiclePlate}`}
                          onChange={(e) => s.setVehicleQuantity(v.vehiclePlate, Number(e.target.value))}
                        />
                        <span className="fm-fleet-qty-unit" aria-hidden>
                          {s.plan?.unit ?? "L/kg"}
                        </span>
                      </span>
                      {/* What THIS vehicle's fill costs, once the server has
                          priced it. Before that there is no price to show and
                          none is invented. */}
                      {row?.amount != null && (
                        <span className="fm-fleet-row-amount" title={`${row.quantity} ${s.plan?.unit ?? ""} at ₹${row.pricePerUnit}/${s.plan?.unit ?? ""}`}>
                          {formatINR(row.amount)}
                        </span>
                      )}
                      {look && (
                        <span className={`fm-fleet-chip ${look.cls}`}>
                          <i className={`fas ${look.icon}`} aria-hidden /> {look.label}
                        </span>
                      )}
                      <button
                        type="button"
                        className="fm-fleet-icon-btn"
                        onClick={() => s.removeVehicle(v.vehiclePlate)}
                        aria-label={`Remove ${v.vehiclePlate}`}
                      >
                        <i className="fas fa-xmark" aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {chosen < 2 ? (
              <p className="fm-fleet-hint">
                <i className="fas fa-circle-info" aria-hidden /> Add at least two vehicles. For one vehicle, use the
                normal booking.
              </p>
            ) : (
              // Said once, where the quantities are: a fleet is usually a mix
              // of a full tank and a top-up, and nothing here forces one
              // figure on all of them.
              //
              // It deliberately does NOT promise that a bigger fill takes
              // longer: how long a fill takes is a per-fuel setting on this
              // deployment (backend config/fuelDurations.js pins petrol and
              // diesel to one figure), so saying the schedule stretches with
              // the amount would be a claim the app does not keep.
              <p className="fm-fleet-hint">
                <i className="fas fa-circle-info" aria-hidden /> Each vehicle can take a different amount — change any
                figure above. A bigger fill costs more and uses more of the station's stock.
              </p>
            )}

            {s.planError && (
              <p className="fm-fleet-alert" role="alert">
                <i className="fas fa-triangle-exclamation" aria-hidden /> {s.planError}
              </p>
            )}

            {missing && !s.planError && (
              <p className="fm-fleet-hint" data-testid="fleet-missing">
                <i className="fas fa-circle-info" aria-hidden /> {missing}
              </p>
            )}

            <div className="fm-fleet-actions">
              <button type="button" className="fm-fleet-btn fm-fleet-btn-primary" disabled={!canFindSlots} onClick={() => void s.findSlots()}>
                <i className={`fas ${s.planning ? "fa-spinner fa-spin" : "fa-wand-magic-sparkles"}`} aria-hidden />{" "}
                {s.planning ? "Finding slots…" : "Find best slots"}
              </button>
            </div>
          </section>
        )}

        {/* ── the suggested schedule ─────────────────────────────────── */}
        {s.step === "schedule" && s.plan && (
          <section className="fm-fleet-card" aria-label="Suggested schedule">
            <h2 className="fm-fleet-h">Suggested schedule</h2>
            <p className="fm-fleet-summary">{s.plan.summary}</p>

            {!s.plan.stock.enough && (
              <p className="fm-fleet-alert" role="alert">
                <i className="fas fa-triangle-exclamation" aria-hidden /> The station has{" "}
                {s.plan.stock.freeToSell} {s.plan.unit} free to sell, which is less than this plan needs. Some vehicles
                may be refused at confirmation.
              </p>
            )}

            <ul className="fm-fleet-schedule">
              {s.plan.vehicles.map((v, i) => {
                const look = STATE_LOOK[v.state] || STATE_LOOK.suggested;
                return (
                  <li key={v.vehiclePlate} className={`fm-fleet-slot ${v.state !== "suggested" ? "is-problem" : ""}`}>
                    <span className="fm-fleet-slot-n">{i + 1}</span>
                    <div className="fm-fleet-slot-main">
                      <strong>{v.vehiclePlate}</strong>
                      <small>
                        {v.quantity} {s.plan?.unit}
                        {v.pricePerUnit != null ? ` × ₹${v.pricePerUnit}` : ""}
                        {v.amount != null ? ` = ${formatINR(v.amount)}` : ""}
                      </small>
                    </div>

                    <div className="fm-fleet-slot-time">
                      {v.state === "suggested" ? (
                        <>
                          <strong>{v.timeSlot}</strong>
                          <small>
                            {v.startTime}–{v.endTime}
                          </small>
                        </>
                      ) : (
                        <span className="fm-fleet-slot-none">{v.message}</span>
                      )}
                    </div>

                    <span className={`fm-fleet-chip ${look.cls}`}>
                      <i className={`fas ${look.icon}`} aria-hidden /> {look.label}
                    </span>

                    {v.state !== "conflict" && (
                      <div className="fm-fleet-slot-edit">
                        {editing === v.vehiclePlate ? (
                          <select
                            autoFocus
                            defaultValue={v.timeSlot ?? ""}
                            onChange={async (e) => {
                              const message = await s.editSlot(v.vehiclePlate, e.target.value);
                              setEditMessage(message);
                              setEditing(null);
                            }}
                            onBlur={() => setEditing(null)}
                            aria-label={`New time for ${v.vehiclePlate}`}
                          >
                            <option value="" disabled>
                              Pick a time…
                            </option>
                            {TIME_SLOTS.map((slot) => (
                              <option key={slot} value={slot}>
                                {slot}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <button type="button" className="fm-fleet-icon-btn" onClick={() => setEditing(v.vehiclePlate)}>
                            <i className="fas fa-pen" aria-hidden /> Edit slot
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {/*
              A refused edit is reported on the row it concerns, not here as
              well: the row already says "1:00 PM is full…" beside that
              vehicle, and repeating it underneath made the same sentence
              appear twice for one action. Only a failure with no row to land
              on (the request itself failed) is shown here.
            */}
            {editMessage && !s.plan.vehicles.some((v) => v.message === editMessage) && (
              <p className="fm-fleet-alert" role="alert">
                <i className="fas fa-triangle-exclamation" aria-hidden /> {editMessage}
              </p>
            )}

            {/* ── the summary before anything is booked ── */}
            <div className="fm-fleet-totals">
              <div>
                <span className="fm-fleet-total-label">Vehicles to book</span>
                <strong>
                  {s.vehicles.filter((v) => v.timeSlot).length} of {s.vehicles.length}
                </strong>
              </div>
              <div>
                {/* The sum of the individual quantities -- the same figure the
                    station reserves from its stock when this is confirmed. */}
                <span className="fm-fleet-total-label">Total fuel (all vehicles)</span>
                <strong>
                  {s.plan.totals.quantity} {s.plan.unit}
                </strong>
                {s.plan.stock.freeToSell != null && (
                  <small className="fm-fleet-total-note">
                    of {s.plan.stock.freeToSell} {s.plan.unit} the station has free
                  </small>
                )}
              </div>
              <div>
                <span className="fm-fleet-total-label">Total</span>
                <strong>{formatINR(s.plan.totals.amount)}</strong>
                {s.redeemPoints > 0 && s.rewardDiscount > 0 && (
                  <small className="fm-fleet-total-note">
                    − {formatINR(s.rewardDiscount)} reward points · pay{" "}
                    {formatINR(Math.round((s.plan.totals.amount - s.rewardDiscount) * 100) / 100)}
                  </small>
                )}
              </div>
              <div>
                <span className="fm-fleet-total-label">Payment</span>
                <strong>At the pump</strong>
              </div>
            </div>

            {/*
              One discount for the whole fleet. The server splits it across the
              vehicles it actually books, in proportion to their bills, so each
              van keeps its own share and its own cancellation
              (backend services/booking/fleetBooking.js).
            */}
            <RewardRedeemCard
              amount={s.plan.totals.amount}
              points={s.redeemPoints}
              onChange={(points, rupees) => {
                s.setField("redeemPoints", points);
                s.setField("rewardDiscount", rupees);
              }}
            />

            {s.confirmError && (
              <p className="fm-fleet-alert" role="alert">
                <i className="fas fa-triangle-exclamation" aria-hidden /> {s.confirmError}
              </p>
            )}

            <div className="fm-fleet-actions">
              <button type="button" className="fm-fleet-btn" onClick={() => s.setField("step", "build")}>
                Back
              </button>
              <button
                type="button"
                className="fm-fleet-btn fm-fleet-btn-primary"
                disabled={s.confirming || s.vehicles.every((v) => !v.timeSlot)}
                onClick={() => void s.confirm()}
              >
                <i className={`fas ${s.confirming ? "fa-spinner fa-spin" : "fa-circle-check"}`} aria-hidden />{" "}
                {s.confirming ? "Confirming…" : `Confirm ${s.vehicles.filter((v) => v.timeSlot).length} bookings`}
              </button>
            </div>
          </section>
        )}

        {/* ── what was booked ────────────────────────────────────────── */}
        {s.step === "confirmed" && s.confirmation && (
          <section className="fm-fleet-card" aria-label="Booking summary">
            <h2 className="fm-fleet-h">
              <i className="fas fa-circle-check" style={{ color: "var(--status-good)" }} aria-hidden /> Booked
            </h2>
            <p className="fm-fleet-summary">{s.confirmation.summary}</p>
            <p className="fm-fleet-hint">
              Reference <strong>{s.confirmation.group.reference}</strong> · each vehicle is its own booking and can be
              cancelled or tracked on its own.
            </p>

            {/*
              ONE code for the whole group. Shown once, large, because it is
              the thing the customer has to produce at the window -- five
              codes to read out in order was the thing to avoid.
            */}
            {s.confirmation.bookings[0]?.verificationCode && (
              <div className="fm-fleet-grouppin">
                <div>
                  <span className="fm-fleet-total-label">Your code for all vehicles</span>
                  <code aria-label={`Your code is ${s.confirmation.bookings[0].verificationCode.split("").join(" ")}`}>
                    {s.confirmation.bookings[0].verificationCode}
                  </code>
                </div>
                <p>
                  Check in at the pump in the app, then give this one number to the attendant — it checks in every
                  vehicle in this booking. The first is fuelled and the rest wait in the order below.
                </p>
              </div>
            )}

            <ul className="fm-fleet-schedule">
              {s.confirmation.bookings.map((b) => (
                <li key={b.bookingId} className="fm-fleet-slot">
                  <span className="fm-fleet-slot-n">{b.fleetIndex}</span>
                  <div className="fm-fleet-slot-main">
                    <strong>{b.vehiclePlate}</strong>
                    <small>
                      {b.orderId} · {b.quantity} {s.confirmation?.group.fuelType}
                    </small>
                  </div>
                  <div className="fm-fleet-slot-time">
                    <strong>{b.timeSlot}</strong>
                    <small>
                      {b.startTime}–{b.endTime}
                    </small>
                  </div>
                  {/* Its own amount. The code is the GROUP's, shown once above,
                      so it is not repeated on every row. */}
                  <span className="fm-fleet-row-amount">{formatINR(b.amount)}</span>
                  <span className="fm-fleet-chip fm-fleet-chip-good">
                    <i className="fas fa-circle-check" aria-hidden /> Confirmed
                  </span>
                </li>
              ))}
            </ul>

            {s.confirmation.failures.length > 0 && (
              <div className="fm-fleet-misses">
                <h3>Not booked</h3>
                {s.confirmation.failures.map((f) => (
                  <p key={f.vehiclePlate} className="fm-fleet-alert" role="alert">
                    <i className="fas fa-triangle-exclamation" aria-hidden /> {f.message}
                  </p>
                ))}
              </div>
            )}

            <div className="fm-fleet-actions">
              <button type="button" className="fm-fleet-btn" onClick={() => s.reset()}>
                Book another fleet
              </button>
              <button type="button" className="fm-fleet-btn fm-fleet-btn-primary" onClick={() => navigate("/confirmation")}>
                View my bookings
              </button>
            </div>
          </section>
        )}

        {/* ── earlier groups ─────────────────────────────────────────── */}
        {s.groups && s.groups.length > 0 && s.step !== "schedule" && (
          <section className="fm-fleet-card" aria-label="Your fleet bookings">
            <h2 className="fm-fleet-h">Your fleet bookings</h2>
            <ul className="fm-fleet-list">
              {s.groups.map((g) => (
                <li key={g.fleetId} className="fm-fleet-row">
                  <div className="fm-fleet-row-main">
                    <strong>{g.reference}</strong>
                    <small>
                      {g.station.name || "Station"} · {g.bookingDate} · {g.fuelType} · {g.counts.total} vehicle
                      {g.counts.total === 1 ? "" : "s"}
                    </small>
                  </div>
                  <span className={`fm-fleet-chip ${g.status === "active" ? "fm-fleet-chip-good" : "fm-fleet-chip-mute"}`}>
                    {g.status}
                  </span>
                  <span className="fm-fleet-row-amount">{formatINR(g.amount)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Layout>
  );
}

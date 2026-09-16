import type { UiStation, Vehicle } from "@/types";
import VehicleArt from "@/components/vehicle/VehicleArt";
import { useBookingDraftStore } from "@/store/bookingDraftStore";
import { SERVICE_FEE } from "@/constants/booking";
import { formatCurrency } from "@/utils/format";
import { resolveDraftVehicle } from "@/utils/vehicle";
import FuelQueuePreview from "./FuelQueuePreview";

interface Props {
  station: UiStation;
  vehicles: Vehicle[];
  /** The station's published price, or null when it has none. */
  unitPrice: number | null;
  /** The chosen slot is full: this submits a waitlist request, paid at the station. */
  waitlist?: boolean;
}

/** "2026-09-10" -> "Thu, 10 Sept 2026". Falls back to the raw string. */
function formatDay(date: string | null): string | null {
  if (!date) return null;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/**
 * Step 3 -- review and confirm.
 *
 * The summary leads with the vehicle, because it is the one detail the
 * attendant checks at the pump and the easiest one to get wrong; "Change"
 * goes straight back to step 0 with everything else kept.
 *
 * Payment is taken at the petrol pump only (online payment is switched off on
 * the server), so there is nothing to choose: the step says how and when to pay.
 */
export default function ConfirmPayStep({ station: s, vehicles, unitPrice, waitlist = false }: Props) {
  const draft = useBookingDraftStore((st) => st.draft);
  const setStep = useBookingDraftStore((st) => st.setStep);

  const vehicle = resolveDraftVehicle(draft, vehicles);
  const fuelCost = unitPrice === null ? null : draft.quantity * unitPrice;
  const total = fuelCost === null ? null : fuelCost + SERVICE_FEE;

  const fact = (label: string, value: string | null) => (
    <div className="cx-fact" key={label}>
      <dt>{label}</dt>
      <dd className={value ? "" : "is-empty"}>{value || "—"}</dd>
    </div>
  );

  return (
    <div className="space-y-4">
      <section className="cx-subpanel" style={{ background: "var(--card)", animation: "none" }}>
        <h4 className="cx-section-title mb-3">
          <i className="fas fa-receipt" style={{ color: "var(--primary)", fontSize: 13 }} aria-hidden /> Booking
          Summary
        </h4>

        <div className="cx-vehicle-card">
          <VehicleArt type={vehicle?.type} image={vehicle?.image} size={52} />
          <div className="min-w-0 flex-1">
            <p className="cx-eyebrow">Vehicle</p>
            <p className="cx-option-name">{vehicle ? vehicle.name : "N/A"}</p>
            {vehicle && (
              <div className="flex items-center gap-1.5 flex-wrap mt-1">
                <span className="cx-plate">{vehicle.plate}</span>
                <span className="cx-tag is-blue">{vehicle.type}</span>
                <span className={`cx-tag ${vehicle.saved ? "is-green" : "is-amber"}`}>
                  {vehicle.saved ? "Saved" : "This booking only"}
                </span>
              </div>
            )}
          </div>
          <button type="button" className="cx-link self-start" onClick={() => setStep(0)}>
            Change
          </button>
        </div>

        <hr className="cx-split" />
        <dl className="cx-facts">
          {fact("Station", s.name)}
          {fact("Fuel Type", draft.fuelType)}
          {fact("Date", formatDay(draft.date))}
          {fact("Time Slot", draft.timeSlot)}
          {fact("Quantity", `${draft.quantity} Litres`)}
          {fact("Fuel Cost", fuelCost === null ? "Price not published" : formatCurrency(fuelCost))}
          {fact("Convenience Fee", formatCurrency(SERVICE_FEE))}
        </dl>
        <hr className="cx-split" />
        <div className="cx-total">
          <span className="cx-total-label">Total</span>
          <span className="cx-total-value">{total === null ? "—" : formatCurrency(total)}</span>
        </div>
      </section>

      {waitlist ? (
        <div
          className="p-4 rounded-xl text-xs flex items-start gap-2"
          style={{ background: "var(--status-warn-bg)", border: "1px solid var(--status-warn)" }}
          role="status"
        >
          <i className="fas fa-hourglass-half mt-0.5" style={{ color: "var(--status-warn)" }} aria-hidden />
          <span style={{ color: "var(--text2)" }}>
            <b>{draft.timeSlot} is full, so this joins its waitlist.</b> If the booking ahead is cancelled or missed,
            the slot becomes yours automatically and you are notified with your PIN. Nothing is charged now: you pay
            at the petrol pump if you get the slot.
          </span>
        </div>
      ) : (
        <>
          <FuelQueuePreview
            stationId={s.id}
            fuelType={draft.fuelType}
            quantity={draft.quantity}
            date={draft.date}
            timeSlot={draft.timeSlot}
          />

          <h4 className="cx-section-title pt-2">
            <i className="fas fa-wallet" style={{ color: "var(--primary)", fontSize: 13 }} aria-hidden /> Payment
          </h4>

          <div className="cx-option is-selected flex items-center gap-4 text-left" role="note">
            <span className="cx-stat-icon cx-tone-blue">
              <i className="fas fa-gas-pump" aria-hidden />
            </span>
            <span className="flex-1 min-w-0">
              <span className="cx-option-name block">Pay at the petrol pump</span>
              <span className="cx-option-sub block">
                Nothing is charged now. Pay {total === null ? "the total" : formatCurrency(total)} to the attendant by
                cash or UPI when you arrive and show your PIN.
              </span>
            </span>
            <i className="fas fa-circle-check" style={{ color: "var(--primary)" }} aria-hidden />
          </div>
        </>
      )}
    </div>
  );
}

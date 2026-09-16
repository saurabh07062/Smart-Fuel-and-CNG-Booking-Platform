import { useBookingDraftStore } from "@/store/bookingDraftStore";
import { QUANTITY_MAX, QUANTITY_MIN, QUANTITY_PRESETS, SERVICE_FEE } from "@/constants/booking";
import { formatCurrency } from "@/utils/format";
import FuelQueuePreview from "./FuelQueuePreview";

interface Props {
  /** The station's published price, or null when it has none. */
  unitPrice: number | null;
  /** The station being booked, for its live fuel queue. */
  stationId?: string | null;
}

/**
 * Step 2 -- port of renderBooking()'s step 2 plus app.js's qty handlers.
 *
 * The total is derived from the draft on every render rather than written
 * into #total-amount by hand, which is what let the Vanilla version's
 * displayed total drift from the value it actually posted.
 */
export default function QuantityStep({ unitPrice, stationId = null }: Props) {
  const quantity = useBookingDraftStore((s) => s.draft.quantity);
  const fuelType = useBookingDraftStore((s) => s.draft.fuelType);
  const date = useBookingDraftStore((s) => s.draft.date);
  const timeSlot = useBookingDraftStore((s) => s.draft.timeSlot);
  const setQuantity = useBookingDraftStore((s) => s.setQuantity);
  const stepQuantity = useBookingDraftStore((s) => s.stepQuantity);

  const total = unitPrice === null ? null : quantity * unitPrice + SERVICE_FEE;

  return (
    <div className="space-y-6">
      <section>
        <div className="cx-section">
          <h3 className="cx-section-title">
            <span className="cx-section-num">1</span> How much fuel?
          </h3>
          <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
            {QUANTITY_MIN}–{QUANTITY_MAX} litres
          </span>
        </div>

        <div className="cx-subpanel flex items-center justify-center gap-4" style={{ animation: "none" }}>
          <button
            type="button"
            className="cx-icon-btn"
            style={{ width: 48, height: 48, borderRadius: 14, fontSize: 16 }}
            onClick={() => stepQuantity(-1)}
            disabled={quantity <= QUANTITY_MIN}
            aria-label="Decrease quantity"
          >
            <i className="fas fa-minus" aria-hidden />
          </button>
          <div className="text-center">
            <input
              type="number"
              className="input-field text-center"
              style={{ fontFamily: "var(--cx-heading)", fontSize: 32, fontWeight: 600, width: 120, height: 60 }}
              value={quantity}
              min={QUANTITY_MIN}
              max={QUANTITY_MAX}
              onChange={(e) => setQuantity(parseInt(e.target.value, 10))}
              aria-label="Quantity in litres"
            />
            <p className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>
              litres
            </p>
          </div>
          <button
            type="button"
            className="cx-icon-btn"
            style={{ width: 48, height: 48, borderRadius: 14, fontSize: 16 }}
            onClick={() => stepQuantity(1)}
            disabled={quantity >= QUANTITY_MAX}
            aria-label="Increase quantity"
          >
            <i className="fas fa-plus" aria-hidden />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2 mt-3">
          {QUANTITY_PRESETS.map((q) => (
            <button
              key={q}
              type="button"
              className={`cx-option ${quantity === q ? "is-selected" : ""}`}
              style={{ padding: "10px 4px" }}
              onClick={() => setQuantity(q)}
              aria-pressed={quantity === q}
            >
              <span className="cx-option-name block">{q} L</span>
            </button>
          ))}
        </div>
      </section>

      <section className="cx-subpanel" style={{ background: "var(--card)", animation: "none" }}>
        <h4 className="cx-section-title mb-3">
          <i className="fas fa-receipt" style={{ color: "var(--primary)", fontSize: 13 }} aria-hidden /> Cost
          estimate
        </h4>
        <dl className="cx-facts">
          <div className="cx-fact">
            <dt>Fuel Price</dt>
            <dd className={unitPrice === null ? "is-empty" : ""}>
              {unitPrice === null ? "Not published" : `INR ${unitPrice}/L`}
            </dd>
          </div>
          <div className="cx-fact">
            <dt>Quantity</dt>
            <dd>{quantity} Litres</dd>
          </div>
          <div className="cx-fact">
            <dt>Convenience Fee</dt>
            <dd>INR {SERVICE_FEE.toFixed(2)}</dd>
          </div>
        </dl>
        <hr className="cx-split" />
        <div className="cx-total">
          <span className="cx-total-label">Total Amount</span>
          <span className="cx-total-value">{total === null ? "—" : formatCurrency(total)}</span>
        </div>
      </section>

      {/* The service time and wait follow the quantity as it changes. */}
      <FuelQueuePreview stationId={stationId} fuelType={fuelType} quantity={quantity} date={date} timeSlot={timeSlot} />
    </div>
  );
}

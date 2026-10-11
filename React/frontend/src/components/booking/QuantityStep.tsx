import { useBookingDraftStore } from "@/store/bookingDraftStore";
import { AMOUNT_PRESETS, QUANTITY_MAX, QUANTITY_MIN, QUANTITY_PRESETS, SERVICE_FEE } from "@/constants/booking";
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
  const bookBy = useBookingDraftStore((s) => s.draft.bookBy);
  const fuelAmount = useBookingDraftStore((s) => s.draft.fuelAmount);
  const setQuantity = useBookingDraftStore((s) => s.setQuantity);
  const stepQuantity = useBookingDraftStore((s) => s.stepQuantity);
  const setBookBy = useBookingDraftStore((s) => s.setBookBy);
  const setFuelAmount = useBookingDraftStore((s) => s.setFuelAmount);

  const unit = String(fuelType || "").toLowerCase() === "cng" ? "kg" : "L";

  /**
   * What ₹X buys, for the screen only.
   *
   * The booking sends the AMOUNT and the server divides by the price it holds
   * at that moment (backend services/booking/fuelAmount.js). If the vendor
   * changes the price in between, the booking follows the new price and this
   * preview was simply what the customer was told at the time -- which is why
   * it is labelled as an estimate and never posted as a quantity.
   */
  const previewQuantity =
    bookBy === "amount" && unitPrice !== null && unitPrice > 0 && fuelAmount > 0
      ? Math.round((fuelAmount / unitPrice) * 100) / 100
      : null;

  const effectiveQuantity = bookBy === "amount" ? previewQuantity : quantity;
  const total =
    unitPrice === null || effectiveQuantity === null ? null : effectiveQuantity * unitPrice + SERVICE_FEE;

  return (
    <div className="space-y-6">
      <section>
        <div className="cx-section">
          <h3 className="cx-section-title">
            <span className="cx-section-num">1</span> How much fuel?
          </h3>
          <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
            {bookBy === "amount" ? "by amount" : `${QUANTITY_MIN}–${QUANTITY_MAX} ${unit}`}
          </span>
        </div>

        {/* Two ways of saying the same thing. The one the customer is not
            using keeps its own value, so switching back and forth loses
            nothing (store/bookingDraftStore.ts). */}
        <div className="cx-seg" role="group" aria-label="How to choose the amount of fuel">
          <button
            type="button"
            className={`cx-seg-btn ${bookBy === "quantity" ? "is-active" : ""}`}
            onClick={() => setBookBy("quantity")}
            aria-pressed={bookBy === "quantity"}
          >
            <i className="fas fa-gas-pump mr-1.5" aria-hidden /> By quantity ({unit})
          </button>
          <button
            type="button"
            className={`cx-seg-btn ${bookBy === "amount" ? "is-active" : ""}`}
            onClick={() => setBookBy("amount")}
            aria-pressed={bookBy === "amount"}
          >
            <i className="fas fa-indian-rupee-sign mr-1.5" aria-hidden /> By amount (₹)
          </button>
        </div>

        {bookBy === "quantity" ? (
          <>
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
                  aria-label={`Quantity in ${unit === "kg" ? "kilograms" : "litres"}`}
                />
                <p className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>
                  {unit === "kg" ? "kilograms" : "litres"}
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
                  <span className="cx-option-name block">
                    {q} {unit}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="cx-subpanel text-center" style={{ animation: "none" }}>
              <label htmlFor="fuel-amount" className="text-[11px] block mb-1" style={{ color: "var(--muted)" }}>
                Amount to spend on fuel
              </label>
              <div className="flex items-center justify-center gap-2">
                <span style={{ fontFamily: "var(--cx-heading)", fontSize: 30, fontWeight: 600 }}>₹</span>
                <input
                  id="fuel-amount"
                  type="number"
                  inputMode="decimal"
                  className="input-field text-center"
                  style={{ fontFamily: "var(--cx-heading)", fontSize: 32, fontWeight: 600, width: 160, height: 60 }}
                  value={fuelAmount || ""}
                  min={1}
                  placeholder="0"
                  onChange={(e) => setFuelAmount(Number(e.target.value))}
                  aria-label="Amount in rupees to spend on fuel"
                />
              </div>

              {/* What that buys, and whose figure it is. */}
              <p className="text-[12.5px] mt-3" style={{ color: "var(--text2)" }} data-testid="amount-preview">
                {unitPrice === null ? (
                  <span style={{ color: "var(--muted)" }}>
                    This station has not published a price, so an amount cannot be converted.
                  </span>
                ) : previewQuantity === null ? (
                  <span style={{ color: "var(--muted)" }}>Enter an amount to see how much fuel it buys.</span>
                ) : (
                  <>
                    About{" "}
                    <strong>
                      {previewQuantity} {unit}
                    </strong>{" "}
                    at ₹{unitPrice}/{unit}
                  </>
                )}
              </p>
              <p className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>
                The exact quantity is worked out at the station's price when you confirm.
              </p>
            </div>

            <div className="grid grid-cols-4 gap-2 mt-3">
              {AMOUNT_PRESETS.map((rupees) => (
                <button
                  key={rupees}
                  type="button"
                  className={`cx-option ${fuelAmount === rupees ? "is-selected" : ""}`}
                  style={{ padding: "10px 4px" }}
                  onClick={() => setFuelAmount(rupees)}
                  aria-pressed={fuelAmount === rupees}
                >
                  <span className="cx-option-name block">₹{rupees}</span>
                </button>
              ))}
            </div>
          </>
        )}
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
            <dd className={effectiveQuantity === null ? "is-empty" : ""}>
              {effectiveQuantity === null ? "Enter an amount" : `${effectiveQuantity} ${unit === "kg" ? "kg" : "Litres"}`}
            </dd>
          </div>
          {bookBy === "amount" && fuelAmount > 0 && (
            <div className="cx-fact">
              <dt>Fuel budget</dt>
              <dd>₹{fuelAmount}</dd>
            </div>
          )}
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
      {/* The wait follows the quantity actually being booked -- the preview
          one in amount mode, since that is what will be dispensed. */}
      <FuelQueuePreview
        stationId={stationId}
        fuelType={fuelType}
        quantity={effectiveQuantity ?? quantity}
        date={date}
        timeSlot={timeSlot}
      />
    </div>
  );
}

import { useEffect, useMemo } from "react";
import type { UiStation } from "@/types";
import { useBookingDraftStore } from "@/store/bookingDraftStore";
import { fetchAvailability } from "@/services/api/bookingApi";
import { TIME_SLOTS } from "@/constants/booking";
import { isSlotElapsed } from "@/utils/format";
import { istDateKey } from "@/utils/businessTime";
import type { SlotAvailability } from "@/types/booking";
import FuelQueuePreview from "./FuelQueuePreview";

interface Props {
  station: UiStation;
}

/** India date "YYYY-MM-DD" for an offset in days. */
const dateKey = (offsetDays: number): string => istDateKey(offsetDays);

const SLOT_TITLES: Record<string, string> = {
  PASSED: "Time slot passed",
  CLOSED: "Station closed at this time",
  RESERVED: "Nozzle reserved at this time",
};

/**
 * Step 1 -- port of renderBooking()'s step 1 plus refreshSlotAvailability().
 *
 * The Smart Queue Recommender is no longer decided here from the station list
 * (it compared current queues, whatever the chosen slot or quantity): it is
 * the server's call, shown on the review step (FasterStationNotice).
 *
 * Two behaviours preserved exactly:
 *  - a slot is disabled when its time has already passed (isSlotElapsed) or
 *    when the nozzle scheduler says the nozzle is reserved -- with the two
 *    cases keeping their distinct tooltips and the strikethrough on the
 *    elapsed one only.
 *
 * Once a slot is chosen, the live queue on the chosen fuel's nozzle and this
 * booking's estimated wait, start and completion (FuelQueuePreview), from the
 * server -- service times come from each vehicle's quantity.
 */
export default function DateSlotStep({ station: s }: Props) {
  const draft = useBookingDraftStore((st) => st.draft);
  const patch = useBookingDraftStore((st) => st.patch);
  const availability = useBookingDraftStore((st) => st.availability);
  const setAvailability = useBookingDraftStore((st) => st.setAvailability);

  const dateVal = draft.date || dateKey(0);

  // Fetch real nozzle availability whenever station / fuel / date changes.
  // A failure is deliberately silent: it must not block booking, because the
  // backend still rejects an actually-conflicting request at submit time.
  useEffect(() => {
    if (!s.id || !draft.fuelType) return;
    let cancelled = false;

    fetchAvailability(s.id, draft.fuelType, dateVal)
      .then((data) => {
        if (!cancelled) setAvailability(data);
      })
      .catch(() => {
        /* grid falls back to "everything clickable", as the Vanilla app did */
      });

    return () => {
      cancelled = true;
    };
  }, [s.id, draft.fuelType, dateVal, setAvailability]);

  /**
   * The server's rows for this station/fuel/date: every label with whether it
   * can be booked and why not. Until they arrive (or if the call fails), the
   * label list with only the passed-time check -- the server still refuses a
   * closed or reserved slot at submit.
   */
  const slotRows: SlotAvailability[] = useMemo(() => {
    const a = availability;
    const matches =
      a && String(a.stationId) === String(s.id) && a.fuelType === draft.fuelType && a.date === dateVal;
    if (matches && a.slots.length > 0) return a.slots;
    return TIME_SLOTS.map((label) => ({
      label,
      start: null,
      end: null,
      durationSeconds: null,
      available: true,
      bookable: true,
      reason: null,
    }));
  }, [availability, s.id, draft.fuelType, dateVal]);

  const selectedRow = slotRows.find((r) => r.label === draft.timeSlot);
  const selectedFull = !!selectedRow && selectedRow.reason === "RESERVED" && !isSlotElapsed(dateVal, selectedRow.label);
  const nextFree = selectedFull
    ? (slotRows.slice(slotRows.indexOf(selectedRow)).find((r) => (r.bookable ?? r.available) && !r.reason && !isSlotElapsed(dateVal, r.label))
        ?.label ?? null)
    : null;

  return (
    <div className="space-y-7">
      <section>
        <div className="cx-section">
          <h3 className="cx-section-title">
            <span className="cx-section-num">1</span> Select date
          </h3>
        </div>
        <div className="grid grid-cols-4 gap-2 sm:gap-3">
          {[0, 1, 2, 3].map((d) => {
            const ds = dateKey(d);
            // Midnight UTC of the India date, formatted in UTC, so the day and
            // weekday shown are the India date's whatever the browser zone.
            const date = new Date(`${ds}T00:00:00Z`);
            const selected = draft.date === ds;
            const dayLabel =
              d === 0
                ? "Today"
                : d === 1
                  ? "Tomorrow"
                  : date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
            return (
              <button
                key={ds}
                type="button"
                className={`cx-option ${selected ? "is-selected" : ""}`}
                style={{ padding: "12px 4px" }}
                onClick={() => patch({ date: ds })}
                aria-pressed={selected}
              >
                <span className="cx-option-sub block">{dayLabel}</span>
                <span
                  className="block"
                  style={{
                    fontFamily: "var(--cx-heading)",
                    fontSize: 22,
                    fontWeight: 600,
                    color: "var(--text)",
                    lineHeight: 1.25,
                  }}
                >
                  {date.getUTCDate()}
                </span>
                <span className="cx-option-sub block">
                  {date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="cx-section flex-wrap">
          <h3 className="cx-section-title">
            <span className="cx-section-num">2</span> Select time slot
          </h3>
          <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
            <i className="fas fa-gas-pump mr-1" aria-hidden />
            {draft.fuelType || "Each fuel"} has its own nozzle · fill time depends on quantity
          </span>
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-4 xl:grid-cols-5 gap-2">
          {slotRows.map((row) => {
            const t = row.label;
            // Re-checked locally too: the page may have been open past the slot.
            const reason = isSlotElapsed(dateVal, t)
              ? "PASSED"
              : (row.reason ?? ((row.bookable ?? row.available) ? null : "RESERVED"));
            // A reserved slot can still be chosen: the customer joins its
            // waitlist and gets it if the booking ahead is cancelled or missed.
            if (reason === "RESERVED") {
              const selected = draft.timeSlot === t;
              return (
                <button
                  key={t}
                  type="button"
                  className={`cx-slot ${selected ? "is-selected" : ""}`}
                  style={{ borderStyle: "dashed", opacity: selected ? 1 : 0.75 }}
                  title="Full: join the waitlist"
                  onClick={() => patch({ timeSlot: t })}
                  aria-pressed={selected}
                >
                  {t}
                </button>
              );
            }
            if (reason) {
              return (
                <button
                  key={t}
                  type="button"
                  className={`cx-slot ${reason === "PASSED" ? "is-past" : ""}`}
                  disabled
                  title={SLOT_TITLES[reason]}
                >
                  {t}
                </button>
              );
            }
            const selected = draft.timeSlot === t;
            return (
              <button
                key={t}
                type="button"
                className={`cx-slot ${selected ? "is-selected" : ""}`}
                onClick={() => patch({ timeSlot: t })}
                aria-pressed={selected}
              >
                {t}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-4 mt-3 text-[11px]" style={{ color: "var(--muted)" }}>
          <span className="inline-flex items-center gap-1.5">
            <span className="cx-swatch" /> Available
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="cx-swatch" style={{ background: "var(--primary)", borderColor: "var(--primary)" }} />{" "}
            Selected
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="cx-swatch" style={{ borderStyle: "dashed" }} /> Full (waitlist)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="cx-swatch" style={{ background: "var(--bg2)", opacity: 0.6 }} /> Closed or passed
          </span>
        </div>

        {selectedFull && (
          <div
            className="mt-3 p-3 rounded-xl text-xs flex items-start gap-2"
            style={{ background: "var(--status-warn-bg)", border: "1px solid var(--status-warn)" }}
            role="status"
          >
            <i className="fas fa-hourglass-half mt-0.5" style={{ color: "var(--status-warn)" }} aria-hidden />
            <span style={{ color: "var(--text2)" }}>
              <b>{draft.timeSlot} is full.</b> Continue to join its waitlist (pay at the station if you get it), or
              {nextFree ? (
                <>
                  {" "}
                  take the next free slot,{" "}
                  <button type="button" className="cx-link" onClick={() => patch({ timeSlot: nextFree })}>
                    {nextFree}
                  </button>
                  .
                </>
              ) : (
                " pick another date."
              )}
            </span>
          </div>
        )}

        {draft.fuelType && draft.timeSlot && !selectedFull && (
          <div className="mt-4">
            <FuelQueuePreview
              stationId={s.id}
              fuelType={draft.fuelType}
              quantity={draft.quantity}
              date={dateVal}
              timeSlot={draft.timeSlot}
            />
          </div>
        )}
      </section>
    </div>
  );
}

import { useBookingDraftStore } from "@/store/bookingDraftStore";

/**
 * "This slot is for someone else."
 *
 * A customer often books for a family member or a driver, and until now the
 * attendant met a person whose name did not match the booking. Naming them
 * here puts that name on the vendor's queue row, so the fill is handed to the
 * right person without a phone call.
 *
 * It changes nothing about who owns the booking: the signed-in customer still
 * cancels it and still pays at the pump. The name is asked for, the number is
 * optional, and the whole section stays closed for the usual case.
 */
export default function BookedForSection() {
  const name = useBookingDraftStore((s) => s.draft.bookedForName);
  const phone = useBookingDraftStore((s) => s.draft.bookedForPhone);
  const patch = useBookingDraftStore((s) => s.patch);

  const on = name !== null;
  const toggle = () =>
    patch(on ? { bookedForName: null, bookedForPhone: null } : { bookedForName: "", bookedForPhone: "" });

  return (
    <section data-testid="booked-for">
      <div className="cx-section">
        <h3 className="cx-section-title">
          <i className="fas fa-user-group" aria-hidden /> Who is coming to the pump?
        </h3>
      </div>

      <div className="cx-subpanel" style={{ animation: "none" }}>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={on}
            onChange={toggle}
            aria-label="Book this slot for someone else"
            style={{ width: 18, height: 18, marginTop: 2, accentColor: "var(--primary)" }}
          />
          <span>
            <span className="block text-sm font-semibold" style={{ color: "var(--text)" }}>
              I&apos;m booking this for someone else
            </span>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              The attendant will look for their name. The booking, the PIN and the payment stay with you.
            </span>
          </span>
        </label>

        {on && (
          <div className="grid gap-3 sm:grid-cols-2 mt-4">
            <div>
              <label className="block text-[11.5px] font-semibold mb-1" htmlFor="booked-for-name" style={{ color: "var(--muted)" }}>
                Their name
              </label>
              <input
                id="booked-for-name"
                className="input-field"
                value={name ?? ""}
                maxLength={60}
                placeholder="e.g. Manoj Yadav"
                onChange={(e) => patch({ bookedForName: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-semibold mb-1" htmlFor="booked-for-phone" style={{ color: "var(--muted)" }}>
                Their mobile <span style={{ fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                id="booked-for-phone"
                className="input-field"
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit number"
                value={phone ?? ""}
                onChange={(e) => patch({ bookedForPhone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

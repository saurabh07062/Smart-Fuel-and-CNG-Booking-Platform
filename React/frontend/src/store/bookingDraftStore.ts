import { create } from "zustand";
import type { AvailabilityResponse, BookingDraft } from "@/types";
import { QUANTITY_DEFAULT, QUANTITY_MAX, QUANTITY_MIN } from "@/constants/booking";

interface DraftState {
  step: number;
  draft: BookingDraft;
  /** Real per-slot nozzle availability for the current station/fuel/date. */
  availability: AvailabilityResponse | null;
  submitting: boolean;

  setStep: (step: number) => void;
  patch: (patch: Partial<BookingDraft>) => void;
  setQuantity: (q: number) => void;
  /** Nudge by +1/-1 relative to the CURRENT value, not a captured one. */
  stepQuantity: (delta: number) => void;
  /** Switch between choosing litres/kg and choosing an amount in rupees. */
  setBookBy: (mode: "quantity" | "amount") => void;
  setFuelAmount: (rupees: number) => void;
  /** Reward points to spend on this booking (0 = none). */
  setRedeemPoints: (points: number) => void;
  setAvailability: (a: AvailabilityResponse | null) => void;
  setSubmitting: (v: boolean) => void;
  reset: () => void;
}

const clamp = (q: number) =>
  Math.max(QUANTITY_MIN, Math.min(QUANTITY_MAX, Number.isFinite(q) ? q : QUANTITY_MIN));

const EMPTY: BookingDraft = {
  stationId: null,
  stationName: null,
  fuelType: null,
  vehicleId: null,
  vehiclePlate: null,
  vehicleType: null,
  vehicleName: null,
  date: null,
  timeSlot: null,
  quantity: QUANTITY_DEFAULT,
  bookBy: "quantity",
  fuelAmount: 0,
  payMethod: null,
  bookedForName: null,
  bookedForPhone: null,
  redeemPoints: 0,
};

/**
 * The booking wizard's working state -- Vanilla's `state.bookingData` plus
 * `state.bookingStep` and `state.slotAvailability`.
 *
 * A store rather than component state because the flow spans four steps and
 * the user can leave and come back (a vendor added mid-flow, the "switch
 * station" recommendation), and losing their selections on a remount would be
 * a behaviour change. Deliberately NOT persisted: the Vanilla draft lived in
 * memory and died with the tab, and persisting it would resurrect a stale
 * date/slot days later.
 */
export const useBookingDraftStore = create<DraftState>((set) => ({
  step: 0,
  draft: { ...EMPTY },
  availability: null,
  submitting: false,

  setStep: (step) => set({ step }),

  patch: (patch) =>
    set((s) => {
      const draft = { ...s.draft, ...patch };
      // Availability is scoped to one station+fuel+date. Any of those changing
      // makes the cached grid wrong, and showing a stale grid is what would
      // let someone pick a slot the nozzle is actually reserved for.
      const scopeChanged =
        ("stationId" in patch && patch.stationId !== s.draft.stationId) ||
        ("fuelType" in patch && patch.fuelType !== s.draft.fuelType) ||
        ("date" in patch && patch.date !== s.draft.date);
      return { draft, availability: scopeChanged ? null : s.availability };
    }),

  // Clamped to the same 1..60 the Vanilla input enforced, so typing "999" or
  // holding minus cannot produce a quantity the backend will reject.
  setQuantity: (q) => set((s) => ({ draft: { ...s.draft, quantity: clamp(q) } })),

  /**
   * Switching modes does not carry the figure across.
   *
   * 10 litres is not ₹10, and pre-filling one box from the other is how a
   * customer ends up ordering ten rupees of fuel. The amount starts empty and
   * the quantity keeps whatever it had, so going back to litres is where they
   * left off.
   */
  setBookBy: (bookBy) => set((s) => ({ draft: { ...s.draft, bookBy, fuelAmount: bookBy === "amount" ? s.draft.fuelAmount : 0 } })),

  // Not clamped against the quantity limits here: what ₹500 buys depends on
  // the station's price, and the server is the only thing that knows it
  // (it answers with the range in rupees when the amount is out of bounds).
  setFuelAmount: (rupees) =>
    set((s) => ({ draft: { ...s.draft, fuelAmount: Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) / 100 : 0 } })),

  /**
   * The +/- buttons must derive from the value in the STORE, not from one
   * captured during render.
   *
   * The Vanilla handlers read `state.bookingData.quantity` and mutated it
   * synchronously, so each click saw the previous click's result. A React
   * handler closing over `quantity` does not: several clicks landing before
   * the next render all compute from the same stale number, so 25 rapid
   * clicks on minus moved the value by one. Reading current state inside
   * `set` restores the Vanilla behaviour.
   */
  stepQuantity: (delta) =>
    set((s) => ({ draft: { ...s.draft, quantity: clamp(s.draft.quantity + delta) } })),

  /**
   * Whole points only, never negative.
   *
   * How many may actually be spent depends on the balance and on the bill, and
   * only the server knows both; this just keeps the draft from holding a figure
   * the API would reject outright.
   */
  setRedeemPoints: (points) =>
    set((s) => ({ draft: { ...s.draft, redeemPoints: Number.isFinite(points) && points > 0 ? Math.floor(points) : 0 } })),

  setAvailability: (availability) => set({ availability }),
  setSubmitting: (submitting) => set({ submitting }),

  reset: () => set({ step: 0, draft: { ...EMPTY }, availability: null, submitting: false }),
}));

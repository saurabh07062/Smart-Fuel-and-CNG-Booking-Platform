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
  payMethod: null,
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

  setAvailability: (availability) => set({ availability }),
  setSubmitting: (submitting) => set({ submitting }),

  reset: () => set({ step: 0, draft: { ...EMPTY }, availability: null, submitting: false }),
}));

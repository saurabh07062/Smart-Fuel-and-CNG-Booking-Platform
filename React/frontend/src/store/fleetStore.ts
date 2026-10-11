import { create } from "zustand";
import * as api from "@/services/api/fleetApi";
import type { FleetConfirmation, FleetGroup, FleetPlan, FleetVehicleInput } from "@/services/api/fleetApi";
import { toApiError } from "@/services/api/apiClient";
import { useAuthStore } from "./authStore";

/**
 * The fleet booking screen's state.
 *
 * TWO RULES THIS STORE KEEPS
 *
 * 1. The plan is the server's, not ours. Nothing here works out which slot is
 *    free, how long a fill takes, or what it costs -- every one of those comes
 *    back from /bookings/fleet/plan. Editing one vehicle's slot asks the
 *    server again for that vehicle alone, so the answer is always one the
 *    station could actually serve.
 *
 * 2. A partial confirmation is not a failure. When four vehicles are booked
 *    and one is not, the four are real: the store keeps the confirmation with
 *    its per-vehicle reasons rather than throwing the whole thing away.
 */

/** The step the screen is on. */
export type FleetStep = "build" | "schedule" | "confirmed";

interface FleetState {
  step: FleetStep;

  // ---- what the customer is asking for ----
  stationId: string | null;
  stationName: string | null;
  /**
   * The station came from the page the customer was already on (a station card,
   * the pump detail, "Yes, fleet booking"), so it is NOT theirs to pick again
   * here: the chooser is replaced by the station they chose.
   *
   * Set from the ?stationId in the address rather than from router state, so a
   * refresh or a shared link lands on the same station
   * (pages/customer/FleetBooking.tsx).
   */
  stationLocked: boolean;
  fuelType: string;
  bookingDate: string;
  preferredSlot: string | null;
  vehicles: FleetVehicleInput[];
  /**
   * Reward points to spend on the group, as ONE figure for the whole fleet.
   *
   * The server splits it across the vehicles that are actually booked, in
   * proportion to their bills (backend services/booking/fleetBooking.js), so
   * each van carries its own share and can be cancelled on its own.
   */
  redeemPoints: number;
  /** The rupee value the quote gave those points, for the summary line. */
  rewardDiscount: number;

  // ---- what the server said ----
  plan: FleetPlan | null;
  planning: boolean;
  planError: string | null;

  confirming: boolean;
  confirmError: string | null;
  confirmation: FleetConfirmation | null;

  // ---- the customer's existing groups ----
  groups: FleetGroup[] | null;
  groupsLoading: boolean;
  groupsError: string | null;
  openGroup: FleetGroup | null;

  setField: <K extends keyof FleetState>(key: K, value: FleetState[K]) => void;
  addVehicle: (vehicle: FleetVehicleInput) => void;
  removeVehicle: (plate: string) => void;
  setVehicleQuantity: (plate: string, quantity: number) => void;
  findSlots: () => Promise<void>;
  editSlot: (plate: string, timeSlot: string) => Promise<string | null>;
  confirm: (payMethod?: string) => Promise<FleetConfirmation | null>;
  loadGroups: () => Promise<void>;
  loadGroup: (fleetId: string) => Promise<void>;
  reset: () => void;
}

/** Today in India, as the API's date keys are written. */
export function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

/** A plate compared the way the server compares it. */
export const plateKey = (value: string) => String(value || "").toUpperCase().replace(/[\s-]/g, "").slice(0, 20);

const errorOf = (err: unknown, fallback: string) => toApiError(err).msg || fallback;

const initial = {
  step: "build" as FleetStep,
  stationId: null,
  stationName: null,
  stationLocked: false,
  fuelType: "Petrol",
  bookingDate: todayKey(),
  preferredSlot: null,
  vehicles: [] as FleetVehicleInput[],
  redeemPoints: 0,
  rewardDiscount: 0,
  plan: null,
  planning: false,
  planError: null,
  confirming: false,
  confirmError: null,
  confirmation: null,
  groups: null,
  groupsLoading: false,
  groupsError: null,
  openGroup: null,
};

export const useFleetStore = create<FleetState>((set, get) => ({
  ...initial,

  setField: (key, value) =>
    set((s) => {
      const next = { ...s, [key]: value } as FleetState;
      // Any change to the request invalidates a plan built from the old one.
      // Leaving it on screen would let a customer confirm a schedule for a
      // station or a day they have since changed.
      if (["stationId", "fuelType", "bookingDate", "preferredSlot"].includes(key as string)) {
        next.plan = null;
        next.planError = null;
        if (next.step === "schedule") next.step = "build";
      }
      return next;
    }),

  addVehicle: (vehicle) =>
    set((s) => {
      const key = plateKey(vehicle.vehiclePlate);
      // The same van twice is refused here as well as on the server, so the
      // customer is told immediately rather than after a round trip.
      if (!key || s.vehicles.some((v) => plateKey(v.vehiclePlate) === key)) return s;
      return { vehicles: [...s.vehicles, { ...vehicle, vehiclePlate: key }], plan: null, step: "build" };
    }),

  removeVehicle: (plate) =>
    set((s) => ({
      vehicles: s.vehicles.filter((v) => plateKey(v.vehiclePlate) !== plateKey(plate)),
      plan: null,
      step: "build",
    })),

  setVehicleQuantity: (plate, quantity) =>
    set((s) => ({
      vehicles: s.vehicles.map((v) => (plateKey(v.vehiclePlate) === plateKey(plate) ? { ...v, quantity } : v)),
      plan: null,
      step: "build",
    })),

  findSlots: async () => {
    const { stationId, fuelType, bookingDate, preferredSlot, vehicles } = get();
    if (!stationId || vehicles.length < 2) {
      set({ planError: "Pick a station and at least two vehicles." });
      return;
    }
    set({ planning: true, planError: null });
    try {
      const plan = await api.planFleet({ stationId, fuelType, bookingDate, preferredSlot, vehicles });
      set({
        plan,
        planning: false,
        step: "schedule",
        // The slots the server suggested become the ones that will be
        // confirmed, unless the customer edits them.
        vehicles: get().vehicles.map((v) => {
          const row = plan.vehicles.find((p) => plateKey(p.vehiclePlate) === plateKey(v.vehiclePlate));
          return row?.state === "suggested" ? { ...v, timeSlot: row.timeSlot ?? null } : { ...v, timeSlot: null };
        }),
      });
    } catch (err) {
      set({ planning: false, planError: errorOf(err, "Could not work out a schedule just now.") });
    }
  },

  editSlot: async (plate, timeSlot) => {
    const { stationId, fuelType, bookingDate, plan } = get();
    if (!stationId || !plan) return "No plan to change.";
    try {
      const updated = await api.planFleetVehicle({
        stationId,
        fuelType,
        bookingDate,
        vehicles: plan.vehicles,
        vehiclePlate: plate,
        timeSlot,
      });

      set((s) => ({
        plan: s.plan
          ? {
              ...s.plan,
              vehicles: s.plan.vehicles.map((v) =>
                plateKey(v.vehiclePlate) === plateKey(plate) ? { ...v, ...updated } : v,
              ),
            }
          : s.plan,
        // Only the edited vehicle's slot changes; the others keep theirs.
        vehicles: s.vehicles.map((v) =>
          plateKey(v.vehiclePlate) === plateKey(plate)
            ? { ...v, timeSlot: updated.state === "suggested" ? (updated.timeSlot ?? null) : null }
            : v,
        ),
      }));

      // "full" is an answer, not an error: the window the customer picked
      // cannot take this vehicle, and the row now says so.
      return updated.state === "suggested" ? null : updated.message || "That slot is full.";
    } catch (err) {
      return errorOf(err, "Could not move that vehicle.");
    }
  },

  confirm: async (payMethod = "station") => {
    const { stationId, fuelType, bookingDate, vehicles, plan } = get();
    if (!stationId || !plan) return null;

    // Only vehicles that actually have a slot are sent; a conflicted or
    // unplaceable one is left out rather than sent for the server to refuse.
    const bookable = vehicles.filter((v) => v.timeSlot);
    if (bookable.length === 0) {
      set({ confirmError: "None of these vehicles has a slot yet." });
      return null;
    }

    set({ confirming: true, confirmError: null });
    try {
      const confirmation = await api.confirmFleet({
        stationId,
        fuelType,
        bookingDate,
        payMethod,
        vehicles: bookable,
        // Only when points were chosen: the server ignores a 0 either way, and
        // leaving the key out keeps the request identical to what it was.
        ...(get().redeemPoints > 0 ? { redeemPoints: get().redeemPoints } : {}),
      });
      set({ confirming: false, confirmation, step: "confirmed" });
      void get().loadGroups();
      return confirmation;
    } catch (err) {
      set({ confirming: false, confirmError: errorOf(err, "Could not confirm these bookings.") });
      return null;
    }
  },

  loadGroups: async () => {
    if (!useAuthStore.getState().isAuthenticated) return;
    set({ groupsLoading: true, groupsError: null });
    try {
      set({ groups: await api.fetchFleetBookings(), groupsLoading: false });
    } catch (err) {
      set({ groupsLoading: false, groupsError: errorOf(err, "Could not load your fleet bookings.") });
    }
  },

  loadGroup: async (fleetId) => {
    try {
      set({ openGroup: await api.fetchFleetBooking(fleetId) });
    } catch (err) {
      set({ groupsError: errorOf(err, "Could not load that fleet booking.") });
    }
  },

  reset: () => set({ ...initial, bookingDate: todayKey(), groups: get().groups }),
}));

/** The vehicles that would actually be booked if Confirm were pressed now. */
export const selectBookable = (s: FleetState) => s.vehicles.filter((v) => v.timeSlot);

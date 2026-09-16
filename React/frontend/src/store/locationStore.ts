import { create } from "zustand";
import type { Coordinates, NearestPumpResult } from "@/types";
import { getLastKnownUserCoords, rememberUserCoords } from "@/utils/geo";

const RESULT_KEY = "fm_nearest_pump_result";

interface LocationState {
  /** The point the user picked or the device reported. null = nothing known. */
  coords: Coordinates | null;
  /** Which fuel the user chose on the dashboard, if any. */
  fuelType: string | null;
  /** True while the nearest-pump search is in flight. */
  searching: boolean;
  /** The last search's result, mirrored to localStorage. */
  result: NearestPumpResult | null;

  setCoords: (lat: number, lng: number) => void;
  setFuelType: (fuelType: string | null) => void;
  setSearching: (searching: boolean) => void;
  setResult: (result: NearestPumpResult | null) => void;
  /** Recover the last search after a reload, so the results page is not empty. */
  hydrateResult: () => NearestPumpResult | null;
}

/**
 * User location + the nearest-pump search.
 *
 * The persisted keys are the Vanilla app's own -- fm_user_lat / fm_user_lng
 * (via utils/geo) and fm_nearest_pump_result -- so a location set on :3000
 * carries over to the React app and back for the whole migration.
 *
 * Choosing a new point clears the fuel type, exactly as setDashboardMarker()
 * did: the previous "Petrol near the old point" answer is not an answer about
 * the new point, and leaving it selected implied it was.
 */
export const useLocationStore = create<LocationState>((set) => ({
  // Seeded from localStorage so a returning user's map opens where they left
  // it instead of at the hardcoded Pune centre.
  coords: getLastKnownUserCoords(),
  fuelType: null,
  searching: false,
  result: null,

  setCoords: (lat, lng) => {
    rememberUserCoords(lat, lng);
    set({ coords: { lat, lng }, fuelType: null });
  },

  setFuelType: (fuelType) => set({ fuelType }),
  setSearching: (searching) => set({ searching }),

  setResult: (result) => {
    try {
      if (result) localStorage.setItem(RESULT_KEY, JSON.stringify(result));
      else localStorage.removeItem(RESULT_KEY);
    } catch {
      /* private mode / quota -- the in-memory result still works */
    }
    set({ result });
  },

  hydrateResult: () => {
    try {
      const saved = localStorage.getItem(RESULT_KEY);
      if (!saved) return null;
      const parsed = JSON.parse(saved) as NearestPumpResult;
      if (!parsed || !Array.isArray(parsed.stations)) return null;
      set({ result: parsed });
      return parsed;
    } catch {
      return null;
    }
  },
}));

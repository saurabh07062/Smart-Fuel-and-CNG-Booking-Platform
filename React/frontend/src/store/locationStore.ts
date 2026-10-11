import { create } from "zustand";
import type { Coordinates, NearestPumpResult } from "@/types";
import { getLastKnownUserCoords, rememberUserCoords } from "@/utils/geo";

const RESULT_KEY = "fm_nearest_pump_result";

interface LocationState {
  /** The point the user picked or the device reported. null = nothing known. */
  coords: Coordinates | null;
  /**
   * True once the user set the location on this visit ("Use my location" or a
   * map click). The remembered point only positions the map; the fuel
   * question waits for a location the user actually confirmed.
   */
  located: boolean;
  /** "Use my location" was tried on this visit and gave no position. */
  gpsFailed: boolean;
  /** How the current point was set, for the label the dashboard shows. */
  source: "gps" | "map" | null;
  /**
   * True from a sign-in until the customer has answered the post-login
   * location ask (LocationPermissionModal). Answering it either way clears
   * the flag, so the ask comes once per session and never twice.
   */
  askLocation: boolean;
  /**
   * When this session signed in, in epoch ms.
   *
   * The post-login flow waits a moment before asking for location, and the
   * wait has to survive a remount (React 18 mounts twice in development, and
   * the customer may land on another page first). A timestamp does that; a
   * timer living in a component does not.
   */
  signedInAt: number | null;
  /** Which fuel the user chose on the dashboard, if any. */
  fuelType: string | null;
  /** True while the nearest-pump search is in flight. */
  searching: boolean;
  /** The last search's result, mirrored to localStorage. */
  result: NearestPumpResult | null;

  /** source "gps" = Use my location; "map" = a click or pin drag. */
  setCoords: (lat: number, lng: number, source?: "gps" | "map") => void;
  markGpsFailed: () => void;
  /** The post-login location ask has been answered (allowed, failed or skipped). */
  locationAsked: () => void;
  /** A new sign-in (or sign-out): location and fuel must be set again. */
  resetSession: () => void;
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
  located: false,
  gpsFailed: false,
  source: null,
  askLocation: false,
  signedInAt: null,
  fuelType: null,
  searching: false,
  result: null,

  setCoords: (lat, lng, source = "map") => {
    rememberUserCoords(lat, lng);
    // Both ways of answering "where are you" count. A point the customer
    // deliberately put on the map is an answer, not a guess -- it is how
    // someone searches pumps in another part of town, or in another city
    // when booking for somebody else. A REMEMBERED point still does not
    // count: that one is seeded into `coords` with `located` left false.
    set({ coords: { lat, lng }, located: true, source, fuelType: null });
  },

  markGpsFailed: () => set({ gpsFailed: true }),

  locationAsked: () => set({ askLocation: false }),

  resetSession: () => {
    try {
      localStorage.removeItem(RESULT_KEY);
    } catch {
      /* no storage */
    }
    // askLocation true: the modal asks this new customer for their location
    // as soon as their dashboard opens.
    set({
      located: false,
      gpsFailed: false,
      source: null,
      askLocation: true,
      signedInAt: Date.now(),
      fuelType: null,
      searching: false,
      result: null,
    });
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

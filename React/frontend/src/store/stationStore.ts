import { create } from "zustand";
import type { Station, UiStation } from "@/types";
import { isNewer } from "@/services/socket/socket";
import { fetchStations } from "@/services/api/stationApi";
import { getLastKnownUserCoords } from "@/utils/geo";
import { mapBackendStation } from "@/utils/station";

interface StationState {
  stations: UiStation[];
  selected: UiStation | null;
  loading: boolean;
  error: string | null;
  /** "all" | "petrol" | "diesel" | "cng" -- the Vanilla state.searchFilter, unchanged. */
  filter: "all" | "petrol" | "diesel" | "cng";
  /**
   * When the list on screen came from this device's last successful load
   * rather than from the server just now (ISO time). Pages show it as "last
   * updated ..." so nobody books against a price that may have moved.
   */
  stale: string | null;

  load: () => Promise<void>;
  setFilter: (filter: "all" | "petrol" | "diesel" | "cng") => void;
  /** Called once fresh data has replaced the saved copy. */
  clearStale: () => void;
  setStations: (stations: UiStation[]) => void;
  setSelected: (station: UiStation | null) => void;
  /**
   * Merge a partial socket payload into a station.
   *
   * Patched rather than replaced for two reasons: a targeted event (a price
   * change) carries only what changed, and blindly overwriting would blank
   * every field it says nothing about. The timestamp guard discards an event
   * older than what is already held -- a resync can race the events after it.
   */
  patchStation: (payload: Partial<Station> & { _id?: string; id?: string }) => void;
  /** Insert a station from a station:created event. Ignores one already held. */
  addStation: (payload: Station & Record<string, unknown>) => UiStation | null;
  removeStation: (id: string) => void;
}

const CACHE_KEY = "fm_stations_cache";
/** A day: older than that and the prices are not worth showing at all. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Keep the last list the server actually returned, so the app has something
 * true to show on a cold start with no network.
 *
 * Only what is already public on the stations page -- names, prices, hours,
 * coordinates. No bookings, no customer, nothing private; those need a live
 * session by design.
 */
function rememberStations(stations: UiStation[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), stations }));
  } catch {
    /* storage blocked or full: the app simply has no offline copy */
  }
}

function cachedStations(): { at: string; stations: UiStation[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: string; stations?: UiStation[] };
    if (!parsed?.at || !Array.isArray(parsed.stations)) return null;
    if (Date.now() - new Date(parsed.at).getTime() > CACHE_TTL_MS) return null;
    return { at: parsed.at, stations: parsed.stations };
  } catch {
    return null;
  }
}

export const useStationStore = create<StationState>((set, get) => ({
  stations: [],
  stale: null,
  selected: null,
  loading: false,
  error: null,
  filter: "all",

  /**
   * GET /api/stations, with the user's last known coordinates when there are
   * any -- that is what makes the backend compute a real distance and sort by
   * it. Without them the list is still correct, just unsorted with no distance
   * shown, exactly as the Vanilla app behaved before a location was set.
   */
  load: async () => {
    set({ loading: true, error: null });
    try {
      const stations = await fetchStations(getLastKnownUserCoords());
      set({ stations, loading: false, stale: null });
      rememberStations(stations);
    } catch {
      // Keep whatever is already on screen; only surface the failure. On a
      // cold start with no network there is nothing on screen, so the list
      // saved from the last successful load stands in -- real data this
      // device really received, marked stale, never invented.
      const cached = get().stations.length === 0 ? cachedStations() : null;
      set({
        ...(cached && cached.stations.length > 0 ? { stations: cached.stations, stale: cached.at } : {}),
        loading: false,
        error: "Could not load stations.",
      });
    }
  },

  setFilter: (filter) => set({ filter }),
  clearStale: () => set({ stale: null }),
  setStations: (stations) => set({ stations }),
  setSelected: (selected) => set({ selected }),

  patchStation: (payload) =>
    set((s) => {
      const id = String(payload._id ?? payload.id ?? "");
      if (!id) return s;

      const idx = s.stations.findIndex((x) => String(x._id) === id);
      if (idx === -1) return s;

      const prev = s.stations[idx];
      if (!isNewer(payload as Record<string, unknown>, prev as unknown as Record<string, unknown>)) {
        return s;
      }

      // Drop keys the payload did not carry.
      const patch = Object.fromEntries(
        Object.entries(payload).filter(([, v]) => v !== undefined && v !== null),
      ) as Partial<Station>;

      // Re-derive through mapBackendStation rather than spreading the patch
      // straight in. A price event carries `prices: { petrol: … }` in the
      // server's own casing, and the cards read `uiPrices.Petrol` -- merging
      // without re-mapping would update the raw field and leave the rendered
      // price stale, which is the exact failure the real-time phase exists to
      // prevent.
      const merged = { ...prev, ...patch } as Station & Record<string, unknown>;
      const next = s.stations.slice();
      // mapBackendStation only returns null for a station with no _id, which
      // cannot happen here -- `prev` came from the same mapper.
      next[idx] = mapBackendStation(merged) ?? prev;

      return {
        stations: next,
        selected:
          s.selected && String(s.selected._id) === id ? next[idx] : s.selected,
      };
    }),

  addStation: (payload) => {
    const mapped = mapBackendStation(payload);
    if (!mapped) return null;
    let inserted = false;
    set((s) => {
      if (s.stations.some((x) => String(x.id) === String(mapped.id))) return s;
      inserted = true;
      return { stations: [...s.stations, mapped] };
    });
    return inserted ? mapped : null;
  },

  removeStation: (id) =>
    set((s) => ({
      stations: s.stations.filter((x) => String(x._id) !== String(id)),
      selected: s.selected && String(s.selected._id) === String(id) ? null : s.selected,
    })),
}));

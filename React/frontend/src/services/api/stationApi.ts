import { apiClient } from "./apiClient";
import type { NearbyStation, Station, UiStation } from "@/types";
import { mapBackendStation } from "@/utils/station";

/**
 * Station endpoints. Same routes, same query parameters, same responses as
 * the Vanilla app used -- see backend/routes/stationRoutes.js.
 *
 * Mapping happens HERE rather than in each page, so every screen sees the
 * same normalised station and nobody re-implements the price/coordinate
 * fallbacks by hand.
 */

/** GET /api/stations -- the enriched, distance-sorted list the browse page shows. */
export async function fetchStations(coords?: { lat: number; lng: number } | null): Promise<UiStation[]> {
  const params: Record<string, string | number> = {};
  // Passing coordinates is what makes the backend compute a real distance and
  // sort by it (stationController.getAllStations). Omitting them is valid and
  // simply returns unsorted stations with distance: null.
  if (coords) {
    params.lat = coords.lat;
    params.lng = coords.lng;
  }
  const { data } = await apiClient.get<Station[]>("/stations", { params });
  return (Array.isArray(data) ? data : [])
    .map((s) => mapBackendStation(s as Station & Record<string, unknown>))
    .filter((s): s is UiStation => s !== null);
}

/** GET /api/stations/:id */
export async function fetchStationById(id: string): Promise<UiStation | null> {
  const { data } = await apiClient.get<Station>(`/stations/${id}`);
  return mapBackendStation(data as Station & Record<string, unknown>);
}

/**
 * GET /stations/:id/route -- driving distance along the roads from `from`
 * to the station, as Google Maps measures a route (distanceType "road"),
 * or the straight line when no route is available ("straight").
 */
export async function fetchRouteDistance(
  stationId: string,
  from: { lat: number; lng: number },
): Promise<{ distanceKm: number; distanceType: "road" | "straight" | "fixed"; straightLineKm: number }> {
  const { data } = await apiClient.get(`/stations/${stationId}/route`, { params: { lat: String(from.lat), lng: String(from.lng) } });
  return data;
}

export interface NearbyResponse {
  success: boolean;
  stations: NearbyStation[];
  /** Radius (km) the results come from; widens 5 -> 50 km when nothing is closer. */
  radiusKm?: number;
  expandedSearch?: boolean;
  totalInRadius?: number;
  msg?: string;
  message?: string;
}

/**
 * GET /api/stations/nearby -- the KNN / smart-recommender result.
 *
 * The ranking, distance calculation and wait prediction all stay on the
 * server (services/station/discovery.js, stationFinder.js, stationQueue.js). This
 * client only forwards the search and renders what comes back; fuelType is
 * upper-cased because the endpoint's ALLOWED_FUELS guard compares upper-case.
 */
export async function fetchNearbyStations(
  latitude: number,
  longitude: number,
  fuelType: string,
  radius?: number,
): Promise<NearbyResponse> {
  const { data } = await apiClient.get<NearbyResponse>("/stations/nearby", {
    params: {
      latitude,
      longitude,
      fuelType: String(fuelType).toUpperCase(),
      ...(radius ? { radius } : {}),
    },
  });
  return data;
}

/**
 * GET /api/v1/discovery/place -- what to call a point.
 *
 * The name comes from OpenStreetMap through the backend, which caches it and
 * keeps inside the service's rate limit (backend services/station/reverseGeocode.js).
 * It answers 200 with `name: null` when the point cannot be named, and this
 * returns null on any failure too: a missing place name must never stop the
 * page that only wanted a label.
 */
export async function fetchPlaceName(lat: number, lng: number): Promise<string | null> {
  try {
    const { data } = await apiClient.get<{ name: string | null }>("/v1/discovery/place", {
      params: { lat, lng },
    });
    return data?.name ?? null;
  } catch {
    return null;
  }
}

/** One place the customer can pick when the device will not give a fix. */
export interface PlaceMatch {
  name: string | null;
  label: string;
  lat: number;
  lng: number;
  type: string | null;
}

/**
 * GET /api/v1/discovery/search-place?q= -- type a place, get coordinates.
 *
 * The lookup runs on the server (backend services/station/placeSearch.js), so
 * there is no third-party key in this bundle and the external service sees one
 * client rather than every phone. It answers 200 with an empty list both for
 * "nothing matched" and for a failed lookup, because the customer does the
 * same thing in either case -- different words, or the map.
 */
export async function searchPlaces(query: string): Promise<PlaceMatch[]> {
  const { data } = await apiClient.get<{ results?: PlaceMatch[] }>("/v1/discovery/search-place", {
    params: { q: query },
  });
  return Array.isArray(data.results) ? data.results : [];
}

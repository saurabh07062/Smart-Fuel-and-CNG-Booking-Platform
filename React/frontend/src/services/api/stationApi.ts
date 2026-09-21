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

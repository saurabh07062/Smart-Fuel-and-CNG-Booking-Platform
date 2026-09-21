import type { Booking, Coordinates, Station, UiStation } from "@/types";
import { geoJsonToLatLng, isValidCoordinate } from "./geo";
import { uploadUrl } from "@/services/api/apiClient";

/**
 * Port of mapBackendStation() in frontend/js/app.js.
 *
 * Prices are never invented: a fuel the station has not priced is null, and
 * the cards show "—" (the server refuses to book it anyway). The queue values
 * come from the server's live queue model (backend services/queue/stationQueue.js).
 * No rating, review count, amenity or fuel list is invented either: a station
 * shows what it actually has (ratings are hidden for now).
 *
 * The coordinate rule is the important one and is preserved as-is: prefer the
 * legacy {lat,lng} field ONLY if it is actually valid, otherwise fall through
 * to GeoJSON `location`, and if neither is usable return null rather than a
 * hardcoded Pune point. Defaulting used to make stations render a route to a
 * place nobody selected.
 */
export function mapBackendStation(s: (Station & Record<string, unknown>) | null | undefined): UiStation | null {
  if (!s || !s._id) return null;

  const raw = s as Record<string, unknown>;
  const queueVal = Number(raw.queueLength ?? raw.queue ?? 0);
  const waitVal = Number(raw.waitMinutes ?? raw.waitTime ?? 0);

  const legacy = s.coordinates as Coordinates | undefined;
  const legacyValid = !!legacy && isValidCoordinate(legacy.lat, legacy.lng);
  const geo = geoJsonToLatLng(s.location?.coordinates);
  const coords = legacyValid ? (legacy as Coordinates) : geo;

  const prices = (raw.prices ?? {}) as Record<string, number | null | undefined>;
  const published = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? v : null);
  const images = s.images ?? [];

  return {
    ...(s as Station),
    id: String(s._id),
    name: s.name,
    address: s.address,
    uiPrices: {
      Petrol: published(prices.Petrol ?? prices.petrol),
      Diesel: published(prices.Diesel ?? prices.diesel),
      CNG: published(prices.CNG ?? prices.cng),
    },
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    coordinates: coords,
    hours: (raw.openingHours as string) || (raw.hours as string) || "24 Hours",
    open: s.status !== "Inactive" && raw.open !== false,
    // The station's own photo; without one, the pump photo its owner uploaded
    // (petrol, else CNG), so every station with any photo shows it.
    image:
      (images.length > 0 ? images[0] : null) ??
      uploadUrl(s.pumpImages?.petrol ?? null) ??
      uploadUrl(s.pumpImages?.cng ?? null),
    queue: queueVal,
    queueLength: queueVal,
    waitTime: waitVal,
    waitMinutes: waitVal,
    // Same thresholds as the server (services/algorithms/queue.js toQueueStatus).
    queueStatus: s.queueStatus || (waitVal > 15 ? "High" : waitVal > 5 ? "Moderate" : "Low"),
    distance: raw.distance != null ? parseFloat(Number(raw.distance).toFixed(2)) : null,
    // Ratings are not shown for now; nothing is invented for them either.
    rating: undefined,
    reviews: Array.isArray(raw.reviews) ? raw.reviews.length : 0,
    // Only what the station actually lists.
    amenities: s.amenities ?? [],
    fuelTypes: s.fuelTypes ?? [],
  };
}

export interface ResolvedBookingStation {
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  hasValidCoords: boolean;
  coordinates: Coordinates | null;
  stationId: string | null;
}

/**
 * Port of resolveBookingStation() in frontend/js/utils.js.
 *
 * Never guesses: when the booking's own station cannot be resolved to a real
 * coordinate, lat/lng come back null with hasValidCoords false. It does NOT
 * fall back to stations[0] or a hardcoded place -- both of those made the
 * destination silently wrong instead of visibly unknown. Callers must check
 * hasValidCoords before drawing a route.
 */
export function resolveBookingStation(
  b: Booking | null | undefined,
  stations: UiStation[] = [],
): ResolvedBookingStation {
  let s: (Station & Record<string, unknown>) | UiStation | null = null;

  if (b && typeof b.station === "object" && b.station !== null) {
    const populated = b.station as unknown as Station & Record<string, unknown>;
    s = mapBackendStation(populated) ?? populated;
  } else {
    const sId = (b?.station as string | undefined) ?? undefined;
    if (sId) {
      s = stations.find((x) => String(x.id) === String(sId) || String(x._id) === String(sId)) ?? null;
    }
  }

  const src = (s ?? {}) as Record<string, unknown>;
  const legacy = src.coordinates as Coordinates | undefined;

  let lat: number | null = legacy?.lat ?? (src.lat as number | undefined) ?? null;
  let lng: number | null = legacy?.lng ?? (src.lng as number | undefined) ?? null;

  if (!isValidCoordinate(lat, lng)) {
    const fromGeo = geoJsonToLatLng((src.location as { coordinates?: unknown } | undefined)?.coordinates);
    if (fromGeo) {
      lat = fromGeo.lat;
      lng = fromGeo.lng;
    }
  }

  const hasValidCoords = isValidCoordinate(lat, lng);
  if (!hasValidCoords) {
    lat = null;
    lng = null;
  }

  const bWithName = b as unknown as { stationName?: string } | null | undefined;
  const address = (src.address as string) || bWithName?.stationName || "Station Address";
  const name = (src.name as string) || bWithName?.stationName || "Fuel Station";

  return {
    name,
    address,
    lat,
    lng,
    hasValidCoords,
    coordinates: hasValidCoords ? { lat: lat as number, lng: lng as number } : null,
    stationId: (src._id as string) ?? (src.id as string) ?? null,
  };
}

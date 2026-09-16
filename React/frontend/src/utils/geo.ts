import type { Coordinates } from "@/types";

/**
 * Coordinate helpers, ported verbatim from frontend/js/utils.js.
 *
 * The persisted localStorage keys (fm_user_lat / fm_user_lng) are kept
 * BYTE-IDENTICAL to the Vanilla app's: a user who set their location on
 * :3000 keeps it on the React app, and vice versa, for the whole migration.
 */

/** (0,0) is rejected as well: nothing here is legitimately in the Gulf of Guinea. */
export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  return (
    Number.isFinite(lat as number) &&
    Number.isFinite(lng as number) &&
    Math.abs(lat as number) <= 90 &&
    Math.abs(lng as number) <= 180 &&
    !((lat as number) === 0 && (lng as number) === 0)
  );
}

/**
 * The ONE place in the frontend that knows GeoJSON's [lng, lat] order.
 * Every reader of a Station's location.coordinates goes through this rather
 * than inlining [coords[1], coords[0]] -- two copies of that conversion is
 * exactly how a later edit swaps lat/lng in only one of them.
 */
export function geoJsonToLatLng(coordsArray?: unknown): Coordinates | null {
  if (!Array.isArray(coordsArray) || coordsArray.length !== 2) return null;
  const lng = Number(coordsArray[0]);
  const lat = Number(coordsArray[1]);
  return isValidCoordinate(lat, lng) ? { lat, lng } : null;
}

/**
 * Great-circle distance in km. Same formula and same 6371km radius the
 * confirmation page used inline, and the same one backend/src/services/algorithms/geo.js
 * uses -- so a distance shown next to a server-computed one agrees with it.
 */
export function haversineKm(a: Coordinates, b: Coordinates): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export interface FixedCoords extends Coordinates {
  accuracy?: number;
  timestamp?: number;
}

const LAT_KEY = "fm_user_lat";
const LNG_KEY = "fm_user_lng";

export function rememberUserCoords(lat: number, lng: number) {
  try {
    localStorage.setItem(LAT_KEY, String(lat));
    localStorage.setItem(LNG_KEY, String(lng));
  } catch {
    /* private mode / quota -- a lost preference, not an error worth surfacing */
  }
}

/**
 * The user's ACTUAL current position, always freshly requested from the
 * device (maximumAge: 0 -- never a browser-cached fix, let alone a hardcoded
 * default). Resolves null on denial/failure so the caller can show a real
 * error state instead of silently routing from a made-up point.
 */
export function getFreshUserCoords({ timeout = 10000 } = {}): Promise<FixedCoords | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (!isValidCoordinate(lat, lng)) {
          resolve(null);
          return;
        }
        rememberUserCoords(lat, lng);
        resolve({ lat, lng, accuracy: pos.coords.accuracy, timestamp: pos.timestamp });
      },
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 0, timeout },
    );
  });
}

/**
 * Best-effort LAST-KNOWN coordinates from what getFreshUserCoords persisted.
 * Returns null -- never a hardcoded place -- when nothing real is known yet.
 */
export function getLastKnownUserCoords(): Coordinates | null {
  try {
    const lat = parseFloat(localStorage.getItem(LAT_KEY) ?? "");
    const lng = parseFloat(localStorage.getItem(LNG_KEY) ?? "");
    if (isValidCoordinate(lat, lng)) return { lat, lng };
  } catch {
    /* ignore */
  }
  return null;
}

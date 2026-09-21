/**
 * Typed station coordinates: validation shared by the Add Station and Edit
 * Station forms, and reading the "lat, lng" pair Google Maps copies.
 */

/**
 * Why a typed coordinate is not usable, or null. Empty is not an error while
 * typing (saving says what is missing); a partial "-" or "+" is let through.
 */
export function coordinateError(value: string, label: string, limit: number): string | null {
  if (value === "" || value === "-" || value === "+") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${label} must be a number.`;
  if (n < -limit || n > limit) return `${label} must be between -${limit} and ${limit}.`;
  return null;
}

/** Straight-line distance in metres between two points (haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "1.3 km" / "240 m". */
export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** A move this large is confirmed before saving: it is usually a wrong paste, not a correction. */
export const LARGE_MOVE_METERS = 200;
/** Closer than this to the device's own position: probably "your location", not the pump. */
export const NEAR_DEVICE_METERS = 150;

/**
 * "18.580563, 73.975342" (what a right-click in Google Maps copies) ->
 * { lat, lng } as typed, or null when the text is not such a pair. Taking
 * both numbers from one paste stops latitude and longitude coming from two
 * different places.
 */
export function parseCoordinatePair(text: string): { lat: string; lng: string } | null {
  const m = /^\s*\(?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: m[1], lng: m[2] };
}

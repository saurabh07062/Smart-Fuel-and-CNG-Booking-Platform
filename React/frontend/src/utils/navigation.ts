import { isValidCoordinate } from "./geo";

/**
 * The ONE Google Maps navigation link for a station, used by every
 * "Directions" / "Open in Google Maps" button (station page, dashboard,
 * booking pass, nearest-pump cards).
 *
 * The destination is the station's saved coordinates exactly as stored -- the
 * only thing that decides where the customer is taken -- and there is no
 * origin, so Google starts from the device's own live location. Returns null
 * when the station has no usable position: a button must then be hidden or
 * disabled, never open a route to "null,null" or (0, 0).
 */
export function directionsUrl(lat: unknown, lng: unknown): string | null {
  const la = typeof lat === "string" ? Number(lat) : lat;
  const ln = typeof lng === "string" ? Number(lng) : lng;
  if (!isValidCoordinate(la, ln)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${la},${ln}&travelmode=driving`;
}

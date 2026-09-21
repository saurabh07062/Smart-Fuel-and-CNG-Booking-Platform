import type { Coordinates } from "@/types";
import { isNativeApp } from "./nativeApp";

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
export function getFreshUserCoords({ timeout = 12000, goodEnoughMeters = GPS_GOOD_ENOUGH_M } = {}): Promise<FixedCoords | null> {
  // In the customer Android app the phone's own GPS is used (the WebView's
  // browser location is refused on a plain http:// site).
  if (isNativeApp()) return nativeFreshCoords({ timeout, goodEnoughMeters });
  return browserFreshCoords({ timeout, goodEnoughMeters });
}

/**
 * The same "keep the most accurate reading" rule, through the native GPS
 * (@capacitor/geolocation), asking for the location permission if needed.
 */
async function nativeFreshCoords({ timeout, goodEnoughMeters }: { timeout: number; goodEnoughMeters: number }): Promise<FixedCoords | null> {
  const { Geolocation } = await import("@capacitor/geolocation");
  try {
    const current = await Geolocation.checkPermissions();
    if (current.location !== "granted") {
      const asked = await Geolocation.requestPermissions({ permissions: ["location"] });
      if (asked.location !== "granted") return null;
    }
  } catch {
    return null; // location switched off on the phone
  }
  return new Promise((resolve) => {
    let best: FixedCoords | null = null;
    let done = false;
    let watchId: string | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      if (watchId) void Geolocation.clearWatch({ id: watchId });
      if (best) rememberUserCoords(best.lat, best.lng);
      resolve(best);
    };
    const timer = window.setTimeout(finish, timeout);
    void Geolocation.watchPosition({ enableHighAccuracy: true, maximumAge: 0, timeout }, (pos, err) => {
      if (err || !pos) return finish();
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      if (!isValidCoordinate(lat, lng)) return;
      if (!best || accuracy < (best.accuracy ?? Infinity)) best = { lat, lng, accuracy, timestamp: pos.timestamp };
      if (accuracy <= goodEnoughMeters) finish();
    })
      .then((id) => {
        watchId = id;
        if (done) void Geolocation.clearWatch({ id });
      })
      .catch(() => finish());
  });
}

function browserFreshCoords({ timeout, goodEnoughMeters }: { timeout: number; goodEnoughMeters: number }): Promise<FixedCoords | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    // The first reading is often a coarse Wi-Fi / network estimate that
    // arrives before the GPS has a lock. Keep listening (high accuracy = GPS
    // when the device has it) and use the most accurate reading, stopping as
    // soon as one is within `goodEnoughMeters` or the time is up.
    let best: FixedCoords | null = null;
    let done = false;
    let watchId: number | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      window.clearTimeout(timer);
      if (best) rememberUserCoords(best.lat, best.lng);
      resolve(best);
    };
    const timer = window.setTimeout(finish, timeout);
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        if (!isValidCoordinate(lat, lng)) return;
        const accuracy = pos.coords.accuracy;
        if (!best || accuracy < (best.accuracy ?? Infinity)) best = { lat, lng, accuracy, timestamp: pos.timestamp };
        if (accuracy <= goodEnoughMeters) finish();
      },
      // Denied or unavailable: stop now (with whatever reading there is).
      () => finish(),
      { enableHighAccuracy: true, maximumAge: 0, timeout },
    );
  });
}

/** A fix this close (metres) is GPS quality: stop listening. */
export const GPS_GOOD_ENOUGH_M = 30;
/** Beyond this (metres) the fix is too rough to trust without checking the pin. */
export const GPS_POOR_ACCURACY_M = 200;

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

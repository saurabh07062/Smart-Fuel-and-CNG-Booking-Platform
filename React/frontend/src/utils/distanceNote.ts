/**
 * What a distance shown on a card means. The server sends the driving
 * distance along the roads when it could route (distanceType "road") -- the
 * way Google Maps measures a route -- and otherwise a straight line, which is
 * shorter than the real drive.
 *
 * The router's drive time is not shown: it assumes empty roads, and without
 * live traffic it would promise the customer less time than the trip takes.
 */
export interface DistanceInfo {
  distanceType?: "road" | "straight" | "fixed" | string | null;
}

export function distanceNote(s: DistanceInfo | null | undefined): string | null {
  // A distance measured on Google Maps and saved for the demo (backend data/fixedDistances.json).
  if (s?.distanceType === "fixed") return "by road (Google Maps)";
  if (s?.distanceType === "road") return "by road";
  if (s?.distanceType === "straight") return "straight line";
  return null;
}

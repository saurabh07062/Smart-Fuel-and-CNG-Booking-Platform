import { describe, it, expect } from "vitest";
import { mapBackendStation, resolveBookingStation } from "./station";
import { directionsUrl } from "./navigation";
import type { Booking, Station } from "@/types";

/**
 * Backend payloads (shapes taken from the real API responses) -> what the
 * customer pages read -> the Directions link. The saved coordinates must pass
 * through unchanged, never replaced by a default or guessed point.
 */
const PUMP = { lat: 18.5805621, lng: 73.9753407 };
const LINK = "https://www.google.com/maps/dir/?api=1&destination=18.5805621,73.9753407&travelmode=driving";

const apiStation = (over: Record<string, unknown> = {}) =>
  ({
    _id: "6aabb9028830bdc4c60f978b",
    name: "IndianOil",
    address: "Ground Floor, Haveli, SH-60, Wagholi",
    status: "Active",
    fuelTypes: ["Petrol", "Diesel"],
    prices: { petrol: 104, diesel: 91 },
    coordinates: PUMP,
    location: { type: "Point", coordinates: [PUMP.lng, PUMP.lat] },
    ...over,
  }) as unknown as Station & Record<string, unknown>;

describe("customer navigation uses the station's saved coordinates", () => {
  it("station page, list and dashboard map: /api/stations -> lat/lng -> Directions", () => {
    const s = mapBackendStation(apiStation())!;
    expect(s.lat).toBe(PUMP.lat);
    expect(s.lng).toBe(PUMP.lng);
    expect(directionsUrl(s.lat, s.lng)).toBe(LINK);
  });

  it("a station stored with only its GeoJSON location still navigates to it", () => {
    const s = mapBackendStation(apiStation({ coordinates: undefined }))!;
    expect(directionsUrl(s.lat, s.lng)).toBe(LINK);
  });

  it("an invalid legacy pair falls back to the GeoJSON location, never to a default city point", () => {
    const s = mapBackendStation(apiStation({ coordinates: { lat: 0, lng: 0 } }))!;
    expect(directionsUrl(s.lat, s.lng)).toBe(LINK);
  });

  it("a station with no position gets no link at all", () => {
    const s = mapBackendStation(apiStation({ coordinates: undefined, location: undefined }))!;
    expect(s.lat).toBeNull();
    expect(directionsUrl(s.lat, s.lng)).toBeNull();
  });

  it("booking pass and dashboard booking card: a populated booking.station -> Directions", () => {
    const booking = { _id: "b1", station: apiStation(), status: "upcoming" } as unknown as Booking;
    const st = resolveBookingStation(booking, []);
    expect(st.hasValidCoords).toBe(true);
    expect(directionsUrl(st.lat, st.lng)).toBe(LINK);
  });

  it("nearest-pump card: finder latitude/longitude -> Directions", () => {
    const finderRow = { stationId: "6aabb9028830bdc4c60f978b", latitude: PUMP.lat, longitude: PUMP.lng };
    expect(directionsUrl(finderRow.latitude, finderRow.longitude)).toBe(LINK);
  });
});

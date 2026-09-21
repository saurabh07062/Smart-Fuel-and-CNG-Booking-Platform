import { describe, it, expect } from "vitest";
import { directionsUrl } from "./navigation";
import { distanceMeters, formatDistance } from "./coordinates";

describe("directionsUrl: every station navigates to its saved coordinates", () => {
  it("builds a directions link to exactly the saved point, with no origin", () => {
    const url = directionsUrl(18.5805621, 73.9753407)!;
    expect(url).toBe("https://www.google.com/maps/dir/?api=1&destination=18.5805621,73.9753407&travelmode=driving");
    expect(url).not.toContain("origin=");
  });

  it("accepts coordinates sent as numeric strings", () => {
    expect(directionsUrl("19.0760", "72.8777")).toContain("destination=19.076,72.8777");
  });

  it("gives no link for a station without a real position", () => {
    for (const [lat, lng] of [[null, null], [undefined, undefined], [0, 0], [95, 73], [18.5, 190], ["abc", "73"]] as const) {
      expect(directionsUrl(lat, lng)).toBeNull();
    }
  });
});

describe("distanceMeters", () => {
  it("measures the wrong pins from this session against the pump", () => {
    const pump = { lat: 18.5805621, lng: 73.9753407 };
    expect(Math.round(distanceMeters(pump, { lat: 18.582535014511407, lng: 73.975371 }))).toBeGreaterThan(200);
    expect(distanceMeters(pump, { lat: 18.5717712, lng: 73.9748866 })).toBeGreaterThan(900);
    expect(distanceMeters(pump, pump)).toBe(0);
    expect(formatDistance(978)).toBe("978 m");
    expect(formatDistance(1340)).toBe("1.3 km");
  });
});

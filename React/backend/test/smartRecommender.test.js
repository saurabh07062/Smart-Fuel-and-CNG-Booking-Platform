/**
 * Unit & Integration Tests for Smart Queue-Aware Station Recommender
 * ("Is It Worth It?" Engine)
 *
 * Run with: node --test test/smartRecommender.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const smartRecommender = require("../src/services/station/smartRecommender");

const close = (a, b, tol = 0.5, msg) =>
  assert.ok(
    Math.abs(a - b) <= tol,
    msg || `expected ${a} within ${tol} of ${b}`
  );

test("estimateDriveTimeMinutes calculates city travel duration with road factor", () => {
  // 5 km at 30 km/h with 1.25 road curvature factor = (5 * 1.25 / 30) * 60 = 12.5 mins
  const mins = smartRecommender.estimateDriveTimeMinutes(5, 30);
  close(mins, 12.5, 0.1);

  // 0 km = 0 min
  assert.equal(smartRecommender.estimateDriveTimeMinutes(0), 0);
});

test("calculateTotalTripTime sums drive time, wait time, and service time", () => {
  // distance = 4 km (~10 mins drive), wait = 15 mins, service = 5 mins -> Total ~ 30 mins
  const total = smartRecommender.calculateTotalTripTime({
    distanceKm: 4,
    waitMinutes: 15,
    avgServiceMinutes: 5,
    speedKmh: 30,
  });
  close(total, 30, 0.5);
});

test("compareStationWorth: Station B is WORTH IT (saves 16 mins with small detour)", () => {
  const origin = { lat: 18.5204, lng: 73.8567 };

  // Target Station A: 1 km away, but congested queue (25 mins wait)
  const targetStation = {
    _id: "station_a_123",
    name: "Congested Station A",
    coordinates: { lat: 18.525, lng: 73.858 },
    distanceKm: 1.0,
    waitMinutes: 25,
    avgServiceMinutes: 4,
    slotCapacity: 5,
    bookingsInSlot: 5,
  };

  // Alternative Station B: 2.5 km away (+1.5 km detour), but light queue (2 mins wait)
  const candidateStation = {
    _id: "station_b_456",
    name: "Quick Flow Station B",
    coordinates: { lat: 18.535, lng: 73.865 },
    distanceKm: 2.5,
    waitMinutes: 2,
    avgServiceMinutes: 4,
    slotCapacity: 5,
    bookingsInSlot: 1,
    inventory: { petrol: 5000, diesel: 4000 },
  };

  const result = smartRecommender.compareStationWorth({
    targetStation,
    candidateStation,
    origin,
    fuelType: "petrol",
    requestedQty: 15,
    minTimeSavedMinutes: 7,
    maxDetourKm: 8,
  });

  assert.equal(result.isWorthIt, true, "Recommendation should be marked as worth it");
  assert.ok(result.timeSavedMinutes >= 15, `Expected >= 15 min saved, got ${result.timeSavedMinutes}`);
  assert.ok(result.reason.includes("Saves"), "Reason should indicate positive savings");
  assert.equal(result.stationId, "station_b_456");
});

test("compareStationWorth: Station B is NOT WORTH IT (only saves 2 mins, extra driving)", () => {
  const origin = { lat: 18.5204, lng: 73.8567 };

  // Target Station A: 1 km away, wait = 10 mins
  const targetStation = {
    _id: "station_a",
    name: "Station A",
    coordinates: { lat: 18.525, lng: 73.858 },
    distanceKm: 1.0,
    waitMinutes: 10,
    avgServiceMinutes: 4,
  };

  // Candidate Station B: 4 km away, wait = 5 mins
  // Saved queue wait = 5 mins, but extra drive is ~7.5 mins -> Net loss of time!
  const candidateStation = {
    _id: "station_b",
    name: "Station B",
    coordinates: { lat: 18.55, lng: 73.88 },
    distanceKm: 4.0,
    waitMinutes: 5,
    avgServiceMinutes: 4,
    slotCapacity: 5,
    bookingsInSlot: 1,
    inventory: { petrol: 2000 },
  };

  const result = smartRecommender.compareStationWorth({
    targetStation,
    candidateStation,
    origin,
    fuelType: "petrol",
    requestedQty: 10,
    minTimeSavedMinutes: 7,
    maxDetourKm: 8,
  });

  assert.equal(result.isWorthIt, false, "Small time difference should not be recommended");
  assert.ok(result.timeSavedMinutes < 7, "Time saved should be below threshold");
  assert.ok(result.reason.includes("does not justify"), "Reason should explain why not worth it");
});

test("compareStationWorth: Station B is NOT WORTH IT because detour exceeds maxDetourKm", () => {
  const origin = { lat: 18.5204, lng: 73.8567 };

  const targetStation = {
    _id: "station_a",
    distanceKm: 1.0,
    waitMinutes: 40,
    avgServiceMinutes: 4,
  };

  // Candidate is 15 km away (exceeds maxDetourKm = 8)
  const candidateStation = {
    _id: "station_c",
    distanceKm: 15.0,
    waitMinutes: 0,
    avgServiceMinutes: 4,
    slotCapacity: 5,
    bookingsInSlot: 0,
    inventory: { petrol: 5000 },
  };

  const result = smartRecommender.compareStationWorth({
    targetStation,
    candidateStation,
    origin,
    fuelType: "petrol",
    requestedQty: 10,
    minTimeSavedMinutes: 7,
    maxDetourKm: 8,
  });

  assert.equal(result.isWorthIt, false);
  assert.ok(result.reason.includes("too far"), "Reason should state station is too far");
});

test("compareStationWorth: Candidate that cannot take the booking is disqualified", () => {
  const origin = { lat: 18.5204, lng: 73.8567 };

  const targetStation = {
    _id: "station_a",
    distanceKm: 1.0,
    waitMinutes: 30,
  };

  const candidateStation = {
    _id: "station_full",
    distanceKm: 2.0,
    waitMinutes: 0,
    canBook: false, // nozzle reserved / closed at that slot
    inventory: { petrol: 5000 },
  };

  const result = smartRecommender.compareStationWorth({
    targetStation,
    candidateStation,
    origin,
    fuelType: "petrol",
    requestedQty: 10,
  });

  assert.equal(result.isWorthIt, false);
  assert.ok(result.reason.includes("cannot take a booking"));
});

test("compareStationWorth: Candidate with insufficient fuel is disqualified", () => {
  const origin = { lat: 18.5204, lng: 73.8567 };

  const targetStation = {
    _id: "station_a",
    distanceKm: 1.0,
    waitMinutes: 30,
  };

  const candidateStation = {
    _id: "station_no_fuel",
    distanceKm: 2.0,
    waitMinutes: 0,
    slotCapacity: 5,
    bookingsInSlot: 0,
    inventory: { petrol: 5 }, // Only 5L left, requested 20L
  };

  const result = smartRecommender.compareStationWorth({
    targetStation,
    candidateStation,
    origin,
    fuelType: "petrol",
    requestedQty: 20,
  });

  assert.equal(result.isWorthIt, false);
  assert.ok(result.reason.includes("available") || result.reason.includes("stock"));
});

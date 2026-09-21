/**
 * Road distance (services/station/roadDistance.js): driving distance from an
 * OSRM table replaces the straight line; any router failure keeps the
 * straight line. A fake router -- no network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { roadDistances, withRoadDistance, _reset } = require("../src/services/station/roadDistance");

const env = { ROUTING_URL: "http://osrm.test" };
const origin = { lat: 18.5721, lng: 73.9842 };
const pumps = [
  { name: "BALSKAR", distanceKm: 1.32, coordinates: { lat: 18.5805621, lng: 73.9753407 } },
  { name: "Torrent", distanceKm: 1.29, location: { type: "Point", coordinates: [73.9751642, 18.5803494] } },
];

const osrm = (distances, durations) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ code: "Ok", distances: [distances], durations: [durations] }) };
  };
  return { fetchImpl, calls };
};

test.beforeEach(() => _reset());
test.after(() => _reset());

test("uses the driving distance along the roads, keeping the straight line", async () => {
  const { fetchImpl, calls } = osrm([0, 4512.8, 4439.9], [0, 540, 520]);
  const out = await withRoadDistance(origin, pumps, { fetchImpl, env });
  assert.equal(calls.length, 1, "one request for every station");
  assert.match(calls[0], /^http:\/\/osrm\.test\/table\/v1\/driving\/73\.9842,18\.5721;73\.9753407,18\.5805621;73\.9751642,18\.5803494\?sources=0/);
  assert.deepEqual(
    out.map((s) => [s.name, s.distanceType, s.distanceKm, s.straightLineKm, s.driveTimeMinutes]),
    [
      ["BALSKAR", "road", 4.5128, 1.32, 9],
      ["Torrent", "road", 4.4399, 1.29, 520 / 60],
    ],
  );
});

test("a repeated search from the same spot is answered from the cache", async () => {
  const first = osrm([0, 4512.8, 4439.9], [0, 540, 520]);
  await roadDistances(origin, pumps.map((p) => p.coordinates ?? { lat: 18.5803494, lng: 73.9751642 }), { fetchImpl: first.fetchImpl, env });
  const second = osrm([0, 1, 1], [0, 1, 1]);
  const again = await roadDistances(origin, [pumps[0].coordinates], { fetchImpl: second.fetchImpl, env });
  assert.equal(second.calls.length, 0);
  assert.equal(again[0].distanceKm, 4.5128);
});

test("router down, slow or saying no: the straight line stays", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => ({ ok: false, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ code: "NoRoute" }) }),
  ]) {
    _reset();
    const out = await withRoadDistance(origin, pumps, { fetchImpl, env });
    assert.deepEqual(out.map((s) => [s.distanceType, s.distanceKm]), [["straight", 1.32], ["straight", 1.29]]);
  }
});

test("ROUTING_URL=off: no request at all", async () => {
  const { fetchImpl, calls } = osrm([0, 1], [0, 1]);
  const out = await withRoadDistance(origin, pumps, { fetchImpl, env: { ROUTING_URL: "off" } });
  assert.equal(calls.length, 0);
  assert.equal(out[0].distanceType, "straight");
});

// ---- Google Routes API (GOOGLE_MAPS_API_KEY) --------------------------------

const googleEnv = { ROUTING_URL: "http://osrm.test", GOOGLE_MAPS_API_KEY: "test-key" };

test("with a Google key: Google's road distance is used, one request", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => [
        { originIndex: 0, destinationIndex: 1, distanceMeters: 3800, duration: "540s", condition: "ROUTE_EXISTS" },
        { originIndex: 0, destinationIndex: 0, distanceMeters: 3900, duration: "600s", condition: "ROUTE_EXISTS" },
      ],
    };
  };
  const out = await withRoadDistance(origin, pumps, { fetchImpl, env: googleEnv });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /routes\.googleapis\.com\/distanceMatrix\/v2:computeRouteMatrix/);
  assert.equal(calls[0].init.headers["X-Goog-Api-Key"], "test-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.travelMode, "DRIVE");
  assert.deepEqual(body.origins[0].waypoint.location.latLng, { latitude: 18.5721, longitude: 73.9842 });
  assert.deepEqual(
    out.map((x) => [x.name, x.distanceType, x.distanceSource, x.distanceKm, x.driveTimeMinutes]),
    [
      ["BALSKAR", "road", "google", 3.9, 10],
      ["Torrent", "road", "google", 3.8, 9],
    ],
  );
});

test("Google refuses (billing off): OSRM answers, and Google is not asked again for a while", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("googleapis")) {
      return { ok: false, status: 403, json: async () => [{ error: { status: "PERMISSION_DENIED" } }] };
    }
    return { ok: true, json: async () => ({ code: "Ok", distances: [[0, 4512.8, 4439.9]], durations: [[0, 540, 520]] }) };
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await withRoadDistance(origin, pumps, { fetchImpl, env: googleEnv });
    assert.deepEqual(out.map((x) => [x.distanceSource, x.distanceKm]), [["osrm", 4.5128], ["osrm", 4.4399]]);
    const googleCalls = () => calls.filter((u) => u.includes("googleapis")).length;
    // A search from somewhere else (not cached) right after: straight to OSRM.
    await withRoadDistance({ lat: 18.58, lng: 73.99 }, pumps, { fetchImpl, env: googleEnv });
    assert.equal(googleCalls(), 1, "Google not asked again during the back-off");
    _reset(); // back-off over
    await withRoadDistance(origin, pumps, { fetchImpl, env: googleEnv });
    assert.equal(googleCalls(), 2, "tried again once the back-off ends");
  } finally {
    console.warn = warn;
  }
});

test("Google routes only some stations: OSRM fills in the rest", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("googleapis")) {
      return {
        ok: true,
        json: async () => [
          { originIndex: 0, destinationIndex: 0, distanceMeters: 3900, duration: "600s", condition: "ROUTE_EXISTS" },
          { originIndex: 0, destinationIndex: 1, condition: "ROUTE_NOT_FOUND" },
        ],
      };
    }
    // OSRM is asked only for the one Google could not route.
    assert.match(url, /73\.9842,18\.5721;73\.9751642,18\.5803494\?/);
    return { ok: true, json: async () => ({ code: "Ok", distances: [[0, 4439.9]], durations: [[0, 520]] }) };
  };
  const out = await withRoadDistance(origin, pumps, { fetchImpl, env: googleEnv });
  assert.deepEqual(out.map((x) => [x.distanceSource, x.distanceKm]), [["google", 3.9], ["osrm", 4.4399]]);
});

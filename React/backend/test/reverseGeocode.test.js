const test = require("node:test");
const assert = require("node:assert");

const { shortName, keyFor, reverseGeocode, _cache } = require("../src/services/station/reverseGeocode");

test("names a point the way a person would say it", () => {
  // The road the pin is on leads: a point on Nagar Road must not read "Pune".
  assert.strictEqual(
    shortName({ road: "Nagar Road", neighbourhood: "Ramwadi", suburb: "Ward 12", city: "Pune" }),
    "Nagar Road, Ramwadi",
  );
  assert.strictEqual(
    shortName({ road: "Mayuri Tarangan Road", town: "Wagholi", county: "Pune City Subdistrict" }),
    "Mayuri Tarangan Road, Wagholi",
  );
  // No road in the reply: the locality and its city.
  assert.strictEqual(
    shortName({ suburb: "Wagholi", city: "Pune", state: "Maharashtra", postcode: "412207" }),
    "Wagholi, Pune",
  );
  // No locality either: the city alone still says where you are.
  assert.strictEqual(shortName({ city: "Pune", state: "Maharashtra" }), "Pune");
  // Locality and city are the same word: it is not repeated.
  assert.strictEqual(shortName({ town: "Wagholi", city: "Wagholi" }), "Wagholi");
  // Nothing but a state is better than nothing at all.
  assert.strictEqual(shortName({ state: "Maharashtra" }), "Maharashtra");
  assert.strictEqual(shortName({}), null);
});

test("an administrative ward is not a place anyone names", () => {
  assert.strictEqual(shortName({ suburb: "Ward 12", state_district: "Pune", state: "Maharashtra" }), "Pune");
  assert.strictEqual(shortName({ suburb: "Zone 3", city: "Nagpur" }), "Nagpur");
  // ...but a real place that merely starts with those letters is kept.
  assert.strictEqual(shortName({ suburb: "Wardha Road", city: "Nagpur" }), "Wardha Road, Nagpur");
});

test("caches on a ~100m grid, so nudging a pin is not a new request", () => {
  // ~1 m apart: the same cache key, so a dragged pin reuses the answer.
  assert.strictEqual(keyFor(18.572131, 73.984212), keyFor(18.572139, 73.984208));
  assert.notStrictEqual(keyFor(18.5721, 73.9842), keyFor(18.5821, 73.9842));
});

test("a cached point answers without calling out", async () => {
  const lat = 18.5721;
  const lng = 73.9842;
  _cache.set(keyFor(lat, lng), { name: "Wagholi, Pune", at: Date.now() });

  const originalFetch = global.fetch;
  global.fetch = () => assert.fail("a cached point must not reach the network");
  try {
    assert.deepStrictEqual(await reverseGeocode(lat, lng), { name: "Wagholi, Pune", cached: true });
  } finally {
    global.fetch = originalFetch;
    _cache.clear();
  }
});

test("a failure is reported as no name, never as a throw", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("offline");
  };
  try {
    assert.deepStrictEqual(await reverseGeocode(11.1111, 77.7777), { name: null, cached: false });
  } finally {
    global.fetch = originalFetch;
    _cache.clear();
  }
});

test("rejects coordinates that are not coordinates", async () => {
  assert.deepStrictEqual(await reverseGeocode(NaN, 73.98), { name: null, cached: false });
});

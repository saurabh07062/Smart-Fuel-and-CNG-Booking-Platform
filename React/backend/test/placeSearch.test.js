/**
 * Typed-place search: GET /api/v1/discovery/search-place?q=
 *
 * How a customer says where they are when the device will not give a fix.
 * The external lookup is replaced here with a stub, deliberately: these tests
 * are about OUR behaviour -- caching, the politeness gap, what a failure
 * looks like to the caller -- and a test that calls a public service over the
 * internet fails for reasons that have nothing to do with this code.
 *
 *   node --test test/placeSearch.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

test.after(async () => {
  await require("../src/services/security/rateLimiter").close();
});

/** One Nominatim-shaped row. */
const row = (over = {}) => ({
  lat: "18.5805621",
  lon: "73.9753407",
  display_name: "Wagholi, Haveli, Pune District, Maharashtra, 412207, India",
  type: "suburb",
  ...over,
});

test("place search", async (t) => {
  const placeSearch = require("../src/services/station/placeSearch");
  const realFetch = global.fetch;

  const stub = (impl) => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push(String(url));
      return impl(String(url), init);
    };
    return calls;
  };

  t.afterEach(() => {
    global.fetch = realFetch;
    placeSearch._cache.clear();
  });

  await t.test("a query becomes coordinates a customer can recognise", async () => {
    stub(async () => new Response(JSON.stringify([row()]), { status: 200 }));

    const { results } = await placeSearch.searchPlaces("wagholi");
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      // The first two parts of the postal address: what a person says.
      name: "Wagholi, Haveli",
      label: "Wagholi, Haveli, Pune District, Maharashtra, 412207, India",
      lat: 18.5805621,
      lng: 73.9753407,
      type: "suburb",
    });
  });

  await t.test("the same query is answered from the cache, not the service", async () => {
    const calls = stub(async () => new Response(JSON.stringify([row()]), { status: 200 }));

    const first = await placeSearch.searchPlaces("Baner Road");
    const second = await placeSearch.searchPlaces("  baner   road  "); // same place, typed differently

    assert.equal(first.cached, false);
    assert.equal(second.cached, true, "spacing and case do not make a new request");
    assert.equal(calls.length, 1);
  });

  await t.test("a query too short to mean anything is not sent at all", async () => {
    const calls = stub(async () => new Response("[]", { status: 200 }));

    for (const q of ["", " ", "ba"]) {
      const { results } = await placeSearch.searchPlaces(q);
      assert.deepEqual(results, []);
    }
    assert.equal(calls.length, 0);
  });

  await t.test("a failed lookup is an empty list, never a thrown error", async () => {
    stub(async () => {
      throw new Error("network down");
    });
    const { results } = await placeSearch.searchPlaces("kothrud");
    assert.deepEqual(results, [], "the caller falls back to the map");

    stub(async () => new Response("rate limited", { status: 429 }));
    placeSearch._cache.clear();
    assert.deepEqual((await placeSearch.searchPlaces("hadapsar")).results, []);
  });

  await t.test("rows without a usable position are dropped, not shown", async () => {
    stub(async () => new Response(JSON.stringify([row(), row({ lat: "not-a-number" }), row({ lon: null })]), { status: 200 }));
    const { results } = await placeSearch.searchPlaces("pune");
    assert.equal(results.length, 1);
  });

  await t.test("the search is limited to India unless told otherwise", async () => {
    const calls = stub(async () => new Response("[]", { status: 200 }));
    await placeSearch.searchPlaces("station road");
    assert.match(calls[0], /countrycodes=in/);
    assert.match(calls[0], /q=station\+road/);
  });
});

test("the endpoint", async (t) => {
  const testDb = require("./helpers/testDb");
  testDb.isolateRedis();
  const app = require("../src/app");
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const placeSearch = require("../src/services/station/placeSearch");
  const realFetch = global.fetch;

  try {
    await t.test("answers with the places it found", async () => {
      placeSearch._cache.clear();
      global.fetch = async (url) =>
        String(url).includes("nominatim")
          ? new Response(JSON.stringify([row()]), { status: 200 })
          : realFetch(url);

      const res = await fetch(`${base}/api/v1/discovery/search-place?q=wagholi`);
      global.fetch = realFetch;

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.results.length, 1);
      assert.equal(body.results[0].lat, 18.5805621);
    });

    await t.test("a short query is answered, not refused", async () => {
      // 200 with an empty list: the customer is typing, not doing anything wrong.
      const res = await fetch(`${base}/api/v1/discovery/search-place?q=ba`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.results, []);
      assert.match(body.msg, /three characters/);
    });

    await t.test("it is public, like the rest of discovery", async () => {
      const res = await fetch(`${base}/api/v1/discovery/search-place?q=xyzzyplace`);
      assert.notEqual(res.status, 401, "a visitor can set their location before signing in");
    });
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

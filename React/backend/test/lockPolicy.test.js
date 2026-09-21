/**
 * Lock failure policy and booking pricing -- pure, no server or database.
 *
 *   node --test test/lockPolicy.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
// Test settings (far-off fixture dates are allowed): test/helpers/testDb.js.
require("./helpers/testDb");

test("lock: when distributed locking is required and Redis is absent, acquiring fails safely", async () => {
  const savedUrl = process.env.REDIS_URL;
  const savedFlag = process.env.LOCK_REQUIRE_DISTRIBUTED;
  delete process.env.REDIS_URL;
  process.env.LOCK_REQUIRE_DISTRIBUTED = "true";

  const lock = require("../src/services/core/lock");
  await lock.close(); // reset module state
  try {
    assert.equal(lock.requiresDistributed(), true);
    await assert.rejects(lock.tryAcquire("test:policy:strict", 1000), (err) => err.code === "LOCK_UNAVAILABLE");
    assert.equal(lock.getMode(), "unavailable");
    assert.equal(lock.isDistributed(), false);
    await assert.rejects(
      lock.withLock("test:policy:strict", async () => "should not run"),
      (err) => err.code === "LOCK_UNAVAILABLE",
      "withLock must never run the critical section without a real lock",
    );
  } finally {
    await lock.close();
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
    if (savedFlag === undefined) delete process.env.LOCK_REQUIRE_DISTRIBUTED;
    else process.env.LOCK_REQUIRE_DISTRIBUTED = savedFlag;
  }
});

test("lock: NODE_ENV=production requires distributed locking by default", () => {
  const lock = require("../src/services/core/lock");
  const savedEnv = process.env.NODE_ENV;
  const savedFlag = process.env.LOCK_REQUIRE_DISTRIBUTED;
  delete process.env.LOCK_REQUIRE_DISTRIBUTED;
  try {
    process.env.NODE_ENV = "production";
    assert.equal(lock.requiresDistributed(), true);
    process.env.NODE_ENV = "development";
    assert.equal(lock.requiresDistributed(), false);
    process.env.LOCK_REQUIRE_DISTRIBUTED = "true";
    assert.equal(lock.requiresDistributed(), true, "the explicit flag wins");
  } finally {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedFlag === undefined) delete process.env.LOCK_REQUIRE_DISTRIBUTED;
    else process.env.LOCK_REQUIRE_DISTRIBUTED = savedFlag;
  }
});

test("lock: development mode still serialises a read-modify-write (single process)", async () => {
  const savedUrl = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  const lock = require("../src/services/core/lock");
  await lock.close();
  try {
    let seats = 1;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        lock.withLock("test:policy:dev", async () => {
          const available = seats;
          await new Promise((r) => setTimeout(r, 2));
          if (available > 0) {
            seats = available - 1;
            return "booked";
          }
          return "full";
        }, { maxWaitMs: 4000 }),
      ),
    );
    assert.equal(lock.getMode(), "memory");
    assert.equal(results.filter((r) => r === "booked").length, 1);
  } finally {
    await lock.close();
    if (savedUrl !== undefined) process.env.REDIS_URL = savedUrl;
  }
});

test("priceBooking: server price = station unit price x quantity + convenience fee", () => {
  const { priceBooking } = require("../src/services/booking/bookingCreate");
  const { CONVENIENCE_FEE } = require("../src/config/booking");

  assert.deepEqual(priceBooking({ prices: { petrol: 106.12 } }, "petrol", 23), {
    price: 106.12,
    taxes: CONVENIENCE_FEE,
    amount: Math.round((106.12 * 23 + CONVENIENCE_FEE) * 100) / 100,
  });
  assert.equal(priceBooking({ prices: { cng: 86.5 } }, "cng", 5).amount, 86.5 * 5 + CONVENIENCE_FEE);
});

test("priceBooking: a missing, zero or negative price is refused, never guessed", () => {
  const { priceBooking } = require("../src/services/booking/bookingCreate");
  assert.equal(priceBooking({ prices: {} }, "diesel", 5), null);
  assert.equal(priceBooking({ prices: { diesel: 0 } }, "diesel", 5), null);
  assert.equal(priceBooking({ prices: { diesel: -3 } }, "diesel", 5), null);
  assert.equal(priceBooking(null, "diesel", 5), null);
});

test("validateInput: only listed slot labels, valid quantities and fuels are accepted", () => {
  const { validateInput } = require("../src/services/booking/bookingCreate");
  const base = { stationId: "64b000000000000000000001", fuelType: "Petrol", quantity: 5, bookingDate: "2099-01-01", timeSlot: "9:00 AM" };

  assert.equal(validateInput(base).fuel, "petrol");
  const reasonOf = (body) => {
    try {
      validateInput(body);
      return null;
    } catch (err) {
      return err.reason;
    }
  };
  assert.equal(reasonOf({ ...base, timeSlot: "9:07 AM" }), "INVALID_SLOT");
  assert.equal(reasonOf({ ...base, timeSlot: "18:45-19:00" }), "INVALID_SLOT");
  assert.equal(reasonOf({ ...base, quantity: 0 }), "INVALID_QUANTITY");
  assert.equal(reasonOf({ ...base, quantity: 61 }), "INVALID_QUANTITY");
  assert.equal(reasonOf({ ...base, fuelType: "Hydrogen" }), "INVALID_FUEL_TYPE");
  assert.equal(reasonOf({ ...base, stationId: "abc" }), "INVALID_STATION");
  assert.equal(reasonOf({ ...base, bookingDate: "2020-01-01" }), "SLOT_PASSED");
});

test("config: every fuel service duration is shorter than the slot spacing", () => {
  const { SLOT_SPACING_SECONDS } = require("../src/config/booking");
  const { FUEL_SERVICE_DURATIONS_SECONDS } = require("../src/config/fuelDurations");
  for (const seconds of Object.values(FUEL_SERVICE_DURATIONS_SECONDS)) {
    assert.ok(seconds < SLOT_SPACING_SECONDS);
  }
});

test.after(async () => {
  await require("../src/services/core/lock").close();
  await require("../src/services/security/rateLimiter").close();
});

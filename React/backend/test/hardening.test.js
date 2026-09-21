/**
 * Hardening of public endpoints:
 *   - simulate-wait refuses sizes that would block the event loop
 *   - resend-verification takes a plain string, never a query operator, and
 *     does not reveal whether an address is registered
 *
 * Needs the API on the test database:
 *   npm run test:server        then        node --test test/hardening.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const testDb = require("./helpers/testDb");
const API = testDb.apiUrl();

async function post(url, body) {
  const started = Date.now();
  const res = await fetch(`${API}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), ms: Date.now() - started };
}

test("public endpoint hardening", { timeout: 60_000 }, async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    t.skip(`Test API not reachable at ${API} -- run "npm run test:server" first`);
    return;
  }

  await t.test("simulate-wait: a huge nozzle count is refused at once", async () => {
    const r = await post("/api/v1/discovery/simulate-wait", { arrivalRatePerHour: 1, serviceRatePerHour: 1, nozzles: 1e10 });
    assert.equal(r.status, 400);
    assert.ok(r.ms < 1000, `answered in ${r.ms} ms`);
  });

  await t.test("simulate-wait: normal input still works", async () => {
    const r = await post("/api/v1/discovery/simulate-wait", { arrivalRatePerHour: 10, serviceRatePerHour: 6, nozzles: 3, position: 4 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(typeof r.body.steadyStateWaitMinutes, "number");
  });

  await t.test("resend-verification: an operator object is not a query", async () => {
    const r = await post("/api/auth/resend-verification", { email: { $ne: null } });
    assert.equal(r.status, 400);
  });

  await t.test("resend-verification: unknown address gets the neutral reply", async () => {
    const r = await post("/api/auth/resend-verification", { email: `nobody-${Date.now()}@fuelmart.test` });
    assert.equal(r.status, 200);
    assert.match(r.body.msg, /If that email has an account/);
  });
});

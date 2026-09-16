/**
 * config/cors.js -- which browser origins may use the API and Socket.IO.
 *
 *   node --test test/cors.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { isOriginAllowed } = require("../src/config/cors");

const dev = { NODE_ENV: "development" };
const prod = { NODE_ENV: "production", CLIENT_URL: "https://app.fuelmart.in", CORS_ORIGINS: "https://admin.fuelmart.in, https://partners.fuelmart.in/" };

test("no Origin header (scripts, server-to-server, tests) is allowed", () => {
  assert.equal(isOriginAllowed(undefined, "api.fuelmart.in", prod), true);
  assert.equal(isOriginAllowed("", null, prod), true);
});

test("development: the local Vite dev servers are allowed, other sites are not", () => {
  assert.equal(isOriginAllowed("http://localhost:3001", "localhost:5000", dev), true);
  assert.equal(isOriginAllowed("http://127.0.0.1:3002", "127.0.0.1:5055", dev), true);
  assert.equal(isOriginAllowed("https://evil.example", "localhost:5000", dev), false);
});

test("production: only CLIENT_URL, CORS_ORIGINS and same-origin", () => {
  assert.equal(isOriginAllowed("https://app.fuelmart.in", "api.fuelmart.in", prod), true);
  assert.equal(isOriginAllowed("https://admin.fuelmart.in", "api.fuelmart.in", prod), true);
  assert.equal(isOriginAllowed("https://partners.fuelmart.in", "api.fuelmart.in", prod), true, "trailing slash in the list is ignored");
  assert.equal(isOriginAllowed("https://api.fuelmart.in", "api.fuelmart.in", prod), true, "same origin");
  assert.equal(isOriginAllowed("http://localhost:3001", "api.fuelmart.in", prod), false, "localhost is dev-only");
  assert.equal(isOriginAllowed("https://evil.example", "api.fuelmart.in", prod), false);
});

test("malformed and opaque origins are refused", () => {
  assert.equal(isOriginAllowed("null", "localhost:5000", dev), false);
  assert.equal(isOriginAllowed("not a url", "localhost:5000", dev), false);
  assert.equal(isOriginAllowed("https://app.fuelmart.in.evil.example", "api.fuelmart.in", prod), false);
});

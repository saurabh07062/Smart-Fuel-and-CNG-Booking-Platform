/**
 * Who may make a state-changing request with a session cookie.
 *
 * The rule protects one thing: a page on another site cannot use a
 * customer's cookie to book, cancel or pay. The Android app is not a page
 * and has no origin, which is why it gets its own answer here.
 *
 *   node --test test/originGuard.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { originAllowed, SAFE_METHODS } = require("../src/middleware/origin");

/** A minimal stand-in for the Express request the middleware reads. */
const reqWith = (headers = {}, method = "POST") => ({
  method,
  get(name) {
    return headers[String(name).toLowerCase()];
  },
});

test("a request from the API's own origin is allowed", () => {
  assert.equal(originAllowed(reqWith({ origin: "http://10.0.0.5:5000", host: "10.0.0.5:5000" })), true);
});

test("a request from another website is refused", () => {
  assert.equal(originAllowed(reqWith({ origin: "https://evil.example", host: "10.0.0.5:5000" })), false);
});

test("the Android app is allowed: no origin, but it says who it is", () => {
  // Capacitor makes the request in Android, outside the WebView, so there is
  // no Origin and no Referer to send.
  assert.equal(originAllowed(reqWith({ host: "10.0.0.5:5000", "x-fm-client": "android" })), true);
  assert.equal(originAllowed(reqWith({ host: "10.0.0.5:5000", "x-fm-client": "ANDROID" })), true);
});

test("no origin and no client header is still refused", () => {
  assert.equal(originAllowed(reqWith({ host: "10.0.0.5:5000" })), false);
  assert.equal(originAllowed(reqWith({ host: "10.0.0.5:5000", "x-fm-client": "something-else" })), false);
});

test("a hostile page cannot borrow the app's header", () => {
  // It would have to be a cross-origin request WITH a custom header, which a
  // browser only sends after a preflight this server refuses for that origin.
  // Even if the header arrives, the origin decides.
  assert.equal(
    originAllowed(reqWith({ origin: "https://evil.example", host: "10.0.0.5:5000", "x-fm-client": "android" })),
    false,
  );
});

test("a referer stands in for a missing origin", () => {
  assert.equal(originAllowed(reqWith({ referer: "http://10.0.0.5:5000/app/", host: "10.0.0.5:5000" })), true);
  assert.equal(originAllowed(reqWith({ referer: "https://evil.example/x", host: "10.0.0.5:5000" })), false);
});

test("safe methods are not the guard's business", () => {
  assert.ok(SAFE_METHODS.has("GET"));
  assert.ok(SAFE_METHODS.has("HEAD"));
  assert.ok(!SAFE_METHODS.has("POST"));
});

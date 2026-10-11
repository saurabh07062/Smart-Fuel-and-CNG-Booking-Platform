/**
 * Registration signs the new account in -- and says WHO was signed in.
 *
 * The bug this exists to prevent: POST /api/auth/register returned its own
 * hand-rolled user object (name, email, wallet, rewards, vehicles) with no
 * `id` and no `role`, while login returned the full session view. A new
 * account was therefore signed in as somebody with no role, the client's role
 * gate refused the dashboard to a user with no role and redirected to the
 * dashboard, and the Android app showed a white screen.
 *
 * So the rule under test is not "register returns some fields". It is:
 *
 *     a response that signs someone in describes them the same way every
 *     other auth response does
 *
 * Tested by comparing register's user against login's for the SAME account,
 * key by key -- which no list of expected fields written here could do, since
 * the next field added to the session view would not be in it.
 *
 *   node --test test/registerSession.test.js
 *
 * Needs the API on the test database: npm run test:server
 * DEVELOPMENT TEST DATA: one tagged account, removed at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const testDb = require("./helpers/testDb");
const API = testDb.apiUrl();
const MONGO = testDb.uri();

/** One request, keeping the cookies the server set. */
async function call(method, url, { body, cookies, tab } = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      // The app sends its own tab id; the session cookies are named after it.
      ...(tab ? { "X-FM-Tab": tab } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      Origin: process.env.CLIENT_URL || "http://localhost:3001",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return {
    status: res.status,
    body: await res.json().catch(() => ({})),
    // Just the name=value pairs, as a browser would send them back.
    cookies: setCookie.map((c) => c.split(";")[0]).join("; "),
    setCookie,
  };
}

test("registration signs the new account in", { timeout: 120_000 }, async (t) => {
  const reachable = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    t.skip(`Test API not reachable at ${API} -- run "npm run test:server" first`);
    return;
  }

  const mongoose = require("mongoose");
  await mongoose.connect(MONGO, { serverSelectionTimeoutMS: 2500 });
  const User = require("../src/models/User");
  const RewardLedger = require("../src/models/RewardLedger");

  const tag = `reg-${Date.now()}`;
  const email = `${tag}@fuelmart.test`;
  const password = "Str0ng!pass9";
  // The app's own tab id, as utils/tabId.ts generates it.
  const tab = "a1b2c3d4e5f60718";

  try {
    let registered;
    await t.test("the response carries a usable user: an id and a role", async () => {
      registered = await call("POST", "/api/auth/register", {
        body: { name: `${tag} Customer`, email, password },
        tab,
      });

      assert.equal(registered.status, 200, JSON.stringify(registered.body));
      const user = registered.body.user;
      assert.ok(user, "a user came back");

      // The two fields whose absence caused the blank screen.
      assert.ok(user.id, "the new account's id");
      assert.equal(user.role, "customer", "the role the client's route gate reads");

      // And the rest of what a client needs to draw the dashboard.
      assert.equal(user.email, email.toLowerCase());
      assert.equal(typeof user.rewards, "number");
      assert.ok(Array.isArray(user.vehicles));
    });

    await t.test("it is the SAME shape login returns, field for field", async () => {
      const signedIn = await call("POST", "/api/auth/login", { body: { email, password }, tab });
      assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));

      const afterRegister = Object.keys(registered.body.user).sort();
      const afterLogin = Object.keys(signedIn.body.user).sort();
      assert.deepEqual(
        afterRegister,
        afterLogin,
        "a response that signs someone in must describe them exactly as login does",
      );
      assert.equal(String(registered.body.user.id), String(signedIn.body.user.id), "and it is the same person");
    });

    await t.test("the session cookies come with it, named for the caller's tab", async () => {
      // This is what makes the new account authenticated immediately rather
      // than only "created": the app does not have to sign in afterwards.
      assert.ok(
        registered.setCookie.some((c) => c.startsWith(`fm_access_${tab}=`)),
        `expected an fm_access_${tab} cookie, got: ${registered.setCookie.map((c) => c.split("=")[0]).join(", ")}`,
      );
      assert.ok(registered.setCookie.some((c) => c.startsWith(`fm_refresh_${tab}=`)));
      // httpOnly, so no script in the page can read the session.
      assert.ok(registered.setCookie.every((c) => /httponly/i.test(c)));
    });

    await t.test("those cookies work straight away: the dashboard's own call succeeds", async () => {
      // The real test of "remains authenticated": the next request, with only
      // the cookies registration set, is accepted.
      const me = await call("GET", "/api/auth/me", { cookies: registered.cookies, tab });
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body.user.email, email.toLowerCase());
      assert.equal(me.body.user.role, "customer");

      // And a customer-only endpoint, which is what the dashboard actually loads.
      const dash = await call("GET", "/api/customer/dashboard", { cookies: registered.cookies, tab });
      assert.equal(dash.status, 200, JSON.stringify(dash.body));
    });

    await t.test("the session survives being presented by a new process (an app restart)", async () => {
      // The app stores its tab id on disk now (frontend utils/tabId.ts), so a
      // relaunch presents the SAME id with the SAME cookies from Android's
      // cookie jar. Nothing about the session is tied to the page that made it.
      const after = await call("GET", "/api/auth/me", { cookies: registered.cookies, tab });
      assert.equal(after.status, 200, "the session is still good on a later launch");
      assert.equal(after.body.user.email, email.toLowerCase());
    });

    await t.test("registration sets a tab session AND the shared one, so a relaunch can recover either way", async () => {
      const names = registered.setCookie.map((c) => c.split("=")[0]);
      // The tab's own pair: what the app presents once its id is on disk.
      assert.ok(names.includes(`fm_access_${tab}`), names.join(", "));
      assert.ok(names.includes(`fm_refresh_${tab}`));
      // And the shared pair, which is the fallback a client with a DIFFERENT id
      // adopts (X-FM-Adopt -> POST /auth/refresh). That fallback is why a
      // restart did not lose the session outright -- but it costs a round trip
      // and a fork, and the signed-in PROFILE was lost with sessionStorage,
      // which is what put the login screen in front of a signed-in person.
      assert.ok(names.includes("fm_access"), names.join(", "));
      assert.ok(names.includes("fm_refresh"));

      const adopted = await call("POST", "/api/auth/refresh", {
        cookies: registered.cookies,
        tab: "99887766554433",
      });
      assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
      assert.equal(adopted.body.user.role, "customer", "the adopted session knows the role too");
      assert.equal(String(adopted.body.user.id), String(registered.body.user.id));
    });

    await t.test("registering the same email again is refused, and nothing is duplicated", async () => {
      const again = await call("POST", "/api/auth/register", {
        body: { name: "Someone else", email, password },
        tab,
      });
      assert.equal(again.status, 400);
      assert.equal(await User.countDocuments({ email: email.toLowerCase() }), 1);
    });
  } finally {
    const users = await User.find({ email: email.toLowerCase() }).select("_id").lean();
    const ids = users.map((u) => u._id);
    await RewardLedger.deleteMany({ user: { $in: ids } });
    await require("../src/models/RefreshToken").deleteMany({ user: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    await mongoose.disconnect();
    await require("../src/services/security/rateLimiter").close();
  }
});

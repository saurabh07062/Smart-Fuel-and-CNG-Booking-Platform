/**
 * Which browser origins may call the API and open a Socket.IO connection.
 *
 * Replaces `cors: { origin: "*" }` / `app.use(cors())`, which let any website
 * open a socket to this server and read public responses from a visitor's
 * browser. The rule, in order:
 *
 *   1. no Origin header          allowed -- non-browser clients (scripts, the
 *                                test suite, server-to-server) send none, and
 *                                auth is a token in the request, not a cookie
 *   2. listed in CORS_ORIGINS    allowed (comma-separated, exact origins)
 *   3. CLIENT_URL                allowed (the deployed frontend, .env)
 *   4. same origin as this API   allowed (the app served by this server)
 *   5. localhost / 127.0.0.1     allowed only when NODE_ENV is not production,
 *                                so the Vite dev servers keep working
 *   anything else                refused
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const normalise = (origin) => String(origin || "").trim().replace(/\/+$/, "").toLowerCase();

function listFromEnv(env) {
  return new Set(
    String(env.CORS_ORIGINS || "")
      .split(",")
      .map(normalise)
      .filter(Boolean),
  );
}

/**
 * @param {string|undefined} origin  the request's Origin header
 * @param {string|null} [host]       the request's Host header, for the same-origin rule
 * @param {object} [env]             injectable for tests
 */
function isOriginAllowed(origin, host = null, env = process.env) {
  if (!origin) return true;
  const o = normalise(origin);

  if (listFromEnv(env).has(o)) return true;
  if (env.CLIENT_URL && normalise(env.CLIENT_URL) === o) return true;

  let url;
  try {
    url = new URL(o);
  } catch {
    return false; // "null" (sandboxed frames, file://) or garbage
  }
  if (host && url.host === String(host).toLowerCase()) return true;
  if (env.NODE_ENV !== "production" && LOCAL_HOSTS.has(url.hostname)) return true;
  return false;
}

module.exports = { isOriginAllowed };

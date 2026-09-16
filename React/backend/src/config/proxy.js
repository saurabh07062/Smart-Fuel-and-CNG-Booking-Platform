/**
 * Express "trust proxy", from TRUST_PROXY -- which decides what req.ip is,
 * and therefore which client every IP rate limit counts against.
 *
 *   unset / false / 0     not trusted: req.ip is the connecting socket's
 *                         address and X-Forwarded-For is ignored, so a client
 *                         cannot pick its own IP. Right when Node faces
 *                         clients directly.
 *   a whole number, e.g. 1  that many proxy hops (one Nginx or load balancer
 *                         in front). Without this behind a proxy, every user
 *                         would share the proxy's address and one bucket.
 *   loopback, uniquelocal, 10.0.0.0/8, ...  trust exactly those proxy addresses
 *   true                  REFUSED: it trusts every hop, so any client could
 *                         send X-Forwarded-For and get a fresh rate-limit
 *                         bucket per request.
 */
function trustProxySetting(env = process.env) {
  const raw = String(env.TRUST_PROXY ?? "").trim();
  if (!raw || /^(false|0|no|off)$/i.test(raw)) return false;
  if (/^true$/i.test(raw)) {
    throw new Error(
      "TRUST_PROXY=true would trust any X-Forwarded-For header and let clients bypass IP rate limits. " +
        "Set the number of proxy hops (e.g. TRUST_PROXY=1) or the proxy addresses instead.",
    );
  }
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { trustProxySetting };

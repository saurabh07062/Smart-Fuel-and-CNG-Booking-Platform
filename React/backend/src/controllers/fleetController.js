/**
 * Fleet booking endpoints -- "book fuel for several vehicles at once".
 *
 * Thin, like every other controller here: the rules live in
 * services/booking/fleetPlanner.js (what can be scheduled) and
 * services/booking/fleetBooking.js (writing it down safely). Nothing about
 * identity or ownership is read from the body -- the customer is whoever the
 * session says they are, and every query is scoped to them.
 */

const planner = require("../services/booking/fleetPlanner");
const fleet = require("../services/booking/fleetBooking");

/** Turn a FleetError into its HTTP answer; rethrow anything else. */
function fail(res, err, fallback) {
  if (err?.name === "FleetError") {
    const { status = 400, reason, message } = err;
    return res.status(status).json({
      msg: message,
      reason,
      ...(err.vehiclePlate ? { vehiclePlate: err.vehiclePlate } : {}),
      ...(err.failures ? { failures: err.failures } : {}),
    });
  }
  console.error(`[fleet] ${fallback}:`, err);
  return res.status(500).json({ msg: "Something went wrong. Please try again." });
}

/**
 * POST /api/bookings/fleet/plan
 *
 * "Find best slots": the suggested schedule for these vehicles. Reserves
 * nothing -- see the note at the top of fleetPlanner.js.
 */
exports.plan = async (req, res) => {
  try {
    res.json(await planner.planFleet({ user: req.user, body: req.body || {} }));
  } catch (err) {
    return fail(res, err, "plan failed");
  }
};

/**
 * POST /api/bookings/fleet/plan-vehicle
 *
 * "Edit slot": can THIS vehicle go in THAT window, given the rest of the plan?
 * One vehicle only, so changing one van never reshuffles the others.
 */
exports.planVehicle = async (req, res) => {
  try {
    res.json(await planner.planOneVehicle({ user: req.user, body: req.body || {} }));
  } catch (err) {
    return fail(res, err, "vehicle re-plan failed");
  }
};

/**
 * POST /api/bookings/fleet
 *
 * Confirm: one booking per vehicle, grouped. Every position is allocated
 * again here under the station's lock, so a plan that went stale costs that
 * one vehicle its slot instead of booking the wrong time.
 *
 * 207 when some vehicles were booked and others were not: the bookings that
 * were made are real and are returned, and so is the reason for each miss.
 */
exports.create = async (req, res) => {
  try {
    const result = await fleet.createFleetBooking({ user: req.user, body: req.body || {} });
    res.status(result.failures.length ? 207 : 201).json(result);
  } catch (err) {
    return fail(res, err, "create failed");
  }
};

/** GET /api/bookings/fleet -- the caller's own groups, newest first. */
exports.list = async (req, res) => {
  try {
    res.json(await fleet.listFleetBookings(req.user, { limit: req.query.limit }));
  } catch (err) {
    return fail(res, err, "list failed");
  }
};

/**
 * GET /api/bookings/fleet/:id -- one group with its vehicles, live.
 *
 * 404 rather than 403 for someone else's group: whether a reference exists is
 * not something to confirm to a stranger.
 */
exports.get = async (req, res) => {
  try {
    const group = await fleet.getFleetBooking(req.user, req.params.id);
    if (!group) return res.status(404).json({ msg: "Fleet booking not found." });
    res.json(group);
  } catch (err) {
    return fail(res, err, "read failed");
  }
};

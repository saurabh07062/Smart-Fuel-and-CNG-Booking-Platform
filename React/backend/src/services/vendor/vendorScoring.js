/**
 * Vendor scoring for admin triage.
 *
 * Three small, transparent scores -- deliberately simple arithmetic, not a
 * model, so an admin can always see exactly why a number is what it is:
 *
 *   completenessScore  "is this application actually ready to review?"
 *   priorityScore       "which pending applications should I look at first?"
 *   performanceScore    "which active vendors are actually doing well?"
 *
 * Each is a pure function over data already on the User/Station/booking
 * documents -- nothing here calls the database itself, so these are cheap
 * to run over a list and easy to unit test.
 */

const COMPLETENESS_FIELDS = [
  "businessName",
  "gstNumber",
  "phone",
  "vendorAddress",
  "vendorDescription",
  "logoFile",
  "licenseFile",
  "gstFile",
];

/**
 * How much of a vendor's application is actually filled in, 0-100.
 * The station check counts for a meaningful chunk on its own: a vendor
 * with every text field filled in but no station registered yet isn't
 * actually ready for approval.
 *
 * @param {object} vendor    a User document (or plain object)
 * @param {object[]} stations  that vendor's Station documents, if loaded
 */
function completenessScore(vendor, stations = []) {
  if (!vendor) return 0;

  const fieldsPresent = COMPLETENESS_FIELDS.filter((f) => {
    const v = vendor[f];
    return v !== undefined && v !== null && String(v).trim() !== "";
  }).length;
  const fieldsPct = fieldsPresent / COMPLETENESS_FIELDS.length;

  const station = stations[0];
  const hasStation = Boolean(station);
  const hasLocation = Boolean(
    station && (station.coordinates?.lat || station.location?.coordinates?.length),
  );
  const hasFuelTypes = Boolean(station && station.fuelTypes && station.fuelTypes.length > 0);
  const stationPct = [hasStation, hasLocation, hasFuelTypes].filter(Boolean).length / 3;

  // Text fields are worth 60% of the score, the station setup 40% -- an
  // application can't be "complete" on paperwork alone if there's nothing
  // for a customer to actually book yet.
  const score = fieldsPct * 60 + stationPct * 40;
  return Math.round(score);
}

/**
 * Which pending application should an admin look at first, 0-100.
 * Combines readiness (a complete application is faster to act on) with how
 * long it's been waiting (nobody should sit in the queue forever just
 * because a more complete application keeps jumping ahead of them) --
 * capped at 30 days so a very old, still-incomplete application doesn't
 * dominate the score forever.
 *
 * @param {object} vendor
 * @param {object[]} stations
 * @param {Date|string} now  injectable for tests
 */
function priorityScore(vendor, stations = [], now = new Date()) {
  const completeness = completenessScore(vendor, stations);
  const submitted = vendor?.createdAt ? new Date(vendor.createdAt) : new Date(now);
  const daysWaiting = Math.max(0, (new Date(now) - submitted) / (24 * 60 * 60 * 1000));
  const waitingPct = Math.min(1, daysWaiting / 30);

  const score = completeness * 0.5 + waitingPct * 100 * 0.5;
  return { score: Math.round(score), completeness, daysWaiting: Math.round(daysWaiting * 10) / 10 };
}

/**
 * How well an active vendor is actually doing, 0-100. Revenue alone rewards
 * a vendor who just has more bookings; folding in the completion rate means a
 * vendor who reliably serves the bookings they take scores well even before
 * they're the platform's single biggest earner.
 *
 * Ratings are not part of the score: they are hidden for now, and a missing
 * rating used to count as a "neutral" 4.5 -- a number nobody gave.
 *
 * @param {object} metrics
 * @param {number} metrics.revenue           total completed-booking revenue
 * @param {number} metrics.completedBookings
 * @param {number} metrics.totalBookings     completed + cancelled + no_show, i.e. bookings with a known outcome
 * @param {number} metrics.maxRevenue        highest revenue among the peer set being ranked, for normalising
 */
function performanceScore({ revenue = 0, completedBookings = 0, totalBookings = 0, maxRevenue = 0 }) {
  const revenueComponent = maxRevenue > 0 ? Math.min(1, revenue / maxRevenue) : 0;
  const completionRate = totalBookings > 0 ? completedBookings / totalBookings : null;
  const completionComponent = completionRate === null ? revenueComponent : completionRate; // no outcome data yet: don't penalise a new vendor

  // Revenue carries the most weight since it's the platform's real bottom
  // line, but a vendor with high revenue and a poor completion rate should
  // not simply outrank one who reliably completes fewer, smaller bookings.
  const score = revenueComponent * 65 + completionComponent * 35;
  return {
    score: Math.round(score * 100) / 100,
    revenueComponent: Math.round(revenueComponent * 100) / 100,
    completionRate: completionRate === null ? null : Math.round(completionRate * 100) / 100,
  };
}

module.exports = {
  COMPLETENESS_FIELDS,
  completenessScore,
  priorityScore,
  performanceScore,
};

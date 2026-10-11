/**
 * The end-of-day commission settlement, on a schedule.
 *
 * Once a day, at COMMISSION_SETTLEMENT_TIME in India time, every vendor's
 * pending commission for the business day just ending is gathered into one
 * settlement each (services/commission/commissionService.js settleDay).
 *
 * WHY IT IS NOT `setInterval(24h)`
 *
 * An interval drifts, and it fires 24 hours after the process started rather
 * than at the hour the business agreed. This computes the next occurrence of
 * the configured clock time and sleeps until exactly that, then reschedules --
 * so a restart at 3pm still settles at 23:30, and a server that was down over
 * the settlement minute catches up on its next start (see `catchUp`).
 *
 * SAFE TO RUN TWICE
 *
 * Every path into settlement is idempotent: one Settlement per vendor per day
 * by unique index, and entries are claimed by conditional update. Two servers
 * both waking at 23:30 produce one settlement, not two -- which is the whole
 * reason that index exists.
 */

const commissionService = require("./commissionService");
const commissionConfig = require("../../config/commission");
const { dateKey, atBusinessTime } = require("../../config/businessTime");
const logger = require("../../utils/logger");

const log = logger.child("settlement");

let timer = null;
let running = false;

/** The next moment the configured settlement time comes round, as a Date. */
function nextRunAt(now = new Date()) {
  const { hours, minutes } = commissionConfig.SETTLEMENT_TIME;
  const today = atBusinessTime(dateKey(now), hours, minutes);
  if (today && today.getTime() > now.getTime()) return today;
  // Already past today: tomorrow, in business time.
  const tomorrow = dateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  return atBusinessTime(tomorrow, hours, minutes);
}

/**
 * Settle a day, once, with the outcome logged in words an operator can act on.
 *
 * @param {string} day  the business day to settle; defaults to today's
 */
async function runOnce(day = dateKey()) {
  if (running) {
    log.warn("A settlement run is already in progress; skipping this trigger");
    return null;
  }
  running = true;
  try {
    const result = await commissionService.settleDay({ day });
    if (result.vendors === 0) {
      log.info("Nothing to settle", { day });
    } else {
      log.info("Settlement run finished", result);
      if (result.raised > 0 && commissionConfig.PAYOUT_MODE === "manual") {
        // Said plainly, because it is the difference between money moving and
        // money merely being scheduled to move.
        log.info(
          `${result.raised} settlement(s) are AWAITING CONFIRMATION: no payout rail is configured, ` +
            "so an admin must record the transfer as received before anything is marked settled.",
          { day },
        );
      }
    }
    return result;
  } catch (err) {
    log.error("Settlement run failed", { day, err });
    return null;
  } finally {
    running = false;
  }
}

/**
 * Settle any earlier day still carrying pending commission.
 *
 * Run at start-up: a server that was off at the settlement minute would
 * otherwise leave that day's money uncollected for ever. Today is left alone
 * -- its trading is not finished.
 */
async function catchUp({ now = new Date() } = {}) {
  const CommissionEntry = require("../../models/CommissionEntry");
  const today = dateKey(now);
  const days = (await CommissionEntry.distinct("dateKey", { status: { $in: ["pending", "failed"] } }))
    .filter((d) => d < today)
    .sort();

  if (days.length === 0) return { days: 0 };
  log.info("Settling days missed while the server was down", { days });
  for (const day of days) await runOnce(day);
  return { days: days.length };
}

/** Start the daily schedule. Returns a stop function. */
function startSettlementJob({ now = new Date() } = {}) {
  if (!commissionConfig.SETTLEMENT_ENABLED) {
    log.warn("Settlement is switched off (COMMISSION_SETTLEMENT_ENABLED=false); commission will keep accruing");
    return () => {};
  }

  const schedule = () => {
    const at = nextRunAt();
    const ms = Math.max(1000, at.getTime() - Date.now());
    timer = setTimeout(async () => {
      // The day that is ENDING. At 23:30 that is today; a settlement time in
      // the small hours (02:00) settles the day before, which is the day its
      // trading belongs to.
      const { hours } = commissionConfig.SETTLEMENT_TIME;
      const day = hours < 5 ? dateKey(new Date(Date.now() - 12 * 60 * 60 * 1000)) : dateKey();
      await runOnce(day);
      schedule();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    log.info("Next settlement scheduled", { at: at.toISOString(), time: commissionConfig.SETTLEMENT_TIME.text });
  };

  schedule();
  // Not awaited: start-up must not wait on it, and it logs its own outcome.
  void catchUp({ now }).catch((err) => log.error("Catch-up failed", { err }));

  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

module.exports = { startSettlementJob, runOnce, catchUp, nextRunAt };

/**
 * Booking by money instead of by volume: "₹1000 of petrol".
 *
 * WHY THIS IS ONE FILE
 *
 * Turning rupees into litres is arithmetic, but it is arithmetic that decides
 * what is reserved from a tank, what a customer is charged and what an invoice
 * says. Doing it in two places -- once for a single booking, once for a fleet
 * -- is how the two flows end up disagreeing about what ₹1000 buys. Both call
 * this.
 *
 * WHAT IT NEVER DOES
 *
 * It never trusts a quantity the client worked out. A request says EITHER how
 * much fuel it wants OR how much money to spend; when it is money, the server
 * reads the station's own published price and divides. A client-side figure is
 * a preview, nothing more -- if the price changed while the customer was
 * choosing, the booking uses the new price and says so.
 *
 * THE MONEY IS THE FUEL, NOT THE TOTAL
 *
 * "₹1000 of petrol" buys ₹1000 worth of petrol. The app's convenience fee is
 * added on top, exactly as it is for a quantity booking, and both figures are
 * returned so the customer sees "₹1000 of fuel + ₹5 fee = ₹1005" rather than
 * discovering the difference on the receipt.
 */

const { QUANTITY_MIN, QUANTITY_MAX } = require("../../config/booking");
const { fuelUnit } = require("../../config/fuels");

/**
 * Bounds on the raw rupee figure, before any price is known.
 *
 * Only to keep nonsense out of the arithmetic -- the real limit is the
 * quantity range, which depends on the station's price and is checked in
 * `resolve()` with a message that names actual rupees.
 */
const AMOUNT_MIN = 1;
const AMOUNT_MAX = 1_000_000;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Read "how much" from a request: a quantity, or an amount of money.
 *
 * @param {object} body the request body (single booking) or one vehicle (fleet)
 * @returns {{bookedBy: "quantity"|"amount", quantity: number|null, fuelAmount: number|null}}
 * @throws {{reason: string, message: string}} a plain object the caller turns
 *   into its own error type -- this module is shared by two flows with two
 *   different error classes, and it should not have to know about either.
 */
function readRequest(body = {}) {
  const hasQuantity = body.quantity !== undefined && body.quantity !== null && body.quantity !== "";
  const hasAmount = body.fuelAmount !== undefined && body.fuelAmount !== null && body.fuelAmount !== "";

  if (hasQuantity && hasAmount) {
    // Both would mean two different answers to the same question, and picking
    // one silently is how a customer ends up with fuel they did not ask for.
    throw {
      reason: "AMBIGUOUS_QUANTITY",
      message: "Choose either a quantity or an amount, not both.",
    };
  }
  if (!hasQuantity && !hasAmount) {
    throw { reason: "QUANTITY_REQUIRED", message: "Say how much fuel you want, or how much you want to spend." };
  }

  if (hasAmount) {
    const fuelAmount = Number(body.fuelAmount);
    if (!Number.isFinite(fuelAmount) || fuelAmount < AMOUNT_MIN || fuelAmount > AMOUNT_MAX) {
      throw {
        reason: "INVALID_AMOUNT",
        message: `Enter an amount between ₹${AMOUNT_MIN} and ₹${AMOUNT_MAX}.`,
      };
    }
    return { bookedBy: "amount", quantity: null, fuelAmount: round2(fuelAmount) };
  }

  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity < QUANTITY_MIN || quantity > QUANTITY_MAX) {
    throw {
      reason: "INVALID_QUANTITY",
      message: `Quantity must be between ${QUANTITY_MIN} and ${QUANTITY_MAX}.`,
    };
  }
  return { bookedBy: "quantity", quantity, fuelAmount: null };
}

/** What ₹ range this price allows, given the quantity limits. */
function amountRangeFor(unitPrice) {
  return {
    min: Math.ceil(unitPrice * QUANTITY_MIN),
    max: Math.floor(unitPrice * QUANTITY_MAX),
  };
}

/**
 * The quantity this request comes to at this station's price.
 *
 * For a quantity request it is what was asked for, unchanged -- the existing
 * flow passes straight through. For an amount request it is the division,
 * rounded to two decimals (the resolution a pump dispenses to and an invoice
 * prints), and then checked against the same quantity limits every booking is
 * held to, with the limits restated in rupees because that is what the
 * customer typed.
 *
 * @param {object} args
 * @param {number} args.unitPrice the station's published price, already validated
 * @param {string} args.fuel      a fuel key, for the unit in messages
 * @param {object} args.request   the result of readRequest()
 * @returns {{quantity: number, bookedBy: string, requestedAmount: number|null, fuelValue: number}}
 * @throws {{reason, message}} when the money buys too little or too much fuel
 */
function resolve({ unitPrice, fuel, request }) {
  const price = Number(unitPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw { reason: "PRICE_UNAVAILABLE", message: "This station has not published a price for that fuel." };
  }

  if (request.bookedBy === "quantity") {
    return {
      quantity: request.quantity,
      bookedBy: "quantity",
      requestedAmount: null,
      fuelValue: round2(price * request.quantity),
    };
  }

  const quantity = round2(request.fuelAmount / price);
  const unit = fuelUnit(fuel) || "L";
  const range = amountRangeFor(price);

  if (quantity < QUANTITY_MIN) {
    throw {
      reason: "AMOUNT_TOO_SMALL",
      message: `₹${request.fuelAmount} buys only ${quantity} ${unit} at ₹${price}/${unit}. The smallest booking is ${QUANTITY_MIN} ${unit} — about ₹${range.min}.`,
    };
  }
  if (quantity > QUANTITY_MAX) {
    throw {
      reason: "AMOUNT_TOO_LARGE",
      message: `₹${request.fuelAmount} comes to ${quantity} ${unit}, more than the ${QUANTITY_MAX} ${unit} limit — at most about ₹${range.max}.`,
    };
  }

  return {
    quantity,
    bookedBy: "amount",
    requestedAmount: request.fuelAmount,
    // What that rounded quantity is actually worth. A paisa or two from the
    // figure typed, and the customer is shown this rather than their own.
    fuelValue: round2(price * quantity),
  };
}

/** readRequest + resolve, for callers that have the price to hand. */
function quantityFor(body, { unitPrice, fuel }) {
  return resolve({ unitPrice, fuel, request: readRequest(body) });
}

module.exports = { AMOUNT_MIN, AMOUNT_MAX, readRequest, resolve, quantityFor, amountRangeFor, round2 };

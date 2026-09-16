/**
 * Which ways a customer can pay.
 *
 * FuelMart currently takes payment at the petrol pump only: the customer books
 * a slot and pays the attendant (cash or UPI) at check-in. Online payment
 * (Razorpay) stays switched off until ONLINE_PAYMENTS_ENABLED is set to true --
 * and it should only be set once real Razorpay keys are configured.
 *
 * While it is off:
 *   - a booking asking to pay online is refused before anything is reserved
 *     (services/booking/bookingCreate.js), so no booking waits for a payment
 *     that cannot happen
 *   - POST /api/razorpay/create-order is refused and GET /api/razorpay/status
 *     reports online payment as off (controllers/paymentController.js)
 *
 * Read on every call, so a test can switch it for one case.
 */

function onlinePaymentsEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ONLINE_PAYMENTS_ENABLED || "").trim());
}

const ONLINE_PAYMENT_DISABLED_MSG =
  "Online payment is not available. Please choose to pay at the petrol pump.";

module.exports = { onlinePaymentsEnabled, ONLINE_PAYMENT_DISABLED_MSG };

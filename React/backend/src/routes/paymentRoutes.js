const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const auth = require("../middleware/auth");

// Config health — deliberately public so the frontend can hide or disable the
// online-payment option when Razorpay is not set up, rather than letting a
// customer reach Checkout and fail there.
router.get("/status", paymentController.status);
router.get("/get-key", paymentController.getKey);

// Creating an order and settling it both act on a specific user's booking, so
// both require a session. These were previously unauthenticated, which let
// anyone mint Razorpay orders against the merchant account.
router.post("/create-order", auth, paymentController.createOrder);
router.post("/verify-payment", auth, paymentController.verifyPayment);

module.exports = router;

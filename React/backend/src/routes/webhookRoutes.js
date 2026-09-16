const express = require("express");
const router = express.Router();
const webhookController = require("../controllers/webhookController");

// Signature verification needs the exact bytes Razorpay signed, so this body
// is read raw (a Buffer), whatever the Content-Type. src/app.js mounts this
// router BEFORE express.json(), which would otherwise consume the stream.
// No session auth: the HMAC signature is the authentication.
router.post("/razorpay", express.raw({ type: () => true, limit: "1mb" }), webhookController.razorpayWebhook);

module.exports = router;

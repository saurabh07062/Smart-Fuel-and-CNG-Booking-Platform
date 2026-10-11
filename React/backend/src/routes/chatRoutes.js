/**
 * /api/chat -- the assistant and the support conversations.
 *
 * Every route here is authenticated. There is no public chat endpoint: the
 * whole feature is about a signed-in person's own bookings, stations and
 * threads, and an anonymous caller has none. The role checks are inside the
 * services (services/chat/access.js) rather than on the routes, because the
 * same endpoint serves a customer, a vendor and an admin with different
 * visibility -- a route-level role gate would have to be three routes that
 * then share one authorization rule anyway.
 */

const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const chatController = require("../controllers/chatController");
const { rateLimit } = require("../services/security/rateLimiter");

/**
 * Sending is limited per account, not per IP.
 *
 * A support chat is a write endpoint that anyone signed in can reach, so it is
 * the obvious place to flood. 30 a minute is far more than a person types and
 * far less than a script sends.
 */
const sendLimiter = rateLimit({
  limit: Number(process.env.CHAT_MESSAGES_PER_MINUTE) || 30,
  windowMs: 60_000,
  keyPrefix: "chat-send",
  keyFn: (req) => req.user?.id || req.ip,
});

/** Opening a thread is rarer still, and creates a row. */
const openLimiter = rateLimit({
  limit: Number(process.env.CHAT_THREADS_PER_HOUR) || 20,
  windowMs: 60 * 60_000,
  keyPrefix: "chat-open",
  keyFn: (req) => req.user?.id || req.ip,
});

/** The assistant answers from stored data; a question is cheap but not free. */
const askLimiter = rateLimit({
  limit: Number(process.env.CHAT_QUESTIONS_PER_MINUTE) || 60,
  windowMs: 60_000,
  keyPrefix: "chat-ask",
  keyFn: (req) => req.user?.id || req.ip,
});

// ── the assistant ──────────────────────────────────────────────────────────
router.get("/context", auth, chatController.context);
router.post("/ask", auth, askLimiter, chatController.ask);

// ── conversations ──────────────────────────────────────────────────────────
router.get("/conversations", auth, chatController.listConversations);
router.get("/unread", auth, chatController.unread);
router.post("/conversations", auth, openLimiter, chatController.openConversation);
router.get("/conversations/:id", auth, chatController.getConversation);
router.post("/conversations/:id/messages", auth, sendLimiter, chatController.sendMessage);
router.post("/conversations/:id/read", auth, chatController.markRead);
// Only the admin team moves a thread through its lifecycle. Checked here AND
// in the service, so a future caller cannot reach it another way.
router.patch("/conversations/:id/status", auth, requireRole("admin"), chatController.setStatus);

module.exports = router;

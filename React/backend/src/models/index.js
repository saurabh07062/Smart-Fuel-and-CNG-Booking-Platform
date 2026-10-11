/**
 * Every model in one place, and the map of how they relate.
 *
 * Nothing is forced to import from here -- the rest of the app still requires
 * models directly, and should keep doing so. This exists for the jobs that
 * need to know the whole set: building indexes at boot
 * (services/core/schemaIndexes.js) and auditing the data
 * (scripts/schemaAudit.js). Adding a model means adding one line here, and
 * both of those pick it up.
 */

const models = {
  User: require("./User"),
  Station: require("./Station"),
  Booking: require("./Booking"),
  BookingAttempt: require("./BookingAttempt"),
  WalkIn: require("./WalkIn"),
  FleetBooking: require("./FleetBooking"),
  Employee: require("./Employee"),
  Conversation: require("./Conversation"),
  Message: require("./Message"),
  Invoice: require("./Invoice"),
  RewardLedger: require("./RewardLedger"),
  CommissionEntry: require("./CommissionEntry"),
  Settlement: require("./Settlement"),
  Counter: require("./Counter"),
  InventoryMovement: require("./InventoryMovement"),
  PriceHistory: require("./PriceHistory"),
  Notification: require("./Notification"),
  RefreshToken: require("./RefreshToken"),
  SecurityEvent: require("./SecurityEvent"),
  WebhookEvent: require("./WebhookEvent"),
};

/**
 * Which fields point at which collection, and whether a missing target is a
 * broken record or simply absent.
 *
 * MongoDB does not enforce foreign keys, so "referential integrity" here means
 * two things that ARE enforceable: every reference is declared in one place,
 * and scripts/schemaAudit.js can prove from the data whether any of them
 * dangle. `required: true` means the field must hold a live document -- a row
 * whose target is gone is an orphan and is reported.
 */
const RELATIONS = [
  { model: "Station", path: "owner", ref: "User", required: false }, // OSM-imported pumps have no vendor
  { model: "Booking", path: "user", ref: "User", required: true },
  { model: "Booking", path: "fleetGroup", ref: "FleetBooking", required: false }, // only a member of a group has one
  { model: "FleetBooking", path: "user", ref: "User", required: true },
  { model: "FleetBooking", path: "station", ref: "Station", required: true },
  { model: "FleetBooking", path: "createdBy", ref: "User", required: true },
  { model: "Booking", path: "station", ref: "Station", required: false }, // pre-dates separate stations
  { model: "Booking", path: "collectedBy", ref: "User", required: false },
  { model: "WalkIn", path: "station", ref: "Station", required: true },
  { model: "WalkIn", path: "createdBy", ref: "User", required: false },
  { model: "Employee", path: "vendor", ref: "User", required: true },
  { model: "Employee", path: "station", ref: "Station", required: false },
  { model: "Invoice", path: "booking", ref: "Booking", required: true },
  { model: "Invoice", path: "station", ref: "Station", required: true },
  { model: "Invoice", path: "user", ref: "User", required: true },
  { model: "CommissionEntry", path: "booking", ref: "Booking", required: true },
  { model: "CommissionEntry", path: "station", ref: "Station", required: true },
  { model: "CommissionEntry", path: "vendor", ref: "User", required: true },
  { model: "CommissionEntry", path: "settlement", ref: "Settlement", required: false }, // null until one collects it
  { model: "Settlement", path: "vendor", ref: "User", required: true },
  { model: "Settlement", path: "confirmedBy", ref: "User", required: false },
  { model: "RewardLedger", path: "user", ref: "User", required: true },
  { model: "RewardLedger", path: "booking", ref: "Booking", required: false }, // a welcome credit or an adjustment has none
  { model: "RewardLedger", path: "fleetGroup", ref: "FleetBooking", required: false },
  { model: "RewardLedger", path: "actor", ref: "User", required: false },
  { model: "InventoryMovement", path: "station", ref: "Station", required: true },
  { model: "InventoryMovement", path: "booking", ref: "Booking", required: false },
  { model: "InventoryMovement", path: "recordedBy", ref: "User", required: false },
  { model: "PriceHistory", path: "station", ref: "Station", required: true },
  { model: "PriceHistory", path: "changedBy", ref: "User", required: false },
  // Support threads. The customer/vendor sides are required for the kinds that
  // have them (models/Conversation.js enforces which), so a missing target here
  // is a thread whose other side was deleted.
  { model: "Conversation", path: "customer", ref: "User", required: false },
  { model: "Conversation", path: "vendor", ref: "User", required: false },
  { model: "Conversation", path: "station", ref: "Station", required: false },
  { model: "Conversation", path: "booking", ref: "Booking", required: false },
  { model: "Conversation", path: "assignedAdmin", ref: "User", required: false },
  { model: "Conversation", path: "createdBy", ref: "User", required: true },
  { model: "Message", path: "conversation", ref: "Conversation", required: true },
  { model: "Message", path: "sender", ref: "User", required: true },
  { model: "Notification", path: "user", ref: "User", required: true },
  { model: "Notification", path: "booking", ref: "Booking", required: false },
  { model: "Notification", path: "station", ref: "Station", required: false },
  { model: "RefreshToken", path: "user", ref: "User", required: true },
  { model: "RefreshToken", path: "replacedBy", ref: "RefreshToken", required: false }, // the rotation that replaced it; swept away on expiry
  { model: "WebhookEvent", path: "booking", ref: "Booking", required: false },
  { model: "BookingAttempt", path: "user", ref: "User", required: true },
  { model: "BookingAttempt", path: "station", ref: "Station", required: false },
  { model: "SecurityEvent", path: "user", ref: "User", required: false },
  { model: "SecurityEvent", path: "station", ref: "Station", required: false },
];

module.exports = { ...models, models, RELATIONS };

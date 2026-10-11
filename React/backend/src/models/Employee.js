const mongoose = require("mongoose");
const { phoneValidator } = require("./shared/fieldValidators");
const { isValidEmail } = require("../services/notification/emailValidation");

/**
 * One person working at a vendor's station.
 *
 * Always owned by a vendor (`vendor`), optionally posted to one of that
 * vendor's stations. Every read in the vendor panel is filtered by `vendor`,
 * which is what keeps one vendor's staff out of another's panel.
 */
const EmployeeSchema = new mongoose.Schema({
  vendor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  station: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Station",
    default: null,
  },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  // Optional, but a stored address is a real one -- the same rule the rest of
  // the app uses (services/notification/emailValidation.js).
  email: {
    type: String,
    trim: true,
    lowercase: true,
    maxlength: 254,
    default: null,
    validate: {
      validator: (v) => !v || isValidEmail(v),
      message: (p) => `"${p.value}" is not a valid email address`,
    },
  },
  phone: { type: String, required: true, trim: true, validate: phoneValidator("phone") },
  role: {
    type: String,
    enum: ["Manager", "Attendant", "Cashier", "Cleaner", "Security"],
    default: "Attendant",
  },
  shift: {
    type: String,
    enum: ["Morning", "Evening", "Night", "Full-Time"],
    default: "Full-Time",
  },
  salary: { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    enum: ["Active", "Inactive", "On Leave"],
    default: "Active",
  },
  /**
   * A photo of the person, so the vendor's staff list shows faces rather than
   * initials — the same thing a customer's profile photo does
   * (models/User.js profileImage), stored the same way: a path under
   * /uploads written by middleware/upload.js, never the image itself.
   *
   * Optional, and null is a perfectly good answer: the list falls back to the
   * initial-letter avatar it already draws.
   */
  photo: { type: String, default: null },
  joinedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// The vendor panel's staff list: my people, newest first, filtered by status.
EmployeeSchema.index({ vendor: 1, status: 1, createdAt: -1 });
// "Who works at this station" (the admin station overview and the rota).
EmployeeSchema.index({ station: 1, status: 1 });

/**
 * One person per phone number within a vendor's own staff.
 *
 * Scoped to the vendor, not global: the same number may legitimately appear
 * under two different vendors (a shared family number), but adding the same
 * attendant twice to one vendor is a duplicate record, and this is what makes
 * it impossible rather than merely unlikely.
 */
EmployeeSchema.index(
  { vendor: 1, phone: 1 },
  {
    name: "uniq_employee_phone_per_vendor",
    unique: true,
    // Both fields must be present for the rule to mean anything: a row with no
    // vendor is not "this vendor's staff", and two such rows sharing a number
    // are not duplicates of each other. (Rows like that exist only as old or
    // imported data -- `vendor` is required for anything the app writes.)
    partialFilterExpression: { vendor: { $type: "objectId" }, phone: { $type: "string" } },
  },
);

module.exports = mongoose.model("Employee", EmployeeSchema);